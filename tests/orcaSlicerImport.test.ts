import { describe, it, expect } from "vitest";
import {
  indexOrcaProfiles,
  isConcreteOrcaProfile,
  isOrcaFilamentPreset,
  orcaProfileMeta,
  collectOrcaClosure,
  resolveOrcaChain,
  flattenOrcaProfile,
  diffOrcaRaw,
  planOrcaImport,
  type OrcaProfileNode,
} from "@/lib/orcaSlicerImport";

/**
 * Pure planning tests for the OrcaSlicer library importer — DB-free, no
 * mongodb-memory-server. The route-level behaviour (three-phase upsert,
 * parent linking, collision handling) lives in
 * tests/orcaslicer-import-route.test.ts.
 *
 * Fixture shape mirrors real OrcaFilamentLibrary files: an abstract
 * `fdm_filament_*` template (instantiation "false"), a concrete generic
 * profile inheriting it, and vendor leaves inheriting the generic.
 */

const TEMPLATE = {
  type: "filament",
  name: "fdm_filament_pla",
  from: "system",
  instantiation: "false",
  filament_type: ["PLA"],
  filament_density: ["1.24"],
  nozzle_temperature: ["220"],
  nozzle_temperature_range_low: ["190"],
  nozzle_temperature_range_high: ["240"],
  hot_plate_temp: ["60"],
  hot_plate_temp_initial_layer: ["60"],
  cool_plate_temp: ["35"],
  fan_max_speed: ["100"],
};

const GENERIC = {
  type: "filament",
  name: "Generic PLA @System",
  from: "system",
  instantiation: "true",
  inherits: "fdm_filament_pla",
  filament_id: "GFL99",
  setting_id: "GFSL99",
  filament_vendor: ["Generic"],
  filament_colour: ["#FFFFFF"],
  filament_cost: ["20"],
};

const VENDOR = {
  type: "filament",
  name: "Polymaker PolyLite PLA @System",
  from: "system",
  instantiation: "true",
  inherits: "Generic PLA @System",
  filament_id: "GFL05",
  setting_id: "GFSL05",
  filament_vendor: ["Polymaker"],
  filament_colour: ["#FF0000"],
  filament_density: ["1.17"],
  nozzle_temperature: ["215"],
};

function index(...raws: unknown[]): Map<string, OrcaProfileNode> {
  return indexOrcaProfiles(raws).byName;
}

describe("indexOrcaProfiles", () => {
  it("indexes profiles by name with concreteness + inherits metadata", () => {
    const { byName, errors } = indexOrcaProfiles([TEMPLATE, GENERIC, VENDOR]);
    expect(errors).toEqual([]);
    expect(byName.size).toBe(3);
    const generic = byName.get("Generic PLA @System")!;
    expect(generic.concrete).toBe(true);
    expect(generic.inheritsName).toBe("fdm_filament_pla");
    expect(byName.get("fdm_filament_pla")!.concrete).toBe(false);
    expect(byName.get("fdm_filament_pla")!.inheritsName).toBeUndefined();
  });

  it("reports non-object and nameless entries as errors without throwing", () => {
    const { byName, errors } = indexOrcaProfiles([
      null,
      "string",
      ["array"],
      { filament_type: ["PLA"] },
      GENERIC,
      TEMPLATE,
    ]);
    expect(byName.size).toBe(2);
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/index 0 is not a JSON object/);
    expect(errors[3]).toMatch(/index 3 has no "name"/);
  });

  it("keeps the first occurrence on duplicate names and reports the duplicate", () => {
    const dup = { ...GENERIC, filament_cost: ["99"] };
    const { byName, errors } = indexOrcaProfiles([TEMPLATE, GENERIC, dup]);
    expect(byName.get("Generic PLA @System")!.raw.filament_cost).toEqual(["20"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/duplicate profile name "Generic PLA @System"/);
  });

  it("unwraps an array-wrapped name", () => {
    const { byName } = indexOrcaProfiles([{ name: ["Wrapped"], instantiation: "true" }]);
    expect(byName.has("Wrapped")).toBe(true);
  });
});

