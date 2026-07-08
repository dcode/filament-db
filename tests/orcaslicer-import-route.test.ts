import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { resolveFilament } from "@/lib/resolveFilament";

/**
 * Route-level tests for the bulk OrcaSlicer library importer
 * (`POST /api/filaments/orcaslicer`). The pure inherits-resolution planning
 * is covered DB-free in tests/orcaSlicerImport.test.ts; here we pin what
 * actually lands in Mongo: parent/variant linking, diff-only variant docs
 * that still RESOLVE to full values, the name-collision decision tree, the
 * three-phase upsert integration (resurrect + E11000 race), calibration
 * aggregation, and the request guards.
 *
 * Schema re-registration in beforeEach is the same pattern as the other
 * route-level tests (tests/setup.ts wipes mongoose.models between tests).
 */
describe("POST /api/filaments/orcaslicer (bulk library import)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Printer: any;
  let Nozzle: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const prtMod = await import("@/models/Printer");
    const nozMod = await import("@/models/Nozzle");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", prtMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    Filament = mongoose.models.Filament;
    Printer = mongoose.models.Printer;
    Nozzle = mongoose.models.Nozzle;
  });

  const URL_ = "http://localhost/api/filaments/orcaslicer";

  function jsonReq(body: unknown, headers: Record<string, string> = {}) {
    return new NextRequest(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  // Fixture shape mirrors real OrcaFilamentLibrary files: an abstract
  // template, a concrete generic, a vendor leaf.
  const TEMPLATE = {
    type: "filament",
    name: "fdm_filament_pla",
    from: "system",
    instantiation: "false",
    filament_type: ["PLA"],
    filament_density: ["1.24"],
    filament_diameter: ["1.75"],
    nozzle_temperature: ["220"],
    hot_plate_temp: ["60"],
  };
  const GENERIC = {
    type: "filament",
    name: "Generic PLA @System",
    from: "system",
    instantiation: "true",
    inherits: "fdm_filament_pla",
    filament_vendor: ["Generic"],
    filament_colour: ["#FFFFFF"],
    filament_cost: ["20"],
  };
  const VENDOR = {
    type: "filament",
    name: "Polymaker PolyLite PLA @System",
    from: "system",
    instantiation: "true",
    inherits: "Generic PLA @System",
    filament_vendor: ["Polymaker"],
    filament_colour: ["#FF0000"],
    filament_density: ["1.17"],
  };
  const ALL = [TEMPLATE, GENERIC, VENDOR];

  async function post(body: unknown, headers: Record<string, string> = {}) {
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");
    return POST(jsonReq(body, headers));
  }

  it("creates the root concrete ancestor + a linked variant carrying only diffs", async () => {
    const res = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(2);
    expect(body.updated).toBe(0);
    expect(body.variants).toBe(1);
    expect(body.filaments).toEqual([GENERIC.name, VENDOR.name]);
    expect(body.errors).toBeUndefined();

    // Root: flattened with the abstract template baked in.
    const parent = await Filament.findOne({ name: GENERIC.name });
    expect(parent).toBeTruthy();
    expect(parent.parentId).toBeNull();
    expect(parent.type).toBe("PLA");
    expect(parent.vendor).toBe("Generic");
    expect(parent.density).toBe(1.24);
    expect(parent.cost).toBe(20);
    expect(parent.temperatures.nozzle).toBe(220);
    expect(parent.temperatures.bed).toBe(60);

    // Variant: linked, carries its own diffs…
    const variant = await Filament.findOne({ name: VENDOR.name });
    expect(String(variant.parentId)).toBe(String(parent._id));
    expect(variant.density).toBe(1.17);
    expect(variant.color).toBe("#FF0000");
    // …but does NOT pin parent-equal fields (inherits dynamically)…
    expect(variant.cost).toBeNull();
    expect(variant.temperatures.nozzle).toBeNull();
    // …and resolveFilament fills them from the parent.
    const resolved = resolveFilament(variant.toObject(), parent.toObject());
    expect(resolved.cost).toBe(20);
    expect(resolved.temperatures.nozzle).toBe(220);
    expect(resolved.density).toBe(1.17);
  });

  it("pins the variant's diameter instead of letting the 1.75 schema default mis-pin it (PR #985)", async () => {
    // 2.85 mm chain: parent and child share the diameter, so the diff
    // would drop the key without the DIFF_ALWAYS_KEEP entry — and the
    // Filament schema's `default: 1.75` would pin the WRONG diameter on
    // the created variant doc (Codex P2 on PR #985).
    const template285 = {
      ...TEMPLATE,
      name: "fdm_filament_pla_285",
      filament_diameter: ["2.85"],
    };
    const generic285 = {
      ...GENERIC,
      name: "Generic PLA 2.85 @System",
      inherits: template285.name,
    };
    const vendor285 = {
      ...VENDOR,
      name: "Polymaker PolyLite PLA 2.85 @System",
      inherits: generic285.name,
    };
    const res = await post({
      selected: [vendor285.name],
      profiles: [template285, generic285, vendor285],
    });
    expect(res.status).toBe(200);
    const variant = await Filament.findOne({ name: vendor285.name });
    expect(variant.diameter).toBe(2.85);
  });

  it("re-imports idempotently (updated, no duplicates, inheritance stays live)", async () => {
    const first = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(first.status).toBe(200);
    const res = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.updated).toBe(2);
    expect(body.variants).toBe(1);
    expect(body.errors).toBeUndefined();

    expect(await Filament.countDocuments({ name: GENERIC.name })).toBe(1);
    expect(await Filament.countDocuments({ name: VENDOR.name })).toBe(1);
    const variant = await Filament.findOne({ name: VENDOR.name });
    expect(variant.cost).toBeNull(); // still inheriting, not pinned
  });

  it("links the fallback create to the parent when the row is purged between the advisory check and the atomic write (P3 review round 4)", async () => {
    // First import creates the linked parent + variant normally.
    const first = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(first.status).toBe(200);
    const parent = await Filament.findOne({ name: GENERIC.name });
    const existingVariant = await Filament.findOne({ name: VENDOR.name });
    expect(existingVariant).toBeTruthy();
    expect(String(existingVariant.parentId)).toBe(String(parent._id));

    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");

    const realFindOneAndUpdate = Filament.findOneAndUpdate.bind(Filament);
    const spy = vi
      .spyOn(Filament, "findOneAndUpdate")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (filter: any, ...rest: any[]) => {
        if (filter && String(filter._id) === String(existingVariant._id)) {
          // Simulate a concurrent soft-delete + purge landing between the
          // route's advisory findCollision() (already run by the time we
          // get here) and this atomic write: the row genuinely vanishes
          // from both the active AND the resurrectable-trashed views, so
          // this phase-1 write misses (filter's `_deletedAt: null` no
          // longer matches) and phase 2's own findOne (a real, unmocked
          // call) won't find it either since it's now `_purged: true`.
          await Filament.updateOne(
            { _id: existingVariant._id },
            { $set: { _deletedAt: new Date(), _purged: true } },
          );
          return null;
        }
        return realFindOneAndUpdate(filter, ...rest);
      });

    try {
      const res = await POST(jsonReq({ selected: [VENDOR.name], profiles: ALL }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.errors).toBeUndefined();

      // Phase 1 + phase 2 both missed → phase 3 created a NEW row. It must
      // link to the parent, not land as an orphaned, diff-only root missing
      // every inherited field (the bug: createParentId stayed null on this
      // branch pre-fix).
      const created = await Filament.findOne({
        name: VENDOR.name,
        _id: { $ne: existingVariant._id },
      });
      expect(created).toBeTruthy();
      expect(String(created.parentId)).toBe(String(parent._id));
      const resolved = resolveFilament(created.toObject(), parent.toObject());
      expect(resolved.temperatures.nozzle).toBe(220);
    } finally {
      spy.mockRestore();
    }
  });

  it("fails the write closed (never lands, never cascades) when a race turns a planned root into a variant of another filament", async () => {
    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");

    const otherParent = await Filament.create({
      name: "Unrelated Root",
      vendor: "Someone Else",
      type: "PLA",
      diameter: 1.75,
    });

    // Captured BEFORE spying so the injected race and the "let it through"
    // branches always call the true original — never the spy — avoiding
    // any ordering interaction with the separate `create` spy below.
    const realFindOne = Filament.findOne.bind(Filament);
    const realCreate = Filament.create.bind(Filament);

    // Route-level findCollision() for the planned root (GENERIC.name) is
    // {name, _deletedAt:null} chained with .select().lean() — the FIRST
    // occurrence of that exact filter shape. upsertParsedBambuFilament's
    // own phase-1 read is the bare, unchained SECOND occurrence. Keying on
    // occurrence count (not call order) is robust regardless of how many
    // OTHER findOne calls (for other entries) interleave.
    let genericActiveCalls = 0;
    const findOneSpy = vi
      .spyOn(Filament, "findOne")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((filter: any, ...rest: any[]) => {
        if (filter && filter.name === GENERIC.name && filter._deletedAt === null) {
          genericActiveCalls++;
          if (genericActiveCalls === 2) {
            // This is upsertParsedBambuFilament's phase-1 read. Inject a
            // concurrent import creating GENERIC.name as a VARIANT of an
            // unrelated parent right before it resolves — landing in the
            // TOCTOU window between the route's advisory check (already
            // run, saw nothing) and this read. Uses realCreate so it can
            // never be caught by the separate create-spy below.
            return (async () => {
              await realCreate({
                name: GENERIC.name,
                vendor: "Racing Variant Creator",
                type: "PLA",
                diameter: 1.75,
                parentId: otherParent._id,
              });
              return realFindOne(filter, ...rest);
            })();
          }
        }
        return realFindOne(filter, ...rest);
      });
    // Phase 1 now misses (expectedParentId: null doesn't match the
    // racer's non-null parentId), phase 2 has nothing trashed, so phase 3
    // attempts a real create — which WOULD collide with the racer's
    // GENERIC.name via the partial-unique-on-name index, but that index
    // builds asynchronously and can lag under a loaded test run (same
    // flakiness the existing bambuUpsert.test.ts race tests avoid by
    // forcing the E11000 explicitly). Force it here too so the
    // race-recovery path — where the round-2 expectedParentId check now
    // also lives — runs deterministically. The racing creation above
    // bypasses this spy entirely (uses realCreate), so the only call this
    // spy actually observes is phase 3's genuine attempt.
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const createSpy = vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      throw e11000;
    });

    try {
      const res = await POST(jsonReq({ selected: [VENDOR.name], profiles: ALL }));
      const body = await res.json();
      expect(res.status).toBe(200);

      // The root entry's write must fail closed BEFORE landing:
      // expectedParentId: null on the root branch rejects it at the
      // race-recovery merge — registering it as a parent would create a
      // variant-of-a-variant for VENDOR.
      expect(body.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`"${GENERIC.name}": Collision`),
          expect.stringContaining(`"${VENDOR.name}": parent "${GENERIC.name}" failed to import`),
        ]),
      );

      // No variant-of-a-variant was created: VENDOR.name was never written.
      expect(await Filament.countDocuments({ name: VENDOR.name })).toBe(0);
      // The racing document was never touched by the failed write — its
      // parentId AND its content (vendor) are exactly as the race left
      // them, proving the write failed BEFORE landing, not after.
      const racer = await Filament.findOne({ name: GENERIC.name });
      expect(String(racer.parentId)).toBe(String(otherParent._id));
      expect(racer.vendor).toBe("Racing Variant Creator");
    } finally {
      findOneSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("fails closed instead of applying a wrong-baseline diff when a race re-parents the variant mid-write", async () => {
    const first = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(first.status).toBe(200);
    const parent = await Filament.findOne({ name: GENERIC.name });
    const existingVariant = await Filament.findOne({ name: VENDOR.name });
    expect(String(existingVariant.parentId)).toBe(String(parent._id));
    const originalDensity = existingVariant.density;

    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");

    const otherParent = await Filament.create({
      name: "Unrelated Root 2",
      vendor: "Someone Else",
      type: "PLA",
      diameter: 1.75,
    });

    const realFindOneAndUpdate = Filament.findOneAndUpdate.bind(Filament);
    const findOneAndUpdateSpy = vi
      .spyOn(Filament, "findOneAndUpdate")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (filter: any, ...rest: any[]) => {
        if (filter && String(filter._id) === String(existingVariant._id)) {
          // Simulate a concurrent actor re-parenting VENDOR between the
          // route's advisory findCollision() (already run, observed
          // parentId === GENERIC) and this atomic write. The new
          // expectedParentId filter should now genuinely fail to match
          // once this mutation lands — no need to fake a null return.
          await Filament.updateOne(
            { _id: existingVariant._id },
            { $set: { parentId: otherParent._id } },
          );
        }
        return realFindOneAndUpdate(filter, ...rest);
      });
    // Phase 1 now misses (filter above), phase 2 has nothing trashed, so
    // phase 3 attempts a real create — which WOULD collide with VENDOR's
    // still-active row via the partial-unique-on-name index, but that
    // index builds asynchronously and can lag under a loaded test run
    // (same flakiness the existing bambuUpsert.test.ts race tests avoid
    // by forcing the E11000 explicitly rather than relying on the real
    // index). Force it here too so the race-recovery path — where the new
    // expectedParentId check actually lives — runs deterministically.
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    // The only Filament.create() call left in this flow (GENERIC updates
    // via phase 1 normally; `otherParent` was already created above,
    // before this spy exists) is phase 3's attempt to create VENDOR.
    const createSpy = vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      throw e11000;
    });

    try {
      const res = await POST(jsonReq({ selected: [VENDOR.name], profiles: ALL }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${VENDOR.name}": Collision`)]),
      );

      // The variant's content must NOT have been overwritten with a diff
      // baselined against the WRONG (no-longer-current) parent.
      const unchanged = await Filament.findOne({ name: VENDOR.name });
      expect(unchanged.density).toBe(originalDensity);
    } finally {
      findOneAndUpdateSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("fails closed instead of applying a wrong-baseline diff when a brand-new variant name races under a different parent", async () => {
    // Import ONLY the root (GENERIC) first — VENDOR.name does not exist
    // anywhere yet, so the route's advisory findCollision() for it will
    // genuinely find nothing and intend a fresh CREATE.
    const rootOnly = await post({ selected: [GENERIC.name], profiles: ALL });
    expect(rootOnly.status).toBe(200);

    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");

    const otherParent = await Filament.create({
      name: "Unrelated Root 3",
      vendor: "Someone Else",
      type: "PLA",
      diameter: 1.75,
    });

    // Captured BEFORE spying so the injected race and the "let it through"
    // branches always call the true original — never the spy — avoiding
    // any ordering interaction with the separate `create` spy below.
    const realFindOne = Filament.findOne.bind(Filament);
    const realCreate = Filament.create.bind(Filament);

    // GENERIC already exists (from the root-only import above), so its OWN
    // advisory findCollision() short-circuits on the FIRST (active) check
    // and never reaches a trashed check — meaning the number of findOne
    // calls it consumes isn't fixed at 2 the way a from-scratch root is.
    // Keying on VENDOR.name specifically (which GENERIC's calls never
    // match) sidesteps that entirely: VENDOR's own advisory findCollision()
    // active-check is the FIRST occurrence of {name: VENDOR.name,
    // _deletedAt: null}; upsertParsedBambuFilament's phase-1 read is the
    // bare, unchained SECOND occurrence.
    let vendorActiveCalls = 0;
    const findOneSpy = vi
      .spyOn(Filament, "findOne")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((filter: any, ...rest: any[]) => {
        if (filter && filter.name === VENDOR.name && filter._deletedAt === null) {
          vendorActiveCalls++;
          if (vendorActiveCalls === 2) {
            return (async () => {
              await realCreate({
                name: VENDOR.name,
                vendor: "Racing Variant Creator 2",
                type: "PLA",
                diameter: 1.75,
                density: 42, // distinguishable from any GENERIC-baselined diff
                parentId: otherParent._id,
              });
              return realFindOne(filter, ...rest);
            })();
          }
        }
        return realFindOne(filter, ...rest);
      });
    // Force the E11000 deterministically (the real partial-unique-on-name
    // index builds asynchronously and can lag under a loaded test run).
    // The racing creation above bypasses this spy entirely (uses
    // realCreate), so the only call this spy actually
    // observes is phase 3's genuine attempt to create VENDOR.
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const createSpy = vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      throw e11000;
    });

    try {
      const res = await POST(jsonReq({ selected: [VENDOR.name], profiles: ALL }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${VENDOR.name}": Collision`)]),
      );

      // The racing document must be untouched by our diff (baselined
      // against GENERIC, not the racer's actual parent) — proving the
      // write failed BEFORE landing, not silently corrupting it.
      const racer = await Filament.findOne({ name: VENDOR.name });
      expect(String(racer.parentId)).toBe(String(otherParent._id));
      expect(racer.vendor).toBe("Racing Variant Creator 2");
      expect(racer.density).toBe(42);
    } finally {
      findOneSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("fails closed instead of applying a wrong-baseline diff when a race re-parents an existing standalone collision mid-write", async () => {
    // A hand-made standalone filament shares VENDOR's name — the "existing
    // standalone/root" collision branch, distinct from the
    // same-parent-variant-update branch covered above.
    const standalone = await Filament.create({
      name: VENDOR.name,
      vendor: "Hand Made",
      type: "PLA",
      diameter: 1.75,
    });

    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");

    const otherParent = await Filament.create({
      name: "Unrelated Root 4",
      vendor: "Someone Else",
      type: "PLA",
      diameter: 1.75,
    });

    const realFindOneAndUpdate = Filament.findOneAndUpdate.bind(Filament);
    const findOneAndUpdateSpy = vi
      .spyOn(Filament, "findOneAndUpdate")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (filter: any, ...rest: any[]) => {
        if (filter && String(filter._id) === String(standalone._id)) {
          // Simulate a concurrent actor re-parenting the standalone row
          // between the route's advisory findCollision() (already run,
          // observed parentId === null) and this atomic write.
          await Filament.updateOne(
            { _id: standalone._id },
            { $set: { parentId: otherParent._id } },
          );
        }
        return realFindOneAndUpdate(filter, ...rest);
      });
    // GENERIC doesn't exist yet in this test (only VENDOR does, as the
    // pre-existing standalone), so it needs a real, unmocked create of its
    // own — only VENDOR's create attempt (which collides with the
    // now-re-parented standalone row) should be forced to E11000.
    const realCreate = Filament.create.bind(Filament);
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const createSpy = vi
      .spyOn(Filament, "create")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (doc: any) => {
        if (doc && doc.name === VENDOR.name) throw e11000;
        return realCreate(doc);
      });

    try {
      const res = await POST(jsonReq({ selected: [VENDOR.name], profiles: ALL }));
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.errors).toEqual(
        expect.arrayContaining([expect.stringContaining(`"${VENDOR.name}": Collision`)]),
      );

      // The row must NOT have been overwritten with the full flattened
      // payload (baselined as "this is a standalone") while it actually
      // now belongs to a different parent — vendor stays "Hand Made".
      const unchanged = await Filament.findOne({ name: VENDOR.name });
      expect(unchanged.vendor).toBe("Hand Made");
      expect(String(unchanged.parentId)).toBe(String(otherParent._id));
    } finally {
      findOneAndUpdateSpy.mockRestore();
      createSpy.mockRestore();
    }
  });

  it("clears a stale variant override when the profile goes back to inheriting the parent (Codex P2 on PR #985)", async () => {
    // First import: the child profile genuinely overrides cost + nozzle
    // temp, so the diff pins both on the variant.
    const vendorPinned = {
      ...VENDOR,
      filament_cost: ["30"],
      nozzle_temperature: ["235"],
    };
    const first = await post({
      selected: [VENDOR.name],
      profiles: [TEMPLATE, GENERIC, vendorPinned],
    });
    expect(first.status).toBe(200);
    let variant = await Filament.findOne({ name: VENDOR.name });
    expect(variant.cost).toBe(30);
    expect(variant.temperatures.nozzle).toBe(235);

    // Second import: the child profile dropped both overrides and now
    // inherits the parent's cost (20) and nozzle temp (220). The diff
    // omits the now-equal keys, so pre-fix the stale 30/235 pins survived
    // forever; the parent-equal prunable keys riding the update payload
    // let the GH #403 pruning clear them.
    const res = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.updated).toBe(2);
    expect(body.errors).toBeUndefined();

    variant = await Filament.findOne({ name: VENDOR.name });
    expect(variant.cost).toBeNull(); // $unset — inheriting again
    expect(variant.temperatures.nozzle).toBeNull(); // dropped from the subdoc
    // …and the variant's own diffs are untouched.
    expect(variant.density).toBe(1.17);
    expect(variant.color).toBe("#FF0000");
    const parent = await Filament.findOne({ name: GENERIC.name });
    const resolved = resolveFilament(variant.toObject(), parent.toObject());
    expect(resolved.cost).toBe(20);
    expect(resolved.temperatures.nozzle).toBe(220);
  });

  it("updates an existing ROOT filament in place with full values — never re-parents", async () => {
    await Filament.create({
      name: VENDOR.name,
      vendor: "Hand Made",
      type: "PLA",
      diameter: 1.75,
    });
    const res = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1); // the Generic root
    expect(body.updated).toBe(1); // the pre-existing row
    expect(body.variants).toBe(0);

    const row = await Filament.findOne({ name: VENDOR.name });
    expect(row.parentId).toBeNull(); // NOT re-parented
    expect(row.vendor).toBe("Polymaker");
    // Full flattened payload applied (values it would otherwise inherit)
    expect(row.cost).toBe(20);
    expect(row.temperatures.nozzle).toBe(220);
  });

  it("skips an existing variant of a DIFFERENT parent with a per-profile error", async () => {
    const otherParent = await Filament.create({
      name: "Some Other Parent",
      vendor: "X",
      type: "PLA",
      diameter: 1.75,
    });
    await Filament.create({
      name: VENDOR.name,
      vendor: "X",
      type: "PLA",
      diameter: 1.75,
      cost: 42,
      parentId: otherParent._id,
    });

    const res = await post({ selected: [VENDOR.name], profiles: ALL });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(1); // Generic root still imports
    expect(body.updated).toBe(0);
    expect(body.variants).toBe(0);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/already exists as a variant of a different filament/);

    // Row untouched.
    const row = await Filament.findOne({ name: VENDOR.name });
    expect(String(row.parentId)).toBe(String(otherParent._id));
    expect(row.vendor).toBe("X");
    expect(row.cost).toBe(42);
  });

  it("resurrects a trashed row of the same name instead of duplicating", async () => {
    const trashed = await Filament.create({
      name: GENERIC.name,
      vendor: "Old",
      type: "PLA",
      diameter: 1.75,
    });
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });

    const res = await post({ selected: [GENERIC.name], profiles: [TEMPLATE, GENERIC] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.created).toBe(0);
    expect(body.updated).toBe(1);

    const rows = await Filament.find({ name: GENERIC.name });
    expect(rows).toHaveLength(1);
    expect(rows[0]._deletedAt).toBeNull();
    expect(rows[0].vendor).toBe("Generic");
  });

  describe("trashed-row collisions (PR #985)", () => {
    it("diff-resurrects a trashed variant of the same parent, keeping its link", async () => {
      const first = await post({ selected: [VENDOR.name], profiles: ALL });
      expect(first.status).toBe(200);
      const variantBefore = await Filament.findOne({ name: VENDOR.name });
      await Filament.updateOne(
        { _id: variantBefore._id },
        { $set: { _deletedAt: new Date() } },
      );

      const res = await post({ selected: [VENDOR.name], profiles: ALL });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(2); // root updated + variant resurrected
      expect(body.variants).toBe(1);
      expect(body.errors).toBeUndefined();

      const rows = await Filament.find({ name: VENDOR.name });
      expect(rows).toHaveLength(1);
      expect(rows[0]._deletedAt).toBeNull();
      const parent = await Filament.findOne({ name: GENERIC.name });
      expect(String(rows[0].parentId)).toBe(String(parent._id)); // link survived
      expect(rows[0].cost).toBeNull(); // diff payload — still inheriting
    });

    it("resurrects a trashed ROOT row named like a planned variant with FULL values (hyiger P2)", async () => {
      // Pre-fix, this branch sent the diff payload + parentId to the
      // upsert, whose phase-2 resurrect ignores parentId and $sets only
      // the diff keys — an orphaned, half-populated row reported as
      // updated.
      const trashed = await Filament.create({
        name: VENDOR.name,
        vendor: "Hand Made",
        type: "PLA",
        diameter: 1.75,
      });
      await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });

      const res = await post({ selected: [VENDOR.name], profiles: ALL });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(1); // the Generic root
      expect(body.updated).toBe(1); // the resurrected row
      expect(body.variants).toBe(0); // unlinked → not counted as a variant
      expect(body.errors).toBeUndefined();

      const row = await Filament.findOne({ name: VENDOR.name });
      expect(row._deletedAt).toBeNull();
      expect(row.parentId).toBeNull(); // a resurrect never re-parents
      expect(row.vendor).toBe("Polymaker");
      // FULL flattened payload applied — fields a linked variant would
      // inherit are pinned instead of missing/stale.
      expect(row.cost).toBe(20);
      expect(row.temperatures.nozzle).toBe(220);
    });

    it("skips a trashed variant of a DIFFERENT parent with a per-profile error", async () => {
      const otherParent = await Filament.create({
        name: "Some Other Parent",
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
      });
      const v = await Filament.create({
        name: VENDOR.name,
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
        parentId: otherParent._id,
      });
      await Filament.updateOne({ _id: v._id }, { $set: { _deletedAt: new Date() } });

      const res = await post({ selected: [VENDOR.name], profiles: ALL });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(1); // Generic root still imports
      expect(body.errors).toEqual([
        expect.stringMatching(
          /"Polymaker PolyLite PLA @System": already exists as a variant of a different filament/,
        ),
      ]);

      const row = await Filament.findOne({ name: VENDOR.name });
      expect(row._deletedAt).not.toBeNull(); // untouched — stays trashed
      expect(String(row.parentId)).toBe(String(otherParent._id));
      expect(row.vendor).toBe("X");
    });

    it("skips a planned ROOT whose name belongs to an existing ACTIVE variant (Codex P2)", async () => {
      // Pre-fix, the upsert updated the variant in place (keeping its
      // parentId) and the route registered that variant's _id as the
      // parent for every planned child — variants-of-variants, which the
      // app resolves only one level deep.
      const otherParent = await Filament.create({
        name: "Some Other Parent",
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
      });
      await Filament.create({
        name: GENERIC.name,
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
        cost: 42,
        parentId: otherParent._id,
      });

      const res = await post({ selected: [VENDOR.name], profiles: ALL });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(0);
      expect(body.updated).toBe(0);
      expect(body.variants).toBe(0);
      expect(body.errors).toEqual([
        expect.stringMatching(
          /"Generic PLA @System": already exists as a variant of another filament/,
        ),
        expect.stringMatching(
          /"Polymaker PolyLite PLA @System": parent "Generic PLA @System" failed to import/,
        ),
      ]);

      // The existing variant is untouched and nothing got created under it.
      const row = await Filament.findOne({ name: GENERIC.name });
      expect(String(row.parentId)).toBe(String(otherParent._id));
      expect(row.vendor).toBe("X");
      expect(row.cost).toBe(42);
      expect(await Filament.findOne({ name: VENDOR.name })).toBeNull();
    });

    it("skips a planned ROOT whose name belongs to a TRASHED variant", async () => {
      const otherParent = await Filament.create({
        name: "Some Other Parent",
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
      });
      const v = await Filament.create({
        name: GENERIC.name,
        vendor: "X",
        type: "PLA",
        diameter: 1.75,
        parentId: otherParent._id,
      });
      await Filament.updateOne({ _id: v._id }, { $set: { _deletedAt: new Date() } });

      const res = await post({ selected: [VENDOR.name], profiles: ALL });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(0);
      expect(body.errors).toHaveLength(2);
      expect(body.errors[0]).toMatch(/already exists as a variant of another filament/);

      const row = await Filament.findOne({ name: GENERIC.name });
      expect(row._deletedAt).not.toBeNull(); // stays trashed — no resurrect
      expect(String(row.parentId)).toBe(String(otherParent._id));
    });
  });

  it("recovers from a concurrent create race by updating the racing winner", async () => {
    // Same pattern as the bambustudio race test: reset the module cache so
    // the route (and bambuUpsert) bind to the SAME Filament model we spy on.
    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    const { POST } = await import("@/app/api/filaments/orcaslicer/route");

    const realCreate = Filament.create.bind(Filament);
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const spy = vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      // The racing winner inserts while we were about to create the root.
      await realCreate({
        name: GENERIC.name,
        vendor: "Racing Winner",
        type: "PLA",
        diameter: 1.75,
      });
      throw e11000;
    });

    try {
      const res = await POST(jsonReq({ selected: [VENDOR.name], profiles: ALL }));
      const body = await res.json();
      if (res.status !== 200) {
        throw new Error(`unexpected status ${res.status}: ${JSON.stringify(body)}`);
      }
      // Root converged onto the racing winner (updated), variant created.
      expect(body.created).toBe(1);
      expect(body.updated).toBe(1);
      expect(body.variants).toBe(1);
      const roots = await Filament.find({ name: GENERIC.name });
      expect(roots).toHaveLength(1);
      expect(roots[0].vendor).toBe("Generic"); // import overrode the winner
      const variant = await Filament.findOne({ name: VENDOR.name });
      expect(String(variant.parentId)).toBe(String(roots[0]._id));
    } finally {
      spy.mockRestore();
    }
  });

  it("a profile with a missing base errors individually; siblings still import", async () => {
    const orphan = {
      name: "Orphan PLA",
      instantiation: "true",
      inherits: "missing_base",
      filament_vendor: ["X"],
      filament_type: ["PLA"],
    };
    const res = await post({
      selected: ["Orphan PLA", VENDOR.name],
      profiles: [...ALL, orphan],
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatch(/"Orphan PLA": inherits "missing_base" not found/);
    expect(body.created).toBe(2);
    expect(await Filament.findOne({ name: "Orphan PLA" })).toBeNull();
    expect(await Filament.findOne({ name: VENDOR.name })).toBeTruthy();
  });

  it("a selected name absent from the profiles is a per-profile error", async () => {
    const res = await post({ selected: ["Ghost", GENERIC.name], profiles: [TEMPLATE, GENERIC] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.errors).toEqual([
      expect.stringMatching(/"Ghost": not found in the submitted profiles/),
    ]);
    expect(body.created).toBe(1);
  });

  describe("calibration hints", () => {
    const CALIBRATED_VENDOR = {
      ...VENDOR,
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
      filament_flow_ratio: ["0.978"],
      pressure_advance: ["0.028"],
    };

    it("applies calibration to a matching printer + nozzle and reports the aggregate", async () => {
      const nozzle = await Nozzle.create({ name: "P1S 0.4 Brass", diameter: 0.4, type: "Brass" });
      await Printer.create({
        name: "Bambu Lab P1S",
        manufacturer: "Bambu Lab",
        printerModel: "P1S",
        installedNozzles: [nozzle._id],
      });

      const res = await post({
        selected: [CALIBRATED_VENDOR.name],
        profiles: [TEMPLATE, GENERIC, CALIBRATED_VENDOR],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calibrationApplied).toBe(1);
      expect(body.calibrationUnresolved).toBe(0);

      const variant = await Filament.findOne({ name: VENDOR.name });
      expect(variant.calibrations).toHaveLength(1);
      expect(variant.calibrations[0].extrusionMultiplier).toBeCloseTo(0.978);
      expect(variant.calibrations[0].pressureAdvance).toBeCloseTo(0.028);
    });

    it("reports unresolved when no printer matches the hint", async () => {
      const res = await post({
        selected: [CALIBRATED_VENDOR.name],
        profiles: [TEMPLATE, GENERIC, CALIBRATED_VENDOR],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.calibrationApplied).toBe(0);
      expect(body.calibrationUnresolved).toBe(1);
    });
  });

  describe("guards and caps", () => {
    it("rejects a cross-site browser request with 403 (CSRF guard)", async () => {
      const res = await post(
        { selected: [GENERIC.name], profiles: [TEMPLATE, GENERIC] },
        { "sec-fetch-site": "cross-site" },
      );
      expect(res.status).toBe(403);
      expect(await Filament.countDocuments({})).toBe(0);
    });

    it("rejects an oversized declared Content-Length with 413", async () => {
      const res = await post(
        { selected: [GENERIC.name], profiles: [TEMPLATE, GENERIC] },
        { "content-length": String(11 * 1024 * 1024) },
      );
      expect(res.status).toBe(413);
    });

    it("rejects an oversized body past the post-read byte check with 413 (PR #985)", async () => {
      // A lying Content-Length sails through checkContentLength; the body is
      // 6M chars but 12 MB of UTF-8 BYTES, so only the post-read
      // Buffer.byteLength branch (the #685 byte-not-char semantics) can
      // catch it.
      const big = "é".repeat(6 * 1024 * 1024);
      const res = await post(big, { "content-length": "100" });
      expect(res.status).toBe(413);
      expect((await res.json()).error).toMatch(/too large/i);
    });

    it("surfaces indexOrcaProfiles errors (duplicate + malformed entries) alongside successful imports (PR #985)", async () => {
      const res = await post({
        selected: [GENERIC.name],
        profiles: [TEMPLATE, GENERIC, GENERIC, "not an object", { instantiation: "true" }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(1); // the selected Generic still imports
      expect(body.errors).toEqual([
        expect.stringMatching(/duplicate profile name "Generic PLA @System"/),
        expect.stringMatching(/profile at index 3 is not a JSON object/),
        expect.stringMatching(/profile at index 4 has no "name"/),
      ]);
      expect(await Filament.countDocuments({ name: GENERIC.name })).toBe(1);
    });

    it("rejects invalid JSON with 400", async () => {
      const res = await post("this is not json{");
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Invalid JSON/);
    });

    it("rejects a body without selected/profiles with 400", async () => {
      expect((await post({})).status).toBe(400);
      expect((await post({ selected: [], profiles: [TEMPLATE] })).status).toBe(400);
      expect((await post({ selected: [GENERIC.name], profiles: [] })).status).toBe(400);
      expect((await post({ selected: [123], profiles: [TEMPLATE] })).status).toBe(400);
      expect((await post([])).status).toBe(400);
    });

    it("rejects selections beyond the 10k cap with 400", async () => {
      const res = await post({
        selected: Array.from({ length: 10_001 }, (_, i) => `P${i}`),
        profiles: [TEMPLATE],
      });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/Import too large/);
    });

    it("degrades a per-profile upsert failure to an error entry (missing vendor on create)", async () => {
      const noVendor = {
        name: "No Vendor PLA",
        instantiation: "true",
        filament_type: ["PLA"],
      };
      const res = await post({ selected: ["No Vendor PLA"], profiles: [noVendor] });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.created).toBe(0);
      expect(body.errors).toEqual([
        expect.stringMatching(/"No Vendor PLA": .*filament_vendor/),
      ]);
    });
  });
});
