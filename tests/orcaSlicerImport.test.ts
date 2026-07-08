import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  indexOrcaProfiles,
  isConcreteOrcaProfile,
  isNonFilamentOrcaPath,
  isOrcaFilamentPreset,
  orcaProfileMeta,
  collectOrcaClosure,
  resolveOrcaChain,
  flattenOrcaProfile,
  diffOrcaRaw,
  planOrcaImport,
  variantUpdateRaw,
  PRUNABLE_RAW_KEYS,
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
  it("accepts an explicit filament type", () => {
    expect(isOrcaFilamentPreset({ type: "filament", name: "X" })).toBe(true);
    expect(isOrcaFilamentPreset({ type: ["filament"], name: "X" })).toBe(true);
  });

  it("without a type, requires a positive filament signal", () => {
    // Abstract template name.
    expect(isOrcaFilamentPreset({ name: "fdm_filament_pla" })).toBe(true);
    // At least one filament_*-prefixed key.
    expect(isOrcaFilamentPreset({ name: "X", filament_vendor: ["Generic"] })).toBe(true);
    // No type and no filament signal — e.g. a machine/process preset that
    // happens to omit `type` — is no longer accepted by default (GH: OrcaSlicer
    // library import letting printer/nozzle profiles into the picker).
    expect(isOrcaFilamentPreset({ name: "X" })).toBe(false);
    expect(isOrcaFilamentPreset({ name: "X", nozzle_diameter: ["0.4"] })).toBe(false);
  });

  it("rejects machine/process profiles and non-objects", () => {
    expect(isOrcaFilamentPreset({ type: "machine", name: "X" })).toBe(false);
    expect(isOrcaFilamentPreset({ type: "process", name: "X" })).toBe(false);
    expect(isOrcaFilamentPreset(null)).toBe(false);
    expect(isOrcaFilamentPreset(["filament"])).toBe(false);
    expect(isOrcaFilamentPreset("filament")).toBe(false);
  });
});

