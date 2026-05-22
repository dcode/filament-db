import { describe, it, expect, beforeEach } from "vitest";
import mongoose from "mongoose";
import { NextRequest } from "next/server";
import { GET as matchFilaments } from "@/app/api/filaments/match/route";

/**
 * Route-level tests for /api/filaments/match — the endpoint the NFC scan
 * flow uses to match a decoded tag against the filament DB.
 *
 * Regression focus: a confident `match` must require type agreement.
 * Vendor alone is not enough — a scanned PC spool once matched the user's
 * only Bambu PLA filament because the vendor-only fallback promoted a
 * lone vendor hit to a definitive match.
 */
describe("/api/filaments/match", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let Filament: any;

  beforeEach(async () => {
    const filamentMod = await import("@/models/Filament");
    if (!mongoose.models.Filament) {
      mongoose.model("Filament", filamentMod.default.schema);
    }
    Filament = mongoose.models.Filament;
  });

  function matchReq(query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return new NextRequest(`http://localhost/api/filaments/match?${qs}`);
  }

  const names = (list: { name: string }[]) => list.map((c) => c.name).sort();

  it("returns a confident match on an exact (case-insensitive) name", async () => {
    await Filament.create({ name: "Bambu PC Black", vendor: "Bambu Lab", type: "PC" });
    const res = await matchFilaments(
      matchReq({ name: "bambu pc black", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match?.name).toBe("Bambu PC Black");
    expect(body.candidates).toEqual([]);
  });

  it("promotes a single vendor+type hit to the match", async () => {
    await Filament.create({ name: "Bambu PC Black", vendor: "Bambu Lab", type: "PC" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match?.name).toBe("Bambu PC Black");
    expect(body.candidates).toEqual([]);
  });

  it("returns multiple vendor+type hits as candidates, with no auto-match", async () => {
    await Filament.create({ name: "Bambu PC Black", vendor: "Bambu Lab", type: "PC" });
    await Filament.create({ name: "Bambu PC Clear", vendor: "Bambu Lab", type: "PC" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(names(body.candidates)).toEqual(["Bambu PC Black", "Bambu PC Clear"]);
  });

  it("does NOT auto-match on vendor alone when the type differs", async () => {
    // The DB's only Bambu filament is PLA. A PC tag must not match it —
    // it may only be offered as a candidate for the user to confirm.
    await Filament.create({ name: "PLA Silk+", vendor: "Bambu Lab", type: "PLA" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(names(body.candidates)).toEqual(["PLA Silk+"]);
  });

  it("returns no match and no candidates for an unknown vendor", async () => {
    await Filament.create({ name: "PLA Silk+", vendor: "Bambu Lab", type: "PLA" });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Polymaker", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual([]);
  });

  it("excludes soft-deleted filaments from matches and candidates", async () => {
    await Filament.create({
      name: "Bambu PC Black",
      vendor: "Bambu Lab",
      type: "PC",
      _deletedAt: new Date(),
    });
    const res = await matchFilaments(
      matchReq({ name: "PC", vendor: "Bambu Lab", type: "PC" }),
    );
    const body = await res.json();
    expect(body.match).toBeNull();
    expect(body.candidates).toEqual([]);
  });
});
