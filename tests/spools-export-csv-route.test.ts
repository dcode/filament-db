import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { GET } from "@/app/api/spools/export-csv/route";

/**
 * Route test for GET /api/spools/export-csv (GH #139). Previously uncovered.
 * Emits one CSV row per spool with a round-trippable header. Verifies the
 * download headers, the header line, and one data row per seeded spool.
 */
describe("GET /api/spools/export-csv", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("emits a CSV with the header plus one row per spool", async () => {
    await Filament.create({
      name: "Galaxy Black",
      vendor: "Prusa",
      type: "PETG",
      spools: [{ totalWeight: 1000 }, { totalWeight: 750 }],
    });

    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("spools.csv");

    const csv = await res.text();
    const lines = csv.split("\n");
    expect(lines[0].toLowerCase()).toContain("filament");
    // header + two spool rows
    expect(lines.length).toBe(3);
    expect(csv).toContain("Galaxy Black");
  });

  it("emits header-only CSV when there are no spools", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const csv = await res.text();
    expect(csv.split("\n").length).toBe(1); // header only, no data rows
  });
});
