import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as spoolCheck } from "@/app/api/filaments/[id]/spool-check/route";
import { GET as analytics } from "@/app/api/analytics/route";
import { POST as restoreFilament } from "@/app/api/filaments/[id]/restore/route";
import { DELETE as deleteFilament } from "@/app/api/filaments/[id]/route";

/**
 * GH #223 — three routes that read variant-only fields directly without
 * resolving the parent fallback. PR #190 fixed the same class of bug in
 * the compare route after Codex flagged it (variants commonly inherit
 * `spoolWeight`, `cost`, etc. via `src/lib/resolveFilament.ts`).
 *
 * This file locks down the parallel fix in:
 *   1. /api/filaments/{id}/spool-check — `spoolWeight` inheritance
 *   2. /api/analytics                  — `cost` inheritance (totalCost)
 *   3. /api/filaments/{id}/restore     — refuses to orphan a variant
 *                                        whose parent is still trashed
 */
describe("GH #223 — variant inheritance in slicer + analytics + restore routes", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PrintHistory: any;

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const phMod = await import("@/models/PrintHistory");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filMod.default.schema);
    }
    if (!mongoose.models.PrintHistory) {
      mongoose.model("PrintHistory", phMod.default.schema);
    }
    // Analytics also populates printer name — register so .populate() works.
    const printerMod = await import("@/models/Printer");
    if (!mongoose.models.Printer) {
      mongoose.model("Printer", printerMod.default.schema);
    }
    Filament = mongoose.models.Filament;
    PrintHistory = mongoose.models.PrintHistory;
  });

  // ---------------------------------------------------------------------
  // 1. spool-check
  // ---------------------------------------------------------------------

  it("spool-check resolves spoolWeight from the parent on a variant", async () => {
    const parent = await Filament.create({
      name: "SpoolCheck-Parent",
      vendor: "V",
      type: "PLA",
      spoolWeight: 250,
      spools: [{ label: "p1", totalWeight: 600 }],
    });
    const variant = await Filament.create({
      name: "SpoolCheck-Variant",
      vendor: "V",
      type: "PLA",
      color: "#101010",
      parentId: parent._id,
      // spoolWeight intentionally omitted — inherit from parent.
      spools: [{ label: "v1", totalWeight: 600 }],
    });

    const req = new NextRequest(
      `http://localhost/api/filaments/${variant._id}/spool-check?weight=100`,
    );
    const res = await spoolCheck(req, {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Pre-fix: variant.spoolWeight was null, so the route hit the
    // "no data — skipping check" guard and returned empty `spools`.
    // Post-fix: the per-spool entry exists, with remainingWeight = 600 − 250 = 350.
    expect(body.spools).toHaveLength(1);
    expect(body.spools[0].remainingWeightG).toBeCloseTo(350, 0);
    expect(body.message).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // 2. analytics
  // ---------------------------------------------------------------------

  it("analytics totalCost includes the parent's cost for inheriting variants", async () => {
    const parent = await Filament.create({
      name: "Analytics-Parent",
      vendor: "V",
      type: "PLA",
      cost: 30, // $30 / kg
    });
    const variant = await Filament.create({
      name: "Analytics-Variant",
      vendor: "V",
      type: "PLA",
      color: "#fafafa",
      parentId: parent._id,
      // cost intentionally omitted — inherit from parent.
    });

    await PrintHistory.create({
      jobLabel: "test job",
      startedAt: new Date(),
      usage: [{ filamentId: variant._id, grams: 100 }],
    });

    const res = await analytics(
      new NextRequest("http://localhost/api/analytics?days=30"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    // 100 g of $30/kg → $3.00. Pre-fix this was $0 because the populated
    // variant doc had cost: null.
    expect(body.totals.grams).toBe(100);
    expect(body.totals.cost).toBeCloseTo(3.0, 2);
    // The byFilament row for the variant should carry the resolved cost
    // so the page's per-row tooltips also show real money.
    const variantRow = body.byFilament.find(
      (r: { _id: string }) => r._id === String(variant._id),
    );
    expect(variantRow.cost).toBe(30);
  });

  it("analytics totalCost still works for a standalone filament with own cost", async () => {
    const solo = await Filament.create({
      name: "Analytics-Solo",
      vendor: "V",
      type: "PLA",
      cost: 25,
    });

    await PrintHistory.create({
      jobLabel: "solo job",
      startedAt: new Date(),
      usage: [{ filamentId: solo._id, grams: 200 }],
    });

    const res = await analytics(
      new NextRequest("http://localhost/api/analytics?days=30"),
    );
    const body = await res.json();
    // 200 g of $25/kg → $5.00.
    expect(body.totals.cost).toBeCloseTo(5.0, 2);
  });

  // ---------------------------------------------------------------------
  // 3. restore refuses orphan
  // ---------------------------------------------------------------------

  async function softDelete(id: string) {
    const req = new NextRequest(`http://localhost/api/filaments/${id}`, {
      method: "DELETE",
    });
    return deleteFilament(req, { params: Promise.resolve({ id }) });
  }

  it("restore refuses to revive a variant whose parent is still trashed", async () => {
    const parent = await Filament.create({
      name: "Orphan-Parent",
      vendor: "V",
      type: "PLA",
    });
    const variant = await Filament.create({
      name: "Orphan-Variant",
      vendor: "V",
      type: "PLA",
      color: "#abcdef",
      parentId: parent._id,
    });

    // Soft-delete both. The current soft-delete handler refuses to delete
    // a parent that still has *active* variants, but variants in trash
    // don't count — so this two-step delete is allowed.
    await softDelete(String(variant._id));
    await softDelete(String(parent._id));

    // Attempt to restore the variant only.
    const req = new NextRequest(
      `http://localhost/api/filaments/${variant._id}/restore`,
      { method: "POST" },
    );
    const res = await restoreFilament(req, {
      params: Promise.resolve({ id: String(variant._id) }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/parent.*trash|Restore the parent first/i);

    // The variant should still be in the trash (not flipped to active).
    const stillTrashed = await Filament.findOne({
      _id: variant._id,
      _deletedAt: { $ne: null },
    }).lean();
    expect(stillTrashed).not.toBeNull();
  });

  it("restore succeeds after the parent has been restored first", async () => {
    const parent = await Filament.create({
      name: "Orphan2-Parent",
      vendor: "V",
      type: "PLA",
    });
    const variant = await Filament.create({
      name: "Orphan2-Variant",
      vendor: "V",
      type: "PLA",
      color: "#123456",
      parentId: parent._id,
    });

    await softDelete(String(variant._id));
    await softDelete(String(parent._id));

    // Restore parent first.
    await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${parent._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(parent._id) }) },
    );

    // Now the variant restore should succeed.
    const res = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${variant._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(variant._id) }) },
    );
    expect(res.status).toBe(200);
    const variantNow = await Filament.findOne({
      _id: variant._id,
      _deletedAt: null,
    }).lean();
    expect(variantNow).not.toBeNull();
  });
});