describe("isConcreteOrcaProfile", () => {
  it('treats instantiation "false" as abstract, string or array-wrapped', () => {
    expect(isConcreteOrcaProfile({ instantiation: "false" })).toBe(false);
    expect(isConcreteOrcaProfile({ instantiation: ["false"] })).toBe(false);
    expect(isConcreteOrcaProfile({ instantiation: " FALSE " })).toBe(false);
  });

  it("treats everything else — including a missing key — as concrete", () => {
    expect(isConcreteOrcaProfile({ instantiation: "true" })).toBe(true);
    expect(isConcreteOrcaProfile({ instantiation: ["true"] })).toBe(true);
    expect(isConcreteOrcaProfile({})).toBe(true);
  });
});

describe("isOrcaFilamentPreset", () => {
  it("accepts filament presets and presets without a type", () => {
    expect(isOrcaFilamentPreset({ type: "filament", name: "X" })).toBe(true);
    expect(isOrcaFilamentPreset({ type: ["filament"], name: "X" })).toBe(true);
    expect(isOrcaFilamentPreset({ name: "X" })).toBe(true);
  });

  it("rejects machine/process profiles and non-objects", () => {
    expect(isOrcaFilamentPreset({ type: "machine", name: "X" })).toBe(false);
    expect(isOrcaFilamentPreset({ type: "process", name: "X" })).toBe(false);
    expect(isOrcaFilamentPreset(null)).toBe(false);
    expect(isOrcaFilamentPreset(["filament"])).toBe(false);
    expect(isOrcaFilamentPreset("filament")).toBe(false);
  });
});

describe("orcaProfileMeta", () => {
  it("returns vendor + material from the profile's own keys", () => {
    const { byName } = indexOrcaProfiles([GENERIC]);
    expect(orcaProfileMeta(byName.get("Generic PLA @System")!)).toEqual({
      vendor: "Generic",
      material: undefined, // GENERIC's own keys carry no filament_type, no map to walk
    });
    const { byName: withType } = indexOrcaProfiles([TEMPLATE]);
    expect(orcaProfileMeta(withType.get("fdm_filament_pla")!).material).toBe("PLA");
  });

  it("falls back up the inherits chain for missing vendor/material", () => {
    const byName = index(TEMPLATE, GENERIC, VENDOR);
    // GENERIC's material comes from the abstract template
    expect(orcaProfileMeta(byName.get("Generic PLA @System")!, byName)).toEqual({
      vendor: "Generic",
      material: "PLA",
    });
    // VENDOR's own vendor wins; material still resolved through the chain
    expect(orcaProfileMeta(byName.get("Polymaker PolyLite PLA @System")!, byName)).toEqual({
      vendor: "Polymaker",
      material: "PLA",
    });
  });

  it("is cycle-safe and stops at missing ancestors", () => {
    const a = { name: "A", instantiation: "true", inherits: "B" };
    const b = { name: "B", instantiation: "true", inherits: "A", filament_type: ["PLA"] };
    const byName = index(a, b);
    expect(orcaProfileMeta(byName.get("A")!, byName).material).toBe("PLA");
    const orphan = { name: "O", instantiation: "true", inherits: "missing" };
    expect(orcaProfileMeta(index(orphan).get("O")!, index(orphan)).material).toBeUndefined();
  });
});

describe("collectOrcaClosure", () => {
  it("collects selected profiles plus their ancestor chains, deduped", () => {
    const byName = index(TEMPLATE, GENERIC, VENDOR);
    const closure = collectOrcaClosure(
      ["Polymaker PolyLite PLA @System", "Generic PLA @System"],
      byName,
    );
    expect(closure.map((r) => (r as { name: string }).name)).toEqual([
      "Polymaker PolyLite PLA @System",
      "Generic PLA @System",
      "fdm_filament_pla",
    ]);
  });

  it("omits unknown names and missing ancestors instead of throwing", () => {
    const orphan = { name: "Orphan", instantiation: "true", inherits: "missing" };
    const closure = collectOrcaClosure(["Orphan", "Ghost"], index(orphan));
    expect(closure).toEqual([orphan]);
  });

  it("is cycle-safe", () => {
    const a = { name: "A", instantiation: "true", inherits: "B" };
    const b = { name: "B", instantiation: "true", inherits: "A" };
    const closure = collectOrcaClosure(["A"], index(a, b));
    expect(closure).toEqual([a, b]);
  });
});

