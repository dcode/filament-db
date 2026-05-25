import { describe, it, expect } from "vitest";
import { parseBambuStudioProfile } from "@/lib/bambuStudioImport";
import {
  generateOrcaSlicerProfiles,
} from "@/lib/orcaSlicerBundle";

/**
 * Pure-parser tests for the Bambu Studio importer. Lives separately
 * from the route-level tests so the parser can be exercised without
 * spinning up mongodb-memory-server.
 *
 * The most important guarantee here is the round-trip: a filament
 * exported through the OrcaSlicer generator (which the Bambu export
 * route reuses verbatim) must parse back into the same fields. If that
 * invariant breaks, the export → calibrate-in-Bambu → re-import flow
 * silently loses data.
 */
describe("parseBambuStudioProfile", () => {
  it("throws on a non-object payload", () => {
    expect(() => parseBambuStudioProfile(null)).toThrow(/JSON object/);
    expect(() => parseBambuStudioProfile([])).toThrow(/JSON object/);
    expect(() => parseBambuStudioProfile("string")).toThrow(/JSON object/);
  });

  it("throws when the profile has no identifier", () => {
    expect(() => parseBambuStudioProfile({ filament_type: ["PLA"] })).toThrow(
      /filament_settings_id/,
    );
  });

  it("picks the name from filament_settings_id, name, or filament_id (in that order)", () => {
    expect(
      parseBambuStudioProfile({
        filament_settings_id: ["MyPLA"],
        name: ["NotThis"],
      }).filament.name,
    ).toBe("MyPLA");
    expect(parseBambuStudioProfile({ name: ["JustName"] }).filament.name).toBe("JustName");
    expect(parseBambuStudioProfile({ filament_id: ["GFA00"] }).filament.name).toBe("GFA00");
  });

  it("unwraps single-element arrays and coerces numerics", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_diameter: ["1.75"],
      filament_density: ["1.24"],
      filament_cost: ["28.5"],
      filament_max_volumetric_speed: ["12"],
      nozzle_temperature: ["210"],
      nozzle_temperature_initial_layer: ["215"],
      hot_plate_temp: ["60"],
      hot_plate_temp_initial_layer: ["65"],
    });
    expect(filament.diameter).toBe(1.75);
    expect(filament.density).toBe(1.24);
    expect(filament.cost).toBe(28.5);
    expect(filament.maxVolumetricSpeed).toBe(12);
    expect(filament.temperatures.nozzle).toBe(210);
    expect(filament.temperatures.nozzleFirstLayer).toBe(215);
    expect(filament.temperatures.bed).toBe(60);
    expect(filament.temperatures.bedFirstLayer).toBe(65);
  });

  it("maps Bambu plate-temp keys into bedTypeTemps[]", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      cool_plate_temp: ["35"],
      eng_plate_temp: ["80"],
      eng_plate_temp_initial_layer: ["85"],
      textured_plate_temp: ["70"],
    });
    // hot_plate is the default + lands in temperatures.bed, not here.
    // cool/eng/textured become bedTypeTemps entries.
    const byName = Object.fromEntries(filament.bedTypeTemps.map((b) => [b.bedType, b]));
    expect(byName["Cool Plate"]?.temperature).toBe(35);
    expect(byName["Engineering Plate"]?.temperature).toBe(80);
    expect(byName["Engineering Plate"]?.firstLayerTemperature).toBe(85);
    expect(byName["Textured PEI Plate"]?.temperature).toBe(70);
  });

  it("strips trailing % from filament_shrink", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_shrink: ["0.5%"],
      filament_shrinkage_compensation_z: ["1.2"],
    });
    expect(filament.shrinkageXY).toBe(0.5);
    expect(filament.shrinkageZ).toBe(1.2);
  });

  it("parses the soluble flag from '0'/'1'", () => {
    expect(parseBambuStudioProfile({ name: ["X"], filament_soluble: ["1"] }).filament.soluble).toBe(true);
    expect(parseBambuStudioProfile({ name: ["X"], filament_soluble: ["0"] }).filament.soluble).toBe(false);
    expect(parseBambuStudioProfile({ name: ["X"] }).filament.soluble).toBeUndefined();
  });

  it("extracts calibration hints when present and flags hasAnyHint", () => {
    const { calibrationHints } = parseBambuStudioProfile({
      name: ["X"],
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"],
      filament_flow_ratio: ["0.978"],
      pressure_advance: ["0.028"],
      filament_retract_length: ["0.8"],
      filament_max_volumetric_speed: ["15"],
    });
    expect(calibrationHints.hasAnyHint).toBe(true);
    expect(calibrationHints.printerSettingsId).toBe("Bambu Lab P1S 0.4 nozzle");
    expect(calibrationHints.extrusionMultiplier).toBe(0.978);
    expect(calibrationHints.pressureAdvance).toBe(0.028);
    expect(calibrationHints.retractLength).toBe(0.8);
    expect(calibrationHints.maxVolumetricSpeed).toBe(15);
  });

  it("hasAnyHint is false when no calibration values are present", () => {
    const { calibrationHints } = parseBambuStudioProfile({
      name: ["X"],
      printer_settings_id: ["Bambu Lab P1S 0.4 nozzle"], // hint exists but no values
      nozzle_temperature: ["210"],
    });
    expect(calibrationHints.hasAnyHint).toBe(false);
  });

  it("preserves additional_cooling_fan_speed + overhang_fan_speed in settings (Codex P1 #387)", () => {
    // These two fan keys USED to be in CALIBRATION_KEYS but had no
    // corresponding `CalibrationHints` field or model column — so they
    // were silently dropped from both the calibration row AND the
    // settings bag. Removing them from CALIBRATION_KEYS lets them
    // passthrough into settings so the round-trip preserves them.
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      additional_cooling_fan_speed: ["80"],
      overhang_fan_speed: ["60"],
    });
    expect(filament.settings.additional_cooling_fan_speed).toBe("80");
    expect(filament.settings.overhang_fan_speed).toBe("60");
  });

  it("stashes unknown keys in the settings passthrough bag", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_type: ["PLA"], // structured → NOT in settings
      filament_flow_ratio: ["0.99"], // calibration → NOT in settings
      slow_down_for_layer_cooling: ["1"], // unknown → settings
      custom_bambu_key: ["custom-value"],
    });
    expect(filament.settings.slow_down_for_layer_cooling).toBe("1");
    expect(filament.settings.custom_bambu_key).toBe("custom-value");
    // structured + calibration keys must NOT leak into settings (avoids
    // double-write on round-trip).
    expect(filament.settings.filament_type).toBeUndefined();
    expect(filament.settings.filament_flow_ratio).toBeUndefined();
  });

  it("treats empty arrays / empty strings as undefined", () => {
    const { filament } = parseBambuStudioProfile({
      name: ["X"],
      filament_cost: [],
      filament_density: [""],
      filament_vendor: [""],
    });
    expect(filament.cost).toBeUndefined();
    expect(filament.density).toBeUndefined();
    expect(filament.vendor).toBeUndefined();
  });

  it("round-trips an OrcaSlicer-format export through the parser", () => {
    // Build a representative filament doc; pass it through the export
    // generator (which the Bambu export route also uses); parse it back.
    // The Bambu route additionally sets `from: "User"`, but the parser
    // is agnostic to that since `from` is in STRUCTURED_KEYS (skipped).
    const doc = {
      name: "Round Trip PLA",
      type: "PLA",
      vendor: "QA Labs",
      color: "#33cc55",
      diameter: 1.75,
      density: 1.24,
      cost: 24.99,
      maxVolumetricSpeed: 12,
      temperatures: {
        nozzle: 210,
        nozzleFirstLayer: 215,
        bed: 60,
        bedFirstLayer: 65,
      },
      bedTypeTemps: [{ bedType: "Cool Plate", temperature: 35 }],
    };
    const [exported] = generateOrcaSlicerProfiles([doc]);
    const { filament } = parseBambuStudioProfile(exported);
    expect(filament.name).toBe("Round Trip PLA");
    expect(filament.type).toBe("PLA");
    expect(filament.vendor).toBe("QA Labs");
    expect(filament.color).toBe("#33cc55");
    expect(filament.diameter).toBe(1.75);
    expect(filament.density).toBe(1.24);
    expect(filament.cost).toBe(24.99);
    expect(filament.maxVolumetricSpeed).toBe(12);
    expect(filament.temperatures.nozzle).toBe(210);
    expect(filament.temperatures.bed).toBe(60);
    expect(filament.bedTypeTemps.find((b) => b.bedType === "Cool Plate")?.temperature).toBe(35);
  });
});
