import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { GET as listColors } from "@/app/api/filaments/colors/route";

/**
 * `/api/filaments/colors` feeds the colorName typeahead in
 * FilamentForm. The contract: distinct (colorName, color) pairs from
 * non-deleted filaments, sorted alphabetically, with empty/null
 * names filtered out. Multiple filaments sharing one name+hex collapse
 * to one entry; different hexes under the same name stay separate.
 */
describe("GET /api/filaments/colors", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("returns distinct (colorName, color) pairs, alphabetically sorted", async () => {
    await Filament.create({
      name: "A",
      vendor: "v",
      type: "PLA",
      color: "#FA6E1C",
      colorName: "Prusa Orange",
    });
    await Filament.create({
      name: "B",
      vendor: "v",
      type: "PLA",
      color: "#0D0D14",
      colorName: "Galaxy Black",
    });
    await Filament.create({
      name: "C",
      vendor: "v",
      type: "PLA",
      color: "#FA6E1C",
      colorName: "Prusa Orange", // duplicate of A — should collapse
    });

    const res = await listColors();
    const body = (await res.json()) as Array<{ name: string; hex: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({ name: "Galaxy Black", hex: "#0D0D14" });
    expect(body[1]).toEqual({ name: "Prusa Orange", hex: "#FA6E1C" });
  });

  it("keeps different hexes under the same name as separate rows", async () => {
    await Filament.create({
      name: "A",
      vendor: "v",
      type: "PLA",
      color: "#0D0D14",
      colorName: "Galaxy Black",
    });
    await Filament.create({
      name: "B",
      vendor: "v",
      type: "PLA",
      color: "#1A1A2E",
      colorName: "Galaxy Black",
    });

    const res = await listColors();
    const body = (await res.json()) as Array<{ name: string; hex: string }>;
    const galaxy = body.filter((r) => r.name === "Galaxy Black");
    expect(galaxy.length).toBe(2);
    expect(galaxy.map((g) => g.hex).sort()).toEqual(["#0D0D14", "#1A1A2E"]);
  });

  it("filters out rows with null/empty colorName", async () => {
    await Filament.create({
      name: "Named",
      vendor: "v",
      type: "PLA",
      color: "#FFFFFF",
      colorName: "Pearl",
    });
    await Filament.create({
      name: "Unnamed",
      vendor: "v",
      type: "PLA",
      color: "#000000",
      // colorName intentionally omitted — defaults to null per the schema
    });
    await Filament.create({
      name: "Blank-Named",
      vendor: "v",
      type: "PLA",
      color: "#888888",
      colorName: "",
    });

    const res = await listColors();
    const body = (await res.json()) as Array<{ name: string; hex: string }>;
    expect(body).toEqual([{ name: "Pearl", hex: "#FFFFFF" }]);
  });

  it("ignores soft-deleted filaments", async () => {
    await Filament.create({
      name: "Live",
      vendor: "v",
      type: "PLA",
      color: "#FFFFFF",
      colorName: "Snow",
    });
    await Filament.create({
      name: "Trashed",
      vendor: "v",
      type: "PLA",
      color: "#000000",
      colorName: "Coal",
      _deletedAt: new Date(),
    });

    const res = await listColors();
    const body = (await res.json()) as Array<{ name: string; hex: string }>;
    expect(body).toEqual([{ name: "Snow", hex: "#FFFFFF" }]);
  });
});
