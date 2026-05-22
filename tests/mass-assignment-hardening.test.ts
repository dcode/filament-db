import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { PUT, DELETE } from "@/app/api/filaments/[id]/route";

/**
 * Security batch B — mass-assignment / data-integrity hardening.
 *   #260 — PUT /api/filaments/{id} must not write the `spools` array.
 *   #261 — deleting a filament must clear its spools from printer slots.
 */
describe("mass-assignment & data-integrity hardening", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let Filament: any;
  let Printer: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeEach(async () => {
    const filMod = await import("@/models/Filament");
    const prtMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Filament) mongoose.model("Filament", filMod.default.schema);
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", prtMod.default.schema);
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    Filament = mongoose.models.Filament;
    Printer = mongoose.models.Printer;
  });

  function jsonReq(url: string, body: unknown, method: string) {
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── #260: PUT must not mass-assign the spools array ─────────────────

  it("#260 — PUT /api/filaments/{id} ignores a spools array in the body", async () => {
    const f = await Filament.create({
      name: "PUT Guard PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Original", totalWeight: 1000 }],
    });
    const spoolId = String(f.spools[0]._id);

    const res = await PUT(
      jsonReq(
        `http://localhost/api/filaments/${f._id}`,
        {
          name: "PUT Guard PLA",
          vendor: "T",
          type: "PLA",
          // Attempt to rewrite the spool ledger via the filament PUT.
          spools: [
            {
              _id: spoolId,
              label: "HACKED",
              totalWeight: 5,
              usageHistory: [{ grams: 999, jobLabel: "fabricated", source: "manual" }],
            },
          ],
        },
        "PUT",
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    // The spool is untouched — the PUT stripped `spools`.
    const fresh = await Filament.findById(f._id);
    expect(fresh.spools).toHaveLength(1);
    expect(fresh.spools[0].label).toBe("Original");
    expect(fresh.spools[0].totalWeight).toBe(1000);
    expect(fresh.spools[0].usageHistory ?? []).toHaveLength(0);
  });

  // ── #261: deleting a filament clears its spools from printer slots ──

  it("#261 — soft-deleting a filament clears its spools from printer AMS slots", async () => {
    const f = await Filament.create({
      name: "Slot Owner PLA",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Loaded", totalWeight: 1000 }],
    });
    const spoolId = String(f.spools[0]._id);
    const printer = await Printer.create({
      name: "MK4-A",
      manufacturer: "Prusa",
      printerModel: "MK4",
      amsSlots: [{ slotName: "Slot 1", spoolId }],
    });

    const res = await DELETE(
      new NextRequest(`http://localhost/api/filaments/${f._id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    const freshPrinter = await Printer.findById(printer._id);
    expect(freshPrinter.amsSlots[0].spoolId).toBeNull();
  });

  it("#261 — permanently deleting a trashed filament clears its slot refs", async () => {
    // A filament already in the trash, with a spool still loaded in a
    // slot (the pre-fix orphan state).
    const f = await Filament.create({
      name: "Trashed Slot Owner",
      vendor: "T",
      type: "PLA",
      spools: [{ label: "Loaded", totalWeight: 1000 }],
      _deletedAt: new Date(),
    });
    const spoolId = String(f.spools[0]._id);
    const printer = await Printer.create({
      name: "MK4-B",
      manufacturer: "Prusa",
      printerModel: "MK4",
      amsSlots: [{ slotName: "Slot 1", spoolId }],
    });

    const res = await DELETE(
      new NextRequest(
        `http://localhost/api/filaments/${f._id}?permanent=true`,
        { method: "DELETE" },
      ),
      { params: Promise.resolve({ id: String(f._id) }) },
    );
    expect(res.status).toBe(200);

    const freshPrinter = await Printer.findById(printer._id);
    expect(freshPrinter.amsSlots[0].spoolId).toBeNull();
  });
});
