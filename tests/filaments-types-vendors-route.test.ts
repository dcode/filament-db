import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { GET as getTypes } from "@/app/api/filaments/types/route";
import { GET as getVendors } from "@/app/api/filaments/vendors/route";

/**
 * Route tests for the two distinct-list endpoints that feed the home-page
 * type/vendor filter chips. Previously uncovered. Contract: distinct values
 * over NON-deleted filaments, alphabetically sorted.
 */
describe("GET /api/filaments/types & /api/filaments/vendors", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const mod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", mod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  it("returns distinct non-deleted types, sorted, excluding trashed rows", async () => {
    await Filament.create({ name: "A", vendor: "Acme", type: "PLA" });
    await Filament.create({ name: "B", vendor: "Bolt", type: "PETG" });
    await Filament.create({ name: "C", vendor: "Acme", type: "PLA" }); // dup type
    await Filament.create({
      name: "D",
      vendor: "Zed",
      type: "ABS",
      _deletedAt: new Date(), // trashed → must not appear
    });

    const res = await getTypes();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["PETG", "PLA"]);
  });

  it("returns distinct non-deleted vendors, sorted, excluding trashed rows", async () => {
    await Filament.create({ name: "A", vendor: "Acme", type: "PLA" });
    await Filament.create({ name: "B", vendor: "Bolt", type: "PETG" });
    await Filament.create({ name: "C", vendor: "Acme", type: "PLA" }); // dup vendor
    await Filament.create({
      name: "D",
      vendor: "Trashed Co",
      type: "ABS",
      _deletedAt: new Date(),
    });

    const res = await getVendors();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(["Acme", "Bolt"]);
  });
});
