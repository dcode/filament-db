import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createFilament } from "@/app/api/filaments/route";
import { PUT as updateFilament } from "@/app/api/filaments/[id]/route";

/**
 * Regression test for GH #222 (P1 security):
 *
 * `_purged` is a sync-engine tombstone — set it on a document and the
 * hybrid-sync engine treats the doc as permanently deleted on the next
 * cycle and propagates the purge to the peer DB. There is **no** UI
 * surface to undo a `_purged: true` row, so it must never be set from a
 * client request body.
 *
 * Before the fix, a caller could send `{ "_purged": true }` in a regular
 * POST or PUT body and the flag would persist on the document — without
 * going through trash → permanent-delete, and without the document
 * appearing in any list/get response. Across a sync pair this becomes a
 * one-shot remote-purge gadget.
 *
 * These tests assert the strip lives in both the POST and PUT handlers
 * for `/api/filaments` and `/api/filaments/{id}` respectively.
 */
describe("GH #222 — filament routes strip `_purged` from request bodies", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function postBody(body: unknown) {
    return new NextRequest("http://localhost/api/filaments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function putBody(id: string, body: unknown) {
    return new NextRequest(`http://localhost/api/filaments/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("POST /api/filaments ignores client-supplied `_purged: true`", async () => {
    const res = await createFilament(
      postBody({
        name: "Tombstone-Bait-POST",
        vendor: "V",
        type: "PLA",
        _purged: true, // attacker-supplied flag — must be ignored
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body._purged).toBeFalsy();

    // Read straight from the collection — make sure the strip happened
    // before persistence, not just on the response projection.
    const doc = await Filament.findById(body._id).lean();
    expect(doc._purged).toBeFalsy();
  });

  it("PUT /api/filaments/{id} ignores client-supplied `_purged: true`", async () => {
    const created = await Filament.create({
      name: "Tombstone-Bait-PUT",
      vendor: "V",
      type: "PLA",
    });

    const res = await updateFilament(
      putBody(String(created._id), {
        name: "Tombstone-Bait-PUT",
        vendor: "V",
        type: "PLA",
        _purged: true, // attacker-supplied flag — must be ignored
      }),
      { params: Promise.resolve({ id: String(created._id) }) },
    );
    expect(res.status).toBe(200);

    // Read straight from the collection — what matters is what got
    // persisted, not what's echoed back.
    const doc = await Filament.findById(created._id).lean();
    expect(doc._purged).toBeFalsy();

    // And the row is still visible in the active list filter.
    const active = await Filament.findOne({ _id: created._id, _deletedAt: null }).lean();
    expect(active).not.toBeNull();
  });

  it("PUT /api/filaments/{id} still ignores `_deletedAt` (pre-existing strip — regression cover)", async () => {
    const created = await Filament.create({
      name: "Tombstone-Bait-PUT-2",
      vendor: "V",
      type: "PLA",
    });

    await updateFilament(
      putBody(String(created._id), {
        name: "Tombstone-Bait-PUT-2",
        vendor: "V",
        type: "PLA",
        _deletedAt: new Date("2020-01-01"),
      }),
      { params: Promise.resolve({ id: String(created._id) }) },
    );

    const doc = await Filament.findById(created._id).lean();
    expect(doc._deletedAt).toBeNull();
  });
});
