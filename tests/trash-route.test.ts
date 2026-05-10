import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as listTrash } from "@/app/api/filaments/trash/route";
import { POST as restoreFilament } from "@/app/api/filaments/[id]/restore/route";
import { DELETE as deleteFilament } from "@/app/api/filaments/[id]/route";

/**
 * Coverage for the v1.14+ trash workflow:
 *   1. soft-deleted filaments appear in /api/filaments/trash
 *   2. restoring a trashed filament makes it visible again, unless
 *      another active filament has reused its name (409)
 *   3. permanent delete works only on already-trashed docs and refuses
 *      to orphan trashed variants
 */
describe("Filament trash workflow", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  async function softDelete(id: string) {
    const req = new NextRequest(`http://localhost/api/filaments/${id}`, {
      method: "DELETE",
    });
    return deleteFilament(req, { params: Promise.resolve({ id }) });
  }

  async function permanentDelete(id: string) {
    const req = new NextRequest(
      `http://localhost/api/filaments/${id}?permanent=true`,
      { method: "DELETE" },
    );
    return deleteFilament(req, { params: Promise.resolve({ id }) });
  }

  it("GET /trash returns soft-deleted filaments, sorted newest first", async () => {
    const a = await Filament.create({ name: "Trashed A", vendor: "T", type: "PLA" });
    const b = await Filament.create({ name: "Active", vendor: "T", type: "PLA" });
    const c = await Filament.create({ name: "Trashed C", vendor: "T", type: "PLA" });

    // Trash A first, then C, so C appears first in the result.
    await softDelete(String(a._id));
    await new Promise((r) => setTimeout(r, 5)); // ensure distinct timestamps
    await softDelete(String(c._id));

    const res = await listTrash();
    const items = await res.json();
    expect(items).toHaveLength(2);
    expect(items[0].name).toBe("Trashed C");
    expect(items[1].name).toBe("Trashed A");
    // The active filament is not in trash
    expect(items.some((i: { _id: string }) => i._id === String(b._id))).toBe(false);
  });

  it("restore brings a trashed filament back, then it disappears from /trash", async () => {
    const f = await Filament.create({
      name: "Restore me",
      vendor: "T",
      type: "PLA",
    });
    await softDelete(String(f._id));

    const restoreRes = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${f._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(restoreRes.status).toBe(200);

    const trashListRes = await listTrash();
    const trashList = await trashListRes.json();
    expect(trashList).toHaveLength(0);

    const live = await Filament.findById(f._id);
    expect(live._deletedAt).toBeNull();
  });

  it("restore refuses with 409 when an active filament has reused the name", async () => {
    const f = await Filament.create({
      name: "Reused name",
      vendor: "T",
      type: "PLA",
    });
    await softDelete(String(f._id));
    // User created a new filament with the same name while the old was trashed
    await Filament.create({ name: "Reused name", vendor: "T", type: "PLA" });

    const restoreRes = await restoreFilament(
      new NextRequest(`http://localhost/api/filaments/${f._id}/restore`, {
        method: "POST",
      }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(restoreRes.status).toBe(409);
    const body = await restoreRes.json();
    expect(body.error).toMatch(/already exists/i);

    // The trashed one stays trashed
    const stillTrashed = await Filament.findById(f._id);
    expect(stillTrashed._deletedAt).not.toBeNull();
  });

  it("permanent delete only works on trashed filaments", async () => {
    const live = await Filament.create({
      name: "Still active",
      vendor: "T",
      type: "PLA",
    });
    const res = await permanentDelete(String(live._id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/in the trash/i);

    // Soft-delete it first, then permanent works
    await softDelete(String(live._id));
    const ok = await permanentDelete(String(live._id));
    expect(ok.status).toBe(200);

    const gone = await Filament.findById(live._id);
    expect(gone).toBeNull();
  });

  it("permanent delete of a parent refuses if trashed variants point at it", async () => {
    const parent = await Filament.create({
      name: "PLA Basic",
      vendor: "T",
      type: "PLA",
    });
    const variant = await Filament.create({
      name: "PLA Basic Black",
      vendor: "T",
      type: "PLA",
      parentId: parent._id,
    });

    // Soft-delete the variant first (the constraint blocks parent-with-active-
    // variants soft delete), then trash the parent.
    await softDelete(String(variant._id));
    await softDelete(String(parent._id));

    // Permanently deleting the parent while the variant is also trashed
    // would orphan the variant — the route should refuse.
    const res = await permanentDelete(String(parent._id));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/variants in the trash/i);

    // Permanently delete the variant first → parent purge then succeeds
    const variantPurge = await permanentDelete(String(variant._id));
    expect(variantPurge.status).toBe(200);
    const parentPurge = await permanentDelete(String(parent._id));
    expect(parentPurge.status).toBe(200);
  });
});