describe("isNonFilamentOrcaPath", () => {
  it("flags machine/ and process/ path segments, case-insensitively", () => {
    expect(isNonFilamentOrcaPath("Vendor/machine/0.4 nozzle.json")).toBe(true);
    expect(isNonFilamentOrcaPath("Vendor/Process/0.20mm Standard.json")).toBe(true);
    expect(isNonFilamentOrcaPath("user\\default\\machine\\Generic.json")).toBe(true);
  });

  it("leaves filament/ paths and unrelated names alone", () => {
    expect(isNonFilamentOrcaPath("Vendor/filament/Generic PLA.json")).toBe(false);
    expect(isNonFilamentOrcaPath("Generic PLA.json")).toBe(false);
    // "machine" as a substring of a segment, not a whole segment, doesn't count.
    expect(isNonFilamentOrcaPath("Vendor/machinery/Generic.json")).toBe(false);
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

  it("keeps filament_diameter even when equal to the parent (PR #985 Codex P2)", () => {
    // The Filament schema defaults `diameter` to 1.75 on create, so a
    // variant doc created WITHOUT the key would get a pinned wrong default
    // instead of inheriting — a 2.85 mm child of a 2.85 mm parent would
    // import as 1.75 mm. The diff must always carry the key.
    const template285 = { ...TEMPLATE, filament_diameter: ["2.85"] };
    const byName285 = index(template285, GENERIC, VENDOR);
    const diff = diffOrcaRaw(
      flattenOrcaProfile("Polymaker PolyLite PLA @System", byName285),
      flattenOrcaProfile("Generic PLA @System", byName285),
    );
    expect(diff.filament_diameter).toEqual(["2.85"]);
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

  it("does NOT force-keep the calibration group when max-vol is the ONLY differing calibration key (P2 review round 4)", () => {
    // filament_max_volumetric_speed is a CALIBRATION_KEYS member but also
    // lands on the top-level maxVolumetricSpeed field and is excluded from
    // hasAnyHint (bambuStudioImport.ts). A variant whose only real override
    // is max-vol must NOT fabricate a pinned calibrations[] row by dragging
    // every other parent-equal calibration key along.
    const maxVolOnly = {
      ...VENDOR,
      filament_max_volumetric_speed: ["15"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, maxVolOnly),
    );
    const diff = diffOrcaRaw(flat, flatParent);
    expect(diff.filament_max_volumetric_speed).toEqual(["15"]);
    // Parent-equal calibration keys must stay dropped — no atomic group.
    expect(diff.fan_max_speed).toBeUndefined();
    expect(diff.printer_settings_id).toBeUndefined();
  });

  it("still force-keeps the calibration group when max-vol differs ALONGSIDE a real calibration key", () => {
    const both = {
      ...VENDOR,
      filament_max_volumetric_speed: ["15"],
      pressure_advance: ["0.035"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, both),
    );
    const diff = diffOrcaRaw(flat, flatParent);
    expect(diff.filament_max_volumetric_speed).toEqual(["15"]);
    expect(diff.pressure_advance).toEqual(["0.035"]);
    // fan_max_speed is parent-equal but rides along because a genuine
    // calibration key (pressure_advance) differs.
    expect(diff.fan_max_speed).toEqual(["100"]);
  });

  it("does not misclassify a prototype-named preset key into the bed-plate atomic group", () => {
    // `k in BED_PLATE_KEYS` would return true for "constructor" /
    // "toString" / etc. via Object.prototype — hardening regression test.
    const withPrototypeKey = {
      ...VENDOR,
      constructor: ["some-value"],
    };
    const flat = flattenOrcaProfile(
      "Polymaker PolyLite PLA @System",
      index(TEMPLATE, GENERIC, withPrototypeKey),
    );
    // Real bed-plate keys are parent-equal and must stay dropped — a
    // misclassified "constructor" key would flip anyPlateDiffers true and
    // force-keep them.
    const diff = diffOrcaRaw(flat, flatParent);
    expect(diff.hot_plate_temp).toBeUndefined();
    expect(diff.cool_plate_temp).toBeUndefined();
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

describe("variantUpdateRaw", () => {
  // Codex P2 on PR #985: the payload for an EXISTING same-parent variant
  // must carry the parent-equal prunable keys (inheritable scalars +
  // nozzle temps) on top of the diff, so the apply-side GH #403 pruning
  // can clear a stale local override the profile no longer carries. The
  // groups with no apply-side pruning (settings bag, bed-plate group,
  // calibration group) must stay diff-only.
  const byName = index(TEMPLATE, GENERIC, VENDOR);
  const entry = planOrcaImport([VENDOR.name], byName).entries.find(
    (e) => e.name === VENDOR.name,
  )!;

  it("rides parent-equal prunable scalars and nozzle temps along with the diff", () => {
    const raw = variantUpdateRaw(entry);
    // Parent-equal, dropped from the diff — but prunable, so they ride:
    expect(entry.diffRaw!.filament_cost).toBeUndefined();
    expect(raw.filament_cost).toEqual(["20"]);
    expect(entry.diffRaw!.nozzle_temperature_range_low).toBeUndefined();
    expect(raw.nozzle_temperature_range_low).toEqual(["190"]);
    expect(raw.nozzle_temperature_range_high).toEqual(["240"]);
  });

  it("keeps the diff's own (differing) values — flattened values never win", () => {
    const raw = variantUpdateRaw(entry);
    expect(raw.filament_density).toEqual(["1.17"]);
    expect(raw.nozzle_temperature).toEqual(["215"]);
    expect(raw.filament_colour).toEqual(["#FF0000"]);
  });

  it("does NOT ride parent-equal bed-plate, calibration, or settings-bag keys", () => {
    const raw = variantUpdateRaw(entry);
    // bedTypeTemps[] and calibrations[] inherit as whole arrays and the
    // settings bag merge is additive — no apply-side pruning exists for
    // them, so a parent-equal value would be PINNED, not cleared.
    expect(raw.hot_plate_temp).toBeUndefined();
    expect(raw.cool_plate_temp).toBeUndefined();
    expect(raw.fan_max_speed).toBeUndefined();
  });

  it("skips prunable keys absent from the flattened child", () => {
    const raw = variantUpdateRaw(entry);
    expect("filament_max_volumetric_speed" in raw).toBe(false);
    expect("filament_shrink" in raw).toBe(false);
  });

  it("does not mutate the entry's diffRaw", () => {
    const before = JSON.stringify(entry.diffRaw);
    variantUpdateRaw(entry);
    expect(JSON.stringify(entry.diffRaw)).toBe(before);
  });
});

describe("PRUNABLE_RAW_KEYS parity (P3 review round 4)", () => {
  // PRUNABLE_RAW_KEYS is a hand-written raw-key mirror of the inheritable
  // scalars `buildStructuredUpdate` (bambuStudioApply.ts) parent-equality
  // prunes via `setIfNotInherited`. If a future scalar is added there and
  // this list isn't updated to match, `variantUpdateRaw` silently stops
  // re-attaching the now-parent-equal key and the GH #403 $unset that
  // resumes inheritance never fires — with all other tests green. This
  // test reads the actual source and fails loudly on drift instead.
  //
  // Deliberately excluded (documented, not oversights):
  //   - `type` / `vendor` — schema-REQUIRED fields; buildStructuredUpdate's
  //     REQUIRED_FIELDS set never $unsets them, so they're not "prunable".
  //   - `diameter` — DIFF_ALWAYS_KEEP always carries it on the diff itself
  //     (a variant created without it gets Mongoose's wrong 1.75 default),
  //     so it never needs the separate prunable-rider mechanism.
  const FIELD_TO_RAW_KEY: Record<string, string> = {
    density: "filament_density",
    cost: "filament_cost",
    maxVolumetricSpeed: "filament_max_volumetric_speed",
    shrinkageXY: "filament_shrink",
    shrinkageZ: "filament_shrinkage_compensation_z",
  };
  const KNOWN_NON_PRUNABLE = new Set(["type", "vendor", "diameter"]);

  it("PRUNABLE_RAW_KEYS covers every optional inheritable scalar setIfNotInherited() prunes", () => {
    const applySource = readFileSync(
      resolve(__dirname, "../src/lib/bambuStudioApply.ts"),
      "utf8",
    );
    const calls = [...applySource.matchAll(/setIfNotInherited\(\s*"(\w+)"/g)].map(
      (m) => m[1],
    );
    expect(calls.length).toBeGreaterThan(0);
    const unmapped = calls.filter(
      (field) => !KNOWN_NON_PRUNABLE.has(field) && !(field in FIELD_TO_RAW_KEY),
    );
    // A field appearing here means a new setIfNotInherited() call was added
    // to bambuStudioApply.ts without updating FIELD_TO_RAW_KEY (this test)
    // AND, most likely, PRUNABLE_RAW_KEYS itself.
    expect(unmapped).toEqual([]);
    for (const field of calls) {
      if (KNOWN_NON_PRUNABLE.has(field)) continue;
      const rawKey = FIELD_TO_RAW_KEY[field];
      expect(PRUNABLE_RAW_KEYS).toContain(rawKey);
    }
  });
});
