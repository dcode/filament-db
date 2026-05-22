import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { POST as createPrinter } from "@/app/api/printers/route";
import { PUT as updatePrinter, GET as getPrinter } from "@/app/api/printers/[id]/route";
import { GET as listBedTypes } from "@/app/api/bed-types/route";

/**
 * Bed types attached to printers (shared-catalog model).
 *
 * `Printer.installedBedTypes[]` references the BedType catalog. Unlike
 * `installedNozzles` (physical instances — one nozzle, one printer,
 * enforced since #232), a bed type is a surface spec that many printers
 * can share. So:
 *   - the printer routes validate that bed-type ids EXIST (no conflict
 *     detection, no clone-on-conflict);
 *   - the same bed type can sit on multiple printers at once;
 *   - the /api/bed-types GET enriches each row with the printers that
 *     reference it (mirrors the nozzle list's "Installed In").
 */
describe("printer ↔ bed-type association", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let BedType: any;

  beforeEach(async () => {
    const printerMod = await import("@/models/Printer");
    const bedMod = await import("@/models/BedType");
    if (!mongoose.models.Printer) mongoose.model("Printer", printerMod.default.schema);
    if (!mongoose.models.BedType) mongoose.model("BedType", bedMod.default.schema);
    // The printer routes also touch Nozzle (conflict scan) — register it
    // so the shared route code doesn't trip on a missing model.
    const nozMod = await import("@/models/Nozzle");
    if (!mongoose.models.Nozzle) mongoose.model("Nozzle", nozMod.default.schema);
    Printer = mongoose.models.Printer;
    BedType = mongoose.models.BedType;
  });

  function postPrinter(body: unknown) {
    return new NextRequest("http://localhost/api/printers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  function putPrinter(id: string, body: unknown) {
    return new NextRequest(`http://localhost/api/printers/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  // ── model field ───────────────────────────────────────────────────

  it("Printer schema persists installedBedTypes refs", async () => {
    const bed = await BedType.create({ name: "Textured PEI", material: "PEI" });
    const printer = await Printer.create({
      name: "Core One",
      manufacturer: "Prusa",
      printerModel: "Core One",
      installedBedTypes: [bed._id],
    });
    const fresh = await Printer.findById(printer._id).lean();
    expect(fresh.installedBedTypes.map(String)).toEqual([String(bed._id)]);
  });

  // ── POST validation ───────────────────────────────────────────────

  it("POST /api/printers accepts valid bed-type refs", async () => {
    const bedA = await BedType.create({ name: "Smooth PEI", material: "PEI" });
    const bedB = await BedType.create({ name: "Satin", material: "Powder-coated" });
    const res = await createPrinter(
      postPrinter({
        name: "P1",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [String(bedA._id), String(bedB._id)],
      }),
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.installedBedTypes.map(String).sort()).toEqual(
      [String(bedA._id), String(bedB._id)].sort(),
    );
  });

  it("POST /api/printers rejects a non-existent bed-type ref with 400", async () => {
    const ghost = new mongoose.Types.ObjectId().toString();
    const res = await createPrinter(
      postPrinter({
        name: "P-bad",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [ghost],
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/bed type/i);
    // No printer was created.
    expect(await Printer.countDocuments({ name: "P-bad" })).toBe(0);
  });

  // ── shared across printers — NOT a conflict ───────────────────────

  it("the same bed type can be installed on multiple printers (no conflict)", async () => {
    const bed = await BedType.create({ name: "Textured PEI", material: "PEI" });
    const a = await createPrinter(
      postPrinter({
        name: "Core One",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [String(bed._id)],
      }),
    );
    expect(a.status).toBe(201);
    // Second printer claiming the SAME bed type — must succeed (201),
    // unlike nozzles which would 409.
    const b = await createPrinter(
      postPrinter({
        name: "H2D",
        manufacturer: "Bambu",
        printerModel: "H2D",
        installedBedTypes: [String(bed._id)],
      }),
    );
    expect(b.status).toBe(201);
  });

  // ── PUT validation + round-trip ───────────────────────────────────

  it("PUT /api/printers/{id} updates installedBedTypes and GET returns them populated", async () => {
    const bed = await BedType.create({ name: "Cool Plate", material: "Glass" });
    const printer = await Printer.create({
      name: "Editable",
      manufacturer: "Prusa",
      printerModel: "Core One",
      installedBedTypes: [],
    });
    const putRes = await updatePrinter(
      putPrinter(String(printer._id), {
        name: "Editable",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [String(bed._id)],
      }),
      { params: Promise.resolve({ id: String(printer._id) }) },
    );
    expect(putRes.status).toBe(200);

    const getRes = await getPrinter(
      new NextRequest(`http://localhost/api/printers/${printer._id}`),
      { params: Promise.resolve({ id: String(printer._id) }) },
    );
    const got = await getRes.json();
    // installedBedTypes is populated — entries are full BedType docs.
    expect(got.installedBedTypes).toHaveLength(1);
    expect(got.installedBedTypes[0].name).toBe("Cool Plate");
  });

  it("PUT /api/printers/{id} rejects a non-existent bed-type ref with 400", async () => {
    const printer = await Printer.create({
      name: "PUT-bad",
      manufacturer: "Prusa",
      printerModel: "Core One",
    });
    const ghost = new mongoose.Types.ObjectId().toString();
    const res = await updatePrinter(
      putPrinter(String(printer._id), {
        name: "PUT-bad",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedBedTypes: [ghost],
      }),
      { params: Promise.resolve({ id: String(printer._id) }) },
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/bed type/i);
  });

  // ── bed-types GET enrichment ──────────────────────────────────────

  it("GET /api/bed-types attaches the printers each bed type is available on", async () => {
    const shared = await BedType.create({ name: "Textured PEI", material: "PEI" });
    const lonely = await BedType.create({ name: "Garolite", material: "G10" });

    await Printer.create({
      name: "Printer A",
      manufacturer: "Prusa",
      printerModel: "Core One",
      installedBedTypes: [shared._id],
    });
    await Printer.create({
      name: "Printer B",
      manufacturer: "Bambu",
      printerModel: "H2D",
      installedBedTypes: [shared._id],
    });

    const res = await listBedTypes(new NextRequest("http://localhost/api/bed-types"));
    expect(res.status).toBe(200);
    const body = await res.json();

    const sharedRow = body.find((b: { _id: string }) => b._id === String(shared._id));
    const lonelyRow = body.find((b: { _id: string }) => b._id === String(lonely._id));

    // The shared bed type lists both printers; the unused one lists none.
    expect(sharedRow.printers.map((p: { name: string }) => p.name).sort()).toEqual([
      "Printer A",
      "Printer B",
    ]);
    expect(lonelyRow.printers).toEqual([]);
  });
});
