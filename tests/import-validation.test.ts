import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { parseCsv } from "@/lib/parseCsv";
import { POST as importIni } from "@/app/api/filaments/import/route";
import { POST as importCsv } from "@/app/api/filaments/import-csv/route";
import { POST as prusamentImport } from "@/app/api/prusament/import/route";

/**
 * Code-review issues #296, #297, #307, #309 — import-path validation
 * and security. (#308 / #276 are one-line `runValidators` additions on
 * existing update calls, the pattern already covered by #228.)
 */
describe("import validation & security", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function multipartReq(url: string, file: File) {
    const fd = new FormData();
    fd.append("file", file);
    return new NextRequest(url, { method: "POST", body: fd });
  }

  // ── #296: parseCsv prototype pollution ─────────────────────────────

  describe("#296 — parseCsv handles a __proto__ header safely", () => {
    it("keeps a __proto__ column as own data, does not pollute the prototype", () => {
      const rows = parseCsv("name,__proto__\nfoo,evil\n", { header: true }) as Record<
        string,
        string
      >[];
      expect(rows).toHaveLength(1);
      // The column's data survives as an OWN property...
      expect(Object.prototype.hasOwnProperty.call(rows[0], "__proto__")).toBe(true);
      expect(rows[0]["__proto__"]).toBe("evil");
      expect(rows[0].name).toBe("foo");
      // ...and the global Object prototype is untouched.
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });

    it("keeps a constructor-named column as own data", () => {
      const rows = parseCsv("constructor,name\nx,foo\n", { header: true }) as Record<
        string,
        string
      >[];
      expect(rows[0].constructor).toBe("x");
      expect(rows[0].name).toBe("foo");
    });
  });

  // ── #297: INI import resurrects a trashed filament ─────────────────

  describe("#297 — INI import doesn't strand a trashed filament", () => {
    it("resurrects a trashed filament instead of creating a duplicate", async () => {
      // A filament named "Galaxy Black" is in the trash.
      const trashed = await Filament.create({
        name: "Galaxy Black",
        vendor: "Prusament",
        type: "PLA",
        _deletedAt: new Date(),
      });

      const ini =
        "[filament:Galaxy Black]\nfilament_vendor = Prusament\nfilament_type = PLA\n";
      const res = await importIni(
        multipartReq(
          "http://localhost/api/filaments/import",
          new File([ini], "b.ini", { type: "text/plain" }),
        ),
      );
      expect(res.status).toBe(200);

      // No second active row was created — the trashed one was revived.
      const active = await Filament.find({
        name: "Galaxy Black",
        _deletedAt: null,
      }).lean();
      expect(active).toHaveLength(1);
      expect(String(active[0]._id)).toBe(String(trashed._id));
    });
  });

  // ── #307: prusament import validates the spool payload ─────────────

  describe("#307 — prusament import validates the spool shape", () => {
    function prusamentReq(spool: unknown) {
      return new NextRequest("http://localhost/api/prusament/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spool, action: "create" }),
      });
    }
    const validSpool = {
      spoolId: "SP-1",
      material: "PLA",
      colorName: "Galaxy Black",
      colorHex: "#1a1a1a",
      diameter: 1.75,
      lengthMeters: 330,
      netWeight: 1000,
      totalWeight: 1250,
      spoolWeight: 250,
      manufactureDate: "2026-01-01 12:00",
      nozzleTempMin: 215,
      nozzleTempMax: 230,
      bedTempMin: 50,
      bedTempMax: 60,
      priceUsd: 29.99,
      pageUrl: "https://prusament.com/x",
    };

    it("rejects a non-numeric totalWeight with 400", async () => {
      const res = await prusamentImport(
        prusamentReq({ ...validSpool, totalWeight: "heavy" }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/totalWeight/);
    });

    it("rejects a malformed colorHex with 400", async () => {
      const res = await prusamentImport(
        prusamentReq({ ...validSpool, colorHex: "not-a-color" }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/colorHex/);
    });

    it("accepts a well-formed spool", async () => {
      const res = await prusamentImport(prusamentReq(validSpool));
      expect(res.status).toBe(201);
    });
  });

  // ── #309: import-csv strips a UTF-8 BOM ────────────────────────────

  it("#309 — import-csv accepts an Excel CSV that begins with a UTF-8 BOM", async () => {
    // U+FEFF is the BOM Excel prepends. Pre-fix the first header cell
    // became "<BOM>Name", failed HEADER_MAP, and the import was
    // rejected as missing required columns.
    const csv = "\uFEFF" + "Name,Vendor,Type\nBOM PLA,TestCo,PLA\n";
    const res = await importCsv(
      multipartReq(
        "http://localhost/api/filaments/import-csv",
        new File([csv], "excel.csv", { type: "text/csv" }),
      ),
    );
    expect(res.status).toBe(200);
    const created = await Filament.findOne({ name: "BOM PLA" }).lean();
    expect(created).not.toBeNull();
    expect(created.vendor).toBe("TestCo");
  });
});
