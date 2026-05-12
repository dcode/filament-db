import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import {
  findNozzleConflicts,
  nextCloneName,
} from "@/lib/nozzleConflicts";
import { PUT as putPrinter } from "@/app/api/printers/[id]/route";
import { POST as postPrinter } from "@/app/api/printers/route";
import { POST as cloneNozzle } from "@/app/api/nozzles/[id]/clone/route";

/**
 * GH #232 — physical-instance enforcement for nozzles installed in
 * printers. Three layers of coverage:
 *
 *   1. Helper: findNozzleConflicts + nextCloneName as pure functions
 *      against the real models.
 *   2. API enforcement: PUT/POST /api/printers refuses with 409 when an
 *      incoming installedNozzles ref is already in another printer.
 *      Response carries the `conflicts[]` payload the PrinterForm
 *      consumes for the move/clone modal.
 *   3. Clone endpoint: POST /api/nozzles/{id}/clone mints a new row
 *      with a "Name #N" suffix and identical spec fields.
 */
describe("GH #232 — nozzle physical-instance enforcement", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Nozzle: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Printer: any;

  beforeEach(async () => {
    const nozzleMod = await import("@/models/Nozzle");
    const printerMod = await import("@/models/Printer");
    if (!mongoose.models.Nozzle) {
      mongoose.model("Nozzle", nozzleMod.default.schema);
    }
    if (!mongoose.models.Printer) {
      mongoose.model("Printer", printerMod.default.schema);
    }
    Nozzle = mongoose.models.Nozzle;
    Printer = mongoose.models.Printer;
  });

  // ---------------------------------------------------------------------
  // Helper: nextCloneName
  // ---------------------------------------------------------------------

  describe("nextCloneName", () => {
    it("picks #2 when no clones exist", () => {
      expect(nextCloneName("0.4mm", ["0.4mm"])).toBe("0.4mm #2");
    });
    it("picks the next available when clones already exist", () => {
      expect(
        nextCloneName("0.4mm", ["0.4mm", "0.4mm #2", "0.4mm #3"]),
      ).toBe("0.4mm #4");
    });
    it("treats non-suffixed peers as #1 (the original)", () => {
      expect(nextCloneName("0.4mm", ["0.4mm Diamondback"])).toBe("0.4mm #2");
    });
    it("ignores names that just happen to start with the same prefix", () => {
      // "0.4mm HF" starts with "0.4mm " but isn't a clone of "0.4mm".
      // The trailing "#N" suffix is required to bump the counter.
      expect(nextCloneName("0.4mm", ["0.4mm", "0.4mm HF"])).toBe("0.4mm #2");
    });
  });

  // ---------------------------------------------------------------------
  // Helper: findNozzleConflicts
  // ---------------------------------------------------------------------

  describe("findNozzleConflicts", () => {
    it("returns empty when no other printer claims the nozzles", async () => {
      const n = await Nozzle.create({
        name: "0.4mm",
        diameter: 0.4,
        type: "Brass",
      });
      const conflicts = await findNozzleConflicts(
        Printer,
        Nozzle,
        [n._id],
        null,
      );
      expect(conflicts).toEqual([]);
    });

    it("finds a conflict when another printer has the nozzle", async () => {
      const n = await Nozzle.create({
        name: "0.4mm Diamondback",
        diameter: 0.4,
        type: "Diamondback",
      });
      const owner = await Printer.create({
        name: "Prusa Core One",
        manufacturer: "Prusa",
        printerModel: "Core One",
        installedNozzles: [n._id],
      });
      const conflicts = await findNozzleConflicts(
        Printer,
        Nozzle,
        [n._id],
        null,
      );
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0].nozzleId).toBe(String(n._id));
      expect(conflicts[0].nozzleName).toBe("0.4mm Diamondback");
      expect(conflicts[0].otherPrinterId).toBe(String(owner._id));
      expect(conflicts[0].otherPrinterName).toBe("Prusa Core One");
    });

    it("excludes the current printer from the conflict scan", async () => {
      // A PUT that re-saves an existing assignment shouldn't trip the
      // check on its own current ref.
      const n = await Nozzle.create({
        name: "0.6mm",
        diameter: 0.6,
        type: "Brass",
      });
      const me = await Printer.create({
        name: "Solo Printer",
        manufacturer: "X",
        printerModel: "Y",
        installedNozzles: [n._id],
      });
      const conflicts = await findNozzleConflicts(
        Printer,
        Nozzle,
        [n._id],
        me._id,
      );
      expect(conflicts).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------
  // API enforcement: PUT /api/printers/{id}
  // ---------------------------------------------------------------------

  describe("PUT /api/printers/{id} refuses 409 on nozzle conflict", () => {
    it("returns 409 with structured conflicts when the nozzle is already in another printer", async () => {
      const n = await Nozzle.create({
        name: "0.4mm",
        diameter: 0.4,
        type: "Diamondback",
      });
      const printerA = await Printer.create({
        name: "Printer A",
        manufacturer: "X",
        printerModel: "Y",
        installedNozzles: [n._id],
      });
      const printerB = await Printer.create({
        name: "Printer B",
        manufacturer: "X",
        printerModel: "Z",
        installedNozzles: [],
      });

      const res = await putPrinter(
        new NextRequest(`http://localhost/api/printers/${printerB._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Printer B",
            manufacturer: "X",
            printerModel: "Z",
            installedNozzles: [String(n._id)],
          }),
        }),
        { params: Promise.resolve({ id: String(printerB._id) }) },
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error).toMatch(/already installed/i);
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0]).toMatchObject({
        nozzleId: String(n._id),
        nozzleName: "0.4mm",
        otherPrinterId: String(printerA._id),
        otherPrinterName: "Printer A",
      });

      // Printer A's installedNozzles is unchanged — no implicit
      // server-side migration. The client is responsible for picking
      // move vs clone explicitly.
      const aFresh = await Printer.findById(printerA._id).lean();
      expect(aFresh.installedNozzles.map(String)).toEqual([String(n._id)]);
    });

    it("PUT succeeds when the nozzle was already on this printer (no false-positive on re-save)", async () => {
      const n = await Nozzle.create({
        name: "0.4mm",
        diameter: 0.4,
        type: "Brass",
      });
      const printer = await Printer.create({
        name: "Re-save",
        manufacturer: "X",
        printerModel: "Y",
        installedNozzles: [n._id],
      });
      const res = await putPrinter(
        new NextRequest(`http://localhost/api/printers/${printer._id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Re-save (renamed)",
            manufacturer: "X",
            printerModel: "Y",
            installedNozzles: [String(n._id)],
          }),
        }),
        { params: Promise.resolve({ id: String(printer._id) }) },
      );
      expect(res.status).toBe(200);
      const fresh = await Printer.findById(printer._id).lean();
      expect(fresh.name).toBe("Re-save (renamed)");
    });
  });

  // ---------------------------------------------------------------------
  // API enforcement: POST /api/printers
  // ---------------------------------------------------------------------

  describe("POST /api/printers refuses 409 on nozzle conflict", () => {
    it("create with an already-claimed nozzle → 409", async () => {
      const n = await Nozzle.create({
        name: "0.6mm HF",
        diameter: 0.6,
        type: "ObXidian",
        highFlow: true,
      });
      await Printer.create({
        name: "Existing Owner",
        manufacturer: "X",
        printerModel: "Y",
        installedNozzles: [n._id],
      });
      const res = await postPrinter(
        new NextRequest("http://localhost/api/printers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Newcomer",
            manufacturer: "X",
            printerModel: "Z",
            installedNozzles: [String(n._id)],
          }),
        }),
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.conflicts).toHaveLength(1);
      expect(body.conflicts[0].otherPrinterName).toBe("Existing Owner");

      // No printer was created. Walk the collection to be sure.
      const newcomers = await Printer.find({ name: "Newcomer" }).lean();
      expect(newcomers).toHaveLength(0);
    });

    it("create with a free nozzle → 201", async () => {
      const n = await Nozzle.create({
        name: "0.25mm",
        diameter: 0.25,
        type: "Brass",
      });
      const res = await postPrinter(
        new NextRequest("http://localhost/api/printers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Fresh Printer",
            manufacturer: "X",
            printerModel: "Y",
            installedNozzles: [String(n._id)],
          }),
        }),
      );
      expect(res.status).toBe(201);
    });
  });

  // ---------------------------------------------------------------------
  // Clone endpoint
  // ---------------------------------------------------------------------

  describe("POST /api/nozzles/{id}/clone", () => {
    it("mints a clone with the next available '#N' suffix and identical spec fields", async () => {
      const source = await Nozzle.create({
        name: "0.4mm Diamondback",
        diameter: 0.4,
        type: "Diamondback",
        highFlow: false,
        hardened: true,
        notes: "Initial",
      });
      const res = await cloneNozzle(
        new NextRequest(
          `http://localhost/api/nozzles/${source._id}/clone`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id: String(source._id) }) },
      );
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body.name).toBe("0.4mm Diamondback #2");
      expect(body.diameter).toBe(0.4);
      expect(body.type).toBe("Diamondback");
      expect(body.hardened).toBe(true);
      expect(body.highFlow).toBe(false);
      expect(body.notes).toBe("Initial");
      expect(body._id).not.toBe(String(source._id));
    });

    it("picks #3 when #2 already exists", async () => {
      const source = await Nozzle.create({
        name: "0.4mm",
        diameter: 0.4,
        type: "Brass",
      });
      await Nozzle.create({ name: "0.4mm #2", diameter: 0.4, type: "Brass" });
      const res = await cloneNozzle(
        new NextRequest(
          `http://localhost/api/nozzles/${source._id}/clone`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id: String(source._id) }) },
      );
      const body = await res.json();
      expect(body.name).toBe("0.4mm #3");
    });

    it("404 when the source nozzle doesn't exist", async () => {
      const fakeId = new mongoose.Types.ObjectId().toString();
      const res = await cloneNozzle(
        new NextRequest(
          `http://localhost/api/nozzles/${fakeId}/clone`,
          { method: "POST" },
        ),
        { params: Promise.resolve({ id: fakeId }) },
      );
      expect(res.status).toBe(404);
    });
  });
});