describe("resolveOrcaChain", () => {
  it("returns [self, parent, grandparent] for a 3-level chain", () => {
    const chain = resolveOrcaChain("Polymaker PolyLite PLA @System", index(TEMPLATE, GENERIC, VENDOR));
    expect(chain.map((n) => n.name)).toEqual([
      "Polymaker PolyLite PLA @System",
      "Generic PLA @System",
      "fdm_filament_pla",
    ]);
  });

  it("throws on an unknown head name", () => {
    expect(() => resolveOrcaChain("nope", index(TEMPLATE))).toThrow(/not found in the submitted set/);
  });

  it("throws on a missing base with the base named", () => {
    expect(() => resolveOrcaChain("Generic PLA @System", index(GENERIC))).toThrow(
      /inherits "fdm_filament_pla" not found in the submitted set/,
    );
  });

  it("throws on an inheritance cycle", () => {
    const a = { name: "A", instantiation: "true", inherits: "B" };
    const b = { name: "B", instantiation: "true", inherits: "A" };
    expect(() => resolveOrcaChain("A", index(a, b))).toThrow(/cycle detected at "A"/);
  });

  it("throws on a self-inherit", () => {
    const selfie = { name: "Selfie", instantiation: "true", inherits: "Selfie" };
    expect(() => resolveOrcaChain("Selfie", index(selfie))).toThrow(/cycle detected at "Selfie"/);
  });
});

describe("flattenOrcaProfile", () => {
  it("merges the chain with child keys winning", () => {
    const flat = flattenOrcaProfile("Polymaker PolyLite PLA @System", index(TEMPLATE, GENERIC, VENDOR));
    // Own override wins over both ancestors
    expect(flat.filament_density).toEqual(["1.17"]);
    expect(flat.nozzle_temperature).toEqual(["215"]);
    // Inherited from the generic
    expect(flat.filament_cost).toEqual(["20"]);
    // Inherited from the abstract template through the generic
    expect(flat.filament_type).toEqual(["PLA"]);
    expect(flat.hot_plate_temp).toEqual(["60"]);
    expect(flat.fan_max_speed).toEqual(["100"]);
  });

  it("strips inherits/instantiation/from/filament_settings_id and forces name", () => {
    const withSettingsId = {
      ...VENDOR,
      filament_settings_id: ["Some Other Display Name"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, withSettingsId),
    );
    expect(flat.inherits).toBeUndefined();
    expect(flat.instantiation).toBeUndefined();
    expect(flat.from).toBeUndefined();
    expect(flat.filament_settings_id).toBeUndefined();
    expect(flat.name).toBe("Polymaker PolyLite PLA @System");
  });

  it("does not inherit identity keys (filament_id / setting_id) from ancestors", () => {
    const leafNoIds = {
      name: "Leaf",
      instantiation: "true",
      inherits: "Generic PLA @System",
      filament_vendor: ["Someone"],
    };
    const flat = flattenOrcaProfile("Leaf", index(TEMPLATE, GENERIC, leafNoIds));
    expect(flat.filament_id).toBeUndefined();
    expect(flat.setting_id).toBeUndefined();
    // …while non-identity keys still flow through
    expect(flat.filament_cost).toEqual(["20"]);
  });
});

