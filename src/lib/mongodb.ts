import mongoose from "mongoose";

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
  uri: string | null;
  /** Per-migration completion flags. Each migration only runs until it
   * succeeds — a transient failure (network blip, MongoDB busy) won't
   * permanently mark the migration done, so the next request will retry
   * instead of leaving the install stuck on stale data/index state. */
  migrations: {
    instanceIds: boolean;
    sharedCatalogIndexes: boolean;
    /** GH #232 — split nozzles that are referenced by >1 printer into
     * one physical instance per printer. Idempotent: on a clean DB the
     * pass finds no duplicates and the flag is set on first connect. */
    nozzlePhysicalInstances: boolean;
  };
}

declare global {
  var mongoose: MongooseCache | undefined;
}

export default async function dbConnect() {
  const MONGODB_URI = process.env.MONGODB_URI;

  if (!MONGODB_URI) {
    throw new Error(
      "Please define the MONGODB_URI environment variable in .env.local"
    );
  }

  const cached: MongooseCache = global.mongoose ?? {
    conn: null,
    promise: null,
    uri: null,
    migrations: { instanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false },
  };

  if (!global.mongoose) {
    global.mongoose = cached;
  }

  // If URI changed (e.g., switched from local to Atlas), reconnect — and
  // re-run migrations against the new database.
  if (cached.conn && cached.uri !== MONGODB_URI) {
    await mongoose.disconnect();
    cached.conn = null;
    cached.promise = null;
    cached.uri = null;
    cached.migrations = { instanceIds: false, sharedCatalogIndexes: false, nozzlePhysicalInstances: false };
  }

  // Short-circuit only when both the connection AND all migrations are
  // settled. Without checking migrations, a transient failure on first
  // connect would never get retried — the next call would hit this
  // early return and skip the migration block entirely.
  if (
    cached.conn &&
    cached.migrations.instanceIds &&
    cached.migrations.sharedCatalogIndexes &&
    cached.migrations.nozzlePhysicalInstances
  ) {
    return cached.conn;
  }

  if (!cached.conn) {
    if (!cached.promise) {
      cached.uri = MONGODB_URI;
      cached.promise = mongoose.connect(MONGODB_URI).catch((err) => {
        cached.promise = null;
        throw err;
      });
    }
    cached.conn = await cached.promise;
  }

  // One-time migrations on first connect after process start. Each
  // migration tracks its own success flag — a transient failure on one
  // doesn't poison the cache for the rest, and the next request retries
  // any that didn't complete instead of skipping the whole block.
  if (!cached.migrations.instanceIds) {
    try {
      const { backfillInstanceIds } = await import("@/models/Filament");
      const count = await backfillInstanceIds();
      if (count > 0) {
        console.log(`[migration] Backfilled instanceId for ${count} filament(s)`);
      }
      cached.migrations.instanceIds = true;
    } catch (err) {
      console.error("[migration] Failed to backfill instanceIds (will retry on next connect):", err);
    }
  }

  // SharedCatalog's slug index changed from a plain unique index to
  // a partial-unique-on-_deletedAt-null index when soft-delete landed.
  // MongoDB won't mutate existing index options in-place, so on
  // existing installs the old `slug_1` index keeps enforcing global
  // uniqueness (including over tombstoned rows). syncIndexes() drops
  // indexes that don't match the current schema and recreates them
  // with the new options — idempotent on fresh databases (the indexes
  // already match), corrective on upgraded ones.
  if (!cached.migrations.sharedCatalogIndexes) {
    try {
      const SharedCatalog = (await import("@/models/SharedCatalog")).default;
      const dropped = await SharedCatalog.syncIndexes();
      if (dropped.length > 0) {
        console.log(`[migration] Rebuilt SharedCatalog indexes (dropped: ${dropped.join(", ")})`);
      }
      cached.migrations.sharedCatalogIndexes = true;
    } catch (err) {
      console.error("[migration] Failed to sync SharedCatalog indexes (will retry on next connect):", err);
    }
  }

  // GH #232 — split nozzles referenced by >1 printer into one physical
  // instance per printer. The pre-#232 UI let users check the same
  // nozzle on multiple printer forms, treating a Nozzle row as a "spec"
  // when the field name (`installedNozzles`) actually means "physical
  // object currently in this printer." We now enforce one-printer-per-
  // nozzle at the API layer; this migration cleans up upgraded installs
  // that already accumulated duplicates so the new constraint doesn't
  // refuse every subsequent edit.
  //
  // Strategy:
  //   1. Walk all active printers, build a map of nozzleId → printers[]
  //      that reference it.
  //   2. For any nozzle referenced by more than one printer, keep the
  //      FIRST printer's reference unchanged (preserves URLs and any
  //      existing calibration history that points at the nozzle id),
  //      and clone the nozzle into a fresh row for every other printer.
  //   3. Each clone gets a "Name #N" suffix so the user can see the
  //      split happened. Existing peer suffixes are scanned so we don't
  //      collide ("Name #2" already exists → use #3).
  //
  // Idempotent on a clean DB (no duplicates → no writes); resumable on
  // partial failure (the flag isn't set until the pass completes).
  if (!cached.migrations.nozzlePhysicalInstances) {
    try {
      const Printer = (await import("@/models/Printer")).default;
      const Nozzle = (await import("@/models/Nozzle")).default;
      const { nextCloneName } = await import("@/lib/nozzleConflicts");

      const printers = await Printer.find({ _deletedAt: null })
        .select("_id name installedNozzles")
        .lean();

      // nozzleId → [{printerId, printerName}]
      const refCount = new Map<
        string,
        { printerId: string; printerName: string }[]
      >();
      for (const p of printers) {
        for (const nid of p.installedNozzles || []) {
          const key = String(nid);
          const list = refCount.get(key) ?? [];
          list.push({ printerId: String(p._id), printerName: p.name });
          refCount.set(key, list);
        }
      }

      let clonesCreated = 0;
      for (const [nozzleId, refs] of refCount.entries()) {
        if (refs.length <= 1) continue;
        // Hydrate the source nozzle once.
        const source = await Nozzle.findOne({
          _id: nozzleId,
          _deletedAt: null,
        }).lean();
        if (!source) continue; // soft-deleted between count and read; skip

        // Existing peer names (for "Name #N" collision avoidance).
        const peers = (await Nozzle.find({
          _deletedAt: null,
          name: { $regex: `^${escapeForRegex(source.name)}` },
        })
          .select("name")
          .lean()) as { name: string }[];
        const peerNames = peers.map((p) => p.name);

        // First printer keeps the original ref. For every other
        // printer, mint a clone and swap the reference.
        for (let i = 1; i < refs.length; i++) {
          const printerId = refs[i].printerId;
          const newName = nextCloneName(source.name, peerNames);
          peerNames.push(newName); // reserve the slot for the next iteration
          const clone = await Nozzle.create({
            name: newName,
            diameter: source.diameter,
            type: source.type,
            highFlow: source.highFlow,
            hardened: source.hardened,
            notes: source.notes,
          });
          // Swap the reference on the printer: remove the original
          // nozzleId, add the clone's id. Done in two ops to keep this
          // straightforward — bulkWrite would be marginally faster but
          // the duplicate count is tiny (a handful at most).
          await Printer.updateOne(
            { _id: printerId },
            { $pull: { installedNozzles: source._id } },
          );
          await Printer.updateOne(
            { _id: printerId },
            { $addToSet: { installedNozzles: clone._id } },
          );
          clonesCreated++;
        }
      }

      if (clonesCreated > 0) {
        console.log(
          `[migration] Split duplicated nozzles across printers — created ${clonesCreated} clone(s)`,
        );
      }
      cached.migrations.nozzlePhysicalInstances = true;
    } catch (err) {
      console.error(
        "[migration] Failed to split duplicated nozzles (will retry on next connect):",
        err,
      );
    }
  }

  return cached.conn;
}

/** Escape a string for inclusion in a Mongo `$regex` filter. */
function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
