import { describe, it, expect, beforeEach, vi } from "vitest";
import mongoose from "mongoose";
import { parseBambuStudioProfile } from "@/lib/bambuStudioImport";

/**
 * Direct tests for the shared three-phase upsert (src/lib/bambuUpsert.ts).
 * The happy paths are exercised end-to-end by tests/bambustudio-route.test.ts
 * and tests/orcaslicer-import-route.test.ts; this file pins the narrow race /
 * failure branches the routes can't reach deterministically:
 *   - phase-1/phase-2 atomic returning null (row deleted/purged mid-flight)
 *   - the E11000 race sub-branches (winner already deleted, race update
 *     returning null, race update throwing a validator error)
 *   - non-client create failures mapping to a 500 result with detail
 *   - unsetKeys composing a $unset (stale variant override cleared)
 *   - opts.parentId being IGNORED on the update phases (never re-parents)
 *
 * Spy-based tests reset the module cache first so the lib binds to the same
 * Filament model instance the spies patch (tests/setup.ts wipes
 * mongoose.models between tests — same subtlety as the bambustudio race test).
 */
describe("upsertParsedBambuFilament (three-phase upsert lib)", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let upsert: typeof import("@/lib/bambuUpsert").upsertParsedBambuFilament;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    Filament = (await import("@/models/Filament")).default;
    if (!mongoose.models.Filament) mongoose.model("Filament", Filament.schema);
    upsert = (await import("@/lib/bambuUpsert")).upsertParsedBambuFilament;
  });

  function parsed(overrides: Record<string, unknown> = {}) {
    return parseBambuStudioProfile({
      name: ["QA Upsert PLA"],
      filament_type: ["PLA"],
      filament_vendor: ["QA Labs"],
      filament_diameter: ["1.75"],
      filament_density: ["1.24"],
      ...overrides,
    });
  }

  it("falls through to create when the phase-1 atomic returns null (row deleted mid-flight)", async () => {
    await Filament.create({ name: "QA Upsert PLA", vendor: "Old", type: "PLA" });
    // Phase-1 findOne sees the row, but the guarded findOneAndUpdate misses
    // (simulating a concurrent soft-delete) → phase 2 (nothing trashed) →
    // phase 3 create collides (E11000 mocked — the REAL partial-unique
    // index builds asynchronously and can lag under a loaded coverage run,
    // so relying on the DB to throw is flaky) → the race path re-fetches
    // the row and converges via a real update.
    const spy = vi
      .spyOn(Filament, "findOneAndUpdate")
      .mockImplementationOnce(async () => null);
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      throw e11000;
    });
    const result = await upsert(parsed());
    expect(spy).toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(false);
      expect(await Filament.countDocuments({ name: "QA Upsert PLA" })).toBe(1);
    }
  });

  it("falls through to create when the phase-2 resurrect atomic returns null", async () => {
    const trashed = await Filament.create({ name: "QA Upsert PLA", vendor: "Old", type: "PLA" });
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });
    // Resurrect misses (simulating a concurrent purge/restore) → phase 3
    // creates a NEW active row (legal: the unique index is partial on
    // non-deleted rows).
    vi.spyOn(Filament, "findOneAndUpdate").mockImplementationOnce(async () => null);
    const result = await upsert(parsed());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true);
    expect(await Filament.countDocuments({ name: "QA Upsert PLA", _deletedAt: null })).toBe(1);
  });

  it("blocks the phase-2 resurrect when the trashed row's parent doesn't match expectedParentId", async () => {
    const realParentId = new mongoose.Types.ObjectId().toString();
    const trashed = await Filament.create({
      name: "QA Upsert PLA",
      vendor: "Old",
      type: "PLA",
      parentId: realParentId,
    });
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });

    const differentParentId = new mongoose.Types.ObjectId().toString();
    // No mocking — the resurrect atomic's own filter (parentId: opts.expectedParentId)
    // genuinely fails to match the trashed row's real parentId, proving the
    // guard blocks it for real rather than by a stubbed-null return.
    const result = await upsert(parsed(), { expectedParentId: differentParentId });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true); // a NEW row, not the resurrect

    // The original trashed row was never touched — still trashed, still
    // carrying its real (unexpected) parent.
    const stillTrashed = await Filament.findById(trashed._id);
    expect(stillTrashed!._deletedAt).not.toBeNull();
    expect(String(stillTrashed!.parentId)).toBe(realParentId);

    // The new create is the only active row of this name.
    expect(await Filament.countDocuments({ name: "QA Upsert PLA", _deletedAt: null })).toBe(1);
  });

  it("maps a validator rejection from the resurrect write to a 400 result", async () => {
    const trashed = await Filament.create({ name: "QA Upsert PLA", vendor: "Old", type: "PLA" });
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });
    const validationError = Object.assign(new Error("density is negative"), {
      name: "ValidationError",
    });
    vi.spyOn(Filament, "findOneAndUpdate").mockImplementationOnce(async () => {
      throw validationError;
    });
    const result = await upsert(parsed());
    expect(result).toEqual({ ok: false, status: 400, error: "density is negative" });
  });

  it("returns the pre-write payload failure on the resurrect path (PR #985)", async () => {
    // Incoming min 300 alone isn't inverted; merged with the trashed row's
    // stored max 250 it is — so the failure fires at the phase-2
    // `bambuPayloadFailure` gate, BEFORE any write (not via a thrown
    // validator, which the earlier test covers).
    const trashed = await Filament.create({
      name: "QA Upsert PLA",
      vendor: "Old",
      type: "PLA",
      temperatures: { nozzleRangeMax: 250 },
    });
    await Filament.updateOne({ _id: trashed._id }, { $set: { _deletedAt: new Date() } });

    const result = await upsert(parsed({ nozzle_temperature_range_low: ["300"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/minimum temperature/i);
    }
    // Nothing was written — the row is still trashed and untouched.
    const row = await Filament.findOne({ name: "QA Upsert PLA" });
    expect(row._deletedAt).not.toBeNull();
    expect(row.vendor).toBe("Old");
  });

  it("returns the pre-write payload failure on the race-recovery path (PR #985)", async () => {
    // The create gate checks the payload against a NULL existing (min 300,
    // no max → not inverted), so only the race-recovery gate — recomputed
    // against the racing winner's stored max 250 — can catch this one.
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const realCreate = Filament.create.bind(Filament);
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      await realCreate({
        name: "QA Upsert PLA",
        vendor: "Winner",
        type: "PLA",
        temperatures: { nozzleRangeMax: 250 },
      });
      throw e11000;
    });

    const result = await upsert(parsed({ nozzle_temperature_range_low: ["300"] }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/minimum temperature/i);
    }
    // The racing winner was not touched.
    const row = await Filament.findOne({ name: "QA Upsert PLA" });
    expect(row.vendor).toBe("Winner");
  });

  it("tolerates a minimal legacy existing-doc shape in augmentExistingWithParent (PR #985)", async () => {
    // A hydrated Mongoose doc always materialises the optional paths
    // (defaults / [] arrays), so the `?? null` fallbacks are unreachable
    // through the real model — feed phase 1 a plain object with them
    // absent, as a defensive-shape pin.
    const real = await Filament.create({ name: "QA Upsert PLA", vendor: "Old", type: "PLA" });
    vi.spyOn(Filament, "findOne").mockImplementationOnce(
      async () => ({ _id: real._id, name: real.name, type: "PLA", vendor: "Old" }),
    );
    const result = await upsert(parsed());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(false);
    const row = await Filament.findOne({ name: "QA Upsert PLA" });
    expect(row.vendor).toBe("QA Labs"); // the phase-1 update still applied
  });

  it("maps a non-duplicate create failure to a 500 result with detail", async () => {
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const result = await upsert(parsed());
    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "Failed to create filament",
      detail: "boom",
    });
  });

  it("bails out when the E11000 racing winner is already gone", async () => {
    // create throws a duplicate-key error but no active row exists to
    // converge on (the winner was deleted in between) — surface the
    // original failure rather than spinning.
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      throw e11000;
    });
    const result = await upsert(parsed());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.detail).toMatch(/E11000/);
    }
  });

  it("bails out when the race-recovery update itself misses", async () => {
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const realCreate = Filament.create.bind(Filament);
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      await realCreate({ name: "QA Upsert PLA", vendor: "Winner", type: "PLA" });
      throw e11000;
    });
    // The race findOne sees the winner, but its guarded update misses
    // (deleted again mid-flight).
    vi.spyOn(Filament, "findOneAndUpdate").mockImplementationOnce(async () => null);
    const result = await upsert(parsed());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(500);
  });

  it("maps a validator rejection from the race-recovery update to a 400 result", async () => {
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    const realCreate = Filament.create.bind(Filament);
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      await realCreate({ name: "QA Upsert PLA", vendor: "Winner", type: "PLA" });
      throw e11000;
    });
    const validationError = Object.assign(new Error("cost must be positive"), {
      name: "ValidationError",
    });
    vi.spyOn(Filament, "findOneAndUpdate").mockImplementationOnce(async () => {
      throw validationError;
    });
    const result = await upsert(parsed());
    expect(result).toEqual({ ok: false, status: 400, error: "cost must be positive" });
  });

  it("blocks the race-recovery merge itself when a second race re-parents the winner between the pre-check and the write", async () => {
    const expectedParentId = new mongoose.Types.ObjectId().toString();
    const otherParentId = new mongoose.Types.ObjectId().toString();
    let racingId = "";

    const realCreate = Filament.create.bind(Filament);
    const e11000 = Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
    vi.spyOn(Filament, "create").mockImplementationOnce(async () => {
      // The racing winner is created under the SAME parent the caller
      // expects, so the pre-check (racingParentIdStr !== expectedParentId)
      // passes.
      const winner = await realCreate({
        name: "QA Upsert PLA",
        vendor: "Winner",
        type: "PLA",
        parentId: expectedParentId,
      });
      racingId = String(winner._id);
      throw e11000;
    });

    const realFindOneAndUpdate = Filament.findOneAndUpdate.bind(Filament);
    vi.spyOn(Filament, "findOneAndUpdate")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation(async (filter: any, ...rest: any[]) => {
        if (filter && String(filter._id) === racingId) {
          // A SECOND race lands between the pre-check (already passed
          // above, since parentId matched at that point) and this merge
          // write itself: re-parent the winner again.
          await Filament.updateOne({ _id: racingId }, { $set: { parentId: otherParentId } });
        }
        return realFindOneAndUpdate(filter, ...rest);
      });

    const result = await upsert(parsed(), { expectedParentId });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error).toMatch(/different parent than expected/);
    }
    // The winner's content must be untouched by our diff — the merge
    // filter's own parentId condition rejected the write for real.
    const winner = await Filament.findById(racingId);
    expect(winner!.vendor).toBe("Winner");
    expect(String(winner!.parentId)).toBe(otherParentId);
  });

  it("clears a stale variant override via $unset when the import equals the parent (GH #473)", async () => {
    const parent = await Filament.create({
      name: "QA Parent PLA",
      vendor: "QA Labs",
      type: "PLA",
      density: 1.24,
    });
    await Filament.create({
      name: "QA Upsert PLA",
      vendor: "QA Labs",
      type: "PLA",
      density: 1.3, // stale local override
      parentId: parent._id,
    });
    // Imported density equals the parent's → buildStructuredUpdate flags it
    // in unsetKeys and composeMongoUpdate must carry the $unset.
    const result = await upsert(parsed({ filament_density: ["1.24"] }));
    expect(result.ok).toBe(true);
    const variant = await Filament.findOne({ name: "QA Upsert PLA" });
    expect(variant.density ?? null).toBeNull(); // override cleared, inherits again
    expect(String(variant.parentId)).toBe(String(parent._id));
  });

  it("ignores opts.parentId on the update phases — an existing row is never re-parented", async () => {
    await Filament.create({ name: "QA Upsert PLA", vendor: "QA Labs", type: "PLA" });
    const stranger = await Filament.create({ name: "Stranger", vendor: "X", type: "PLA" });
    const result = await upsert(parsed(), { parentId: String(stranger._id) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(false);
    const row = await Filament.findOne({ name: "QA Upsert PLA" });
    expect(row.parentId).toBeNull();
  });

  it("applies opts.parentId on the phase-3 create", async () => {
    const parent = await Filament.create({ name: "QA Parent PLA", vendor: "QA Labs", type: "PLA" });
    const result = await upsert(parsed(), { parentId: String(parent._id) });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.created).toBe(true);
    const row = await Filament.findOne({ name: "QA Upsert PLA" });
    expect(String(row.parentId)).toBe(String(parent._id));
  });
});