describe("diffOrcaRaw", () => {
  const byName = index(TEMPLATE, GENERIC, VENDOR);
  const flatParent = flattenOrcaProfile("Generic PLA @System", byName);
  const flatChild = flattenOrcaProfile("Polymaker PolyLite PLA @System", byName);

  it("drops parent-equal keys and keeps differing ones", () => {
    const diff = diffOrcaRaw(flatChild, flatParent);
    // Equal to parent → dropped (variant inherits dynamically)
    expect(diff.filament_cost).toBeUndefined();
    expect(diff.nozzle_temperature_range_low).toBeUndefined();
    // Differs → kept
    expect(diff.filament_density).toEqual(["1.17"]);
    expect(diff.nozzle_temperature).toEqual(["215"]);
  });

  it("always keeps identity + color keys even when equal", () => {
    const sameColor = {
      ...VENDOR,
      filament_colour: GENERIC.filament_colour,
      filament_type: ["PLA"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, sameColor),
    );
    const diff = diffOrcaRaw(flat, flatParent);
    expect(diff.name).toBe("Polymaker PolyLite PLA @System");
    expect(diff.filament_type).toEqual(["PLA"]);
    expect(diff.filament_vendor).toEqual(["Polymaker"]);
    expect(diff.filament_colour).toEqual(["#FFFFFF"]);
    expect(diff.filament_id).toBe("GFL05");
    expect(diff.setting_id).toBe("GFSL05");
  });

  it("keeps ALL bed-plate keys when any one differs (whole-array inheritance)", () => {
    const hotterBed = {
      ...VENDOR,
      hot_plate_temp: ["65"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, hotterBed),
    );
    const diff = diffOrcaRaw(flat, flatParent);
    expect(diff.hot_plate_temp).toEqual(["65"]);
    // Equal plate keys ride along because bedTypeTemps inherits whole-array
    expect(diff.hot_plate_temp_initial_layer).toEqual(["60"]);
    expect(diff.cool_plate_temp).toEqual(["35"]);
  });

  it("drops all bed-plate keys when none differ", () => {
    const diff = diffOrcaRaw(flatChild, flatParent);
    expect(diff.hot_plate_temp).toBeUndefined();
    expect(diff.hot_plate_temp_initial_layer).toBeUndefined();
    expect(diff.cool_plate_temp).toBeUndefined();
  });

  it("keeps ALL calibration keys + printer context when any calibration key differs", () => {
    const calibrated = {
      ...VENDOR,
      pressure_advance: ["0.035"],
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, calibrated),
    );
    const diff = diffOrcaRaw(flat, flatParent);
    expect(diff.pressure_advance).toEqual(["0.035"]);
    // fan_max_speed equals the parent's (both inherit the template) but the
    // calibration group is atomic — calibrations[] inherits whole-array.
    expect(diff.fan_max_speed).toEqual(["100"]);
    expect(diff.printer_settings_id).toEqual(["Bambu Lab P1S 0.4 nozzle"]);
  });

  it("drops equal calibration keys when no calibration key differs", () => {
    const diff = diffOrcaRaw(flatChild, flatParent);
    expect(diff.fan_max_speed).toBeUndefined();
  });
});

describe("planOrcaImport", () => {
  const byName = index(TEMPLATE, GENERIC, VENDOR);

  it("plans a vendor leaf as a variant of its root concrete ancestor", () => {
    const { entries, errors } = planOrcaImport(["Polymaker PolyLite PLA @System"], byName);
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.kind, e.name])).toEqual([
      ["root", "Generic PLA @System"],
      ["variant", "Polymaker PolyLite PLA @System"],
    ]);
    const root = entries[0];
    // Root is flattened with the abstract template baked in
    expect(root.flattenedRaw.filament_type).toEqual(["PLA"]);
    expect(root.flattenedRaw.filament_density).toEqual(["1.24"]);
    const variant = entries[1];
    expect(variant.parentName).toBe("Generic PLA @System");
    expect(variant.diffRaw!.filament_density).toEqual(["1.17"]);
    expect(variant.diffRaw!.filament_cost).toBeUndefined();
  });

  it("dedupes the root when it is also selected", () => {
    const { entries, errors } = planOrcaImport(
      ["Generic PLA @System", "Polymaker PolyLite PLA @System"],
      byName,
    );
    expect(errors).toEqual([]);
    expect(entries.filter((e) => e.kind === "root")).toHaveLength(1);
    expect(entries.filter((e) => e.kind === "variant")).toHaveLength(1);
  });

  it("plans a profile with only abstract ancestors as a root", () => {
    const { entries, errors } = planOrcaImport(["Generic PLA @System"], byName);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0].kind).toBe("root");
    expect(entries[0].flattenedRaw.filament_type).toEqual(["PLA"]);
  });

  it("plans a no-inherits profile as a standalone root", () => {
    const standalone = {
      name: "Loner PLA",
      instantiation: "true",
      filament_type: ["PLA"],
      filament_vendor: ["Loner"],
    };
    const { entries, errors } = planOrcaImport(["Loner PLA"], index(standalone));
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      expect.objectContaining({ kind: "root", name: "Loner PLA" }),
    ]);
  });

  it("collapses 3+ concrete levels onto the concrete root", () => {
    const a = {
      name: "A",
      instantiation: "true",
      filament_type: ["PLA"],
      filament_vendor: ["V"],
      filament_cost: ["10"],
      filament_density: ["1.24"],
    };
    const b = {
      name: "B",
      instantiation: "true",
      inherits: "A",
      filament_vendor: ["V"],
      filament_density: ["1.17"],
    };
    const c = {
      name: "C",
      instantiation: "true",
      inherits: "B",
      filament_vendor: ["V"],
      filament_cost: ["12"],
    };
    const { entries, errors } = planOrcaImport(["B", "C"], index(a, b, c));
    expect(errors).toEqual([]);
    expect(entries.map((e) => [e.kind, e.name, e.parentName])).toEqual([
      ["root", "A", undefined],
      ["variant", "B", "A"],
      ["variant", "C", "A"],
    ]);
    const cEntry = entries.find((e) => e.name === "C")!;
    // C's diff is against flat(A): the density C effectively got from B
    // differs from A's, so it survives as C's own value.
    expect(cEntry.diffRaw!.filament_density).toEqual(["1.17"]);
    expect(cEntry.diffRaw!.filament_cost).toEqual(["12"]);
    const bEntry = entries.find((e) => e.name === "B")!;
    expect(bEntry.diffRaw!.filament_density).toEqual(["1.17"]);
    expect(bEntry.diffRaw!.filament_cost).toBeUndefined();
  });

  it("rejects a selected abstract template with a per-profile error", () => {
    const { entries, errors } = planOrcaImport(["fdm_filament_pla"], byName);
    expect(entries).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"fdm_filament_pla": abstract template/);
  });

  it("reports a selected name missing from the set", () => {
    const { entries, errors } = planOrcaImport(["Ghost"], byName);
    expect(entries).toEqual([]);
    expect(errors[0]).toMatch(/"Ghost": not found in the submitted profiles/);
  });

  it("a missing base fails that profile only; siblings still plan", () => {
    const orphan = {
      name: "Orphan PLA",
      instantiation: "true",
      inherits: "missing_base",
      filament_vendor: ["X"],
    };
    const { entries, errors } = planOrcaImport(
      ["Orphan PLA", "Polymaker PolyLite PLA @System"],
      index(TEMPLATE, GENERIC, VENDOR, orphan),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"Orphan PLA": inherits "missing_base" not found/);
    expect(entries.map((e) => e.name)).toEqual([
      "Generic PLA @System",
      "Polymaker PolyLite PLA @System",
    ]);
  });

  it("a cycle fails that profile only", () => {
    const x = { name: "X", instantiation: "true", inherits: "Y" };
    const y = { name: "Y", instantiation: "true", inherits: "X" };
    const { entries, errors } = planOrcaImport(
      ["X", "Generic PLA @System"],
      index(x, y, TEMPLATE, GENERIC),
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/"X": inheritance cycle/);
    expect(entries.map((e) => e.name)).toEqual(["Generic PLA @System"]);
  });

  it("deduplicates repeated selections", () => {
    const { entries } = planOrcaImport(
      ["Polymaker PolyLite PLA @System", "Polymaker PolyLite PLA @System"],
      byName,
    );
    expect(entries).toHaveLength(2); // one root + one variant
  });
});
