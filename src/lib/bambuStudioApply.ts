/**
 * Applier-side helper for the Bambu Studio importer. Sibling to the
 * pure-parser `bambuStudioImport.ts`; lives separately because it has
 * Mongo dependencies (Printer / Nozzle lookups for the calibration
 * context match) and the parser deliberately stays DB-free so tests can
 * exercise the mapping with no fixtures.
 *
 * Shared by the two import routes:
 *   - `POST /api/filaments/bambustudio` (upsert by name)
 *   - `POST /api/filaments/{id}/bambustudio` (target pinned by id)
 *
 * Both call:
 *   1. `buildStructuredUpdate` — projects the parsed payload to the
 *      subset of model fields we update, merging into existing values
 *      so a partial Bambu profile doesn't blank pre-existing data.
 *   2. `resolveAndApplyCalibration` — tries to match the printer hint
 *      in the profile to a Printer doc + one of its installed nozzles,
 *      and either writes a `calibrations[]` row or signals unresolved.
 */

import Printer from "@/models/Printer";
import Nozzle from "@/models/Nozzle";
import type {
  CalibrationHints,
  ParsedFilament,
} from "@/lib/bambuStudioImport";

/**
 * Project the parsed payload to the subset of model fields we update.
 * `null`/`undefined` keys are intentionally omitted so a partial Bambu
 * profile doesn't blank pre-existing values on an existing filament.
 */
/** Loose shape for the `existing` filament parameter. The full Mongoose
 * doc type has stricter null-vs-undefined on its embedded arrays
 * (`number | null` vs `number | undefined`) — only `bedType` is read
 * here for dedup, so accept anything with that field. */
export interface ExistingFilamentForApply {
  temperatures?: Record<string, unknown>;
  bedTypeTemps?: Array<{
    bedType: string;
    temperature?: number | null;
    firstLayerTemperature?: number | null;
  }>;
}

export function buildStructuredUpdate(
  parsed: ParsedFilament,
  existing: ExistingFilamentForApply | null,
): Record<string, unknown> {
  const u: Record<string, unknown> = {};
  if (parsed.type != null) u.type = parsed.type;
  if (parsed.vendor != null) u.vendor = parsed.vendor;
  if (parsed.color != null) u.color = parsed.color;
  if (parsed.diameter != null) u.diameter = parsed.diameter;
  if (parsed.density != null) u.density = parsed.density;
  if (parsed.cost != null) u.cost = parsed.cost;
  if (parsed.maxVolumetricSpeed != null) u.maxVolumetricSpeed = parsed.maxVolumetricSpeed;
  if (parsed.notes != null) u.notes = parsed.notes;
  if (parsed.shrinkageXY != null) u.shrinkageXY = parsed.shrinkageXY;
  if (parsed.shrinkageZ != null) u.shrinkageZ = parsed.shrinkageZ;

  // Temperatures: merge with whatever's already on the doc so we don't
  // clobber e.g. nozzleRangeMin when the import only carries `nozzle`.
  const t = parsed.temperatures;
  const tempKeys = Object.entries(t).filter(([, v]) => v != null);
  if (tempKeys.length > 0) {
    u.temperatures = {
      ...((existing?.temperatures as Record<string, unknown>) || {}),
      ...Object.fromEntries(tempKeys),
    };
  }

  if (parsed.bedTypeTemps.length > 0) {
    // Bambu's plate keys are authoritative for the materials present in
    // the file; merge into the existing array by bedType name,
    // replacing matching entries and appending new ones. Normalise
    // null → undefined so the spread below doesn't reintroduce nulls
    // the model permits but the parser doesn't.
    type BedEntry = {
      bedType: string;
      temperature?: number;
      firstLayerTemperature?: number;
    };
    const existingBedTypes: BedEntry[] = (existing?.bedTypeTemps || []).map((e) => ({
      bedType: e.bedType,
      temperature: e.temperature ?? undefined,
      firstLayerTemperature: e.firstLayerTemperature ?? undefined,
    }));
    const byName = new Map<string, BedEntry>(existingBedTypes.map((e) => [e.bedType, e]));
    for (const entry of parsed.bedTypeTemps) {
      byName.set(entry.bedType, { ...byName.get(entry.bedType), ...entry });
    }
    u.bedTypeTemps = [...byName.values()];
  }

  return u;
}

export interface CalibrationOutcome {
  applied: boolean;
  unresolved: boolean;
  context?: {
    printerId: string;
    printerName: string;
    nozzleId: string;
    nozzleDiameter: number;
  };
}

/**
 * Try to match the printer hint in the parsed profile to a Printer doc
 * and one of its installed nozzles. When that succeeds we add/update a
 * `calibrations[]` entry on `update`. When it fails, the
 * maxVolumetricSpeed value still lands as a top-level update (handled
 * in `buildStructuredUpdate`) but per-nozzle-only hints are dropped.
 */
export async function resolveAndApplyCalibration(
  parsed: ParsedFilament,
  hints: CalibrationHints,
  update: Record<string, unknown>,
  existing: { calibrations?: unknown[] } | null,
): Promise<CalibrationOutcome> {
  if (!hints.hasAnyHint) {
    return { applied: false, unresolved: false };
  }

  const ctx = await matchPrinterNozzle(hints);
  if (!ctx) {
    return { applied: false, unresolved: true };
  }

  const row: Record<string, unknown> = {
    printer: ctx.printerId,
    nozzle: ctx.nozzleId,
  };
  if (hints.extrusionMultiplier != null) row.extrusionMultiplier = hints.extrusionMultiplier;
  if (hints.maxVolumetricSpeed != null) row.maxVolumetricSpeed = hints.maxVolumetricSpeed;
  if (hints.pressureAdvance != null) row.pressureAdvance = hints.pressureAdvance;
  if (hints.retractLength != null) row.retractLength = hints.retractLength;
  if (hints.retractSpeed != null) row.retractSpeed = hints.retractSpeed;
  if (hints.retractLift != null) row.retractLift = hints.retractLift;
  if (hints.fanMinSpeed != null) row.fanMinSpeed = hints.fanMinSpeed;
  if (hints.fanMaxSpeed != null) row.fanMaxSpeed = hints.fanMaxSpeed;
  if (hints.fanBridgeSpeed != null) row.fanBridgeSpeed = hints.fanBridgeSpeed;
  if (parsed.temperatures.nozzle != null) row.nozzleTemp = parsed.temperatures.nozzle;
  if (parsed.temperatures.nozzleFirstLayer != null) row.nozzleTempFirstLayer = parsed.temperatures.nozzleFirstLayer;
  if (parsed.temperatures.bed != null) row.bedTemp = parsed.temperatures.bed;
  if (parsed.temperatures.bedFirstLayer != null) row.bedTempFirstLayer = parsed.temperatures.bedFirstLayer;

  const existingRows = (existing?.calibrations as Array<Record<string, unknown>>) || [];
  const idx = existingRows.findIndex(
    (c) =>
      String(c.printer) === ctx.printerId && String(c.nozzle) === ctx.nozzleId,
  );
  const merged = [...existingRows];
  if (idx >= 0) {
    merged[idx] = { ...merged[idx], ...row };
  } else {
    merged.push(row);
  }
  update.calibrations = merged;

  return { applied: true, unresolved: false, context: ctx };
}

/**
 * Parse `printer_settings_id` (or the compatible_printers fallback)
 * into a model name + nozzle diameter, look up a Printer that matches,
 * and pick the unique installed nozzle at that diameter.
 *
 * Bambu printer_settings_id format examples:
 *   "Bambu Lab P1S 0.4 nozzle"
 *   "Bambu Lab X1C 0.6 nozzle"
 *   "Prusa Core One 0.4"
 */
async function matchPrinterNozzle(hints: CalibrationHints): Promise<
  | {
      printerId: string;
      printerName: string;
      nozzleId: string;
      nozzleDiameter: number;
    }
  | null
> {
  const hint = hints.printerSettingsId ?? hints.compatiblePrinters;
  if (!hint) return null;

  // Extract trailing diameter. The "nozzle" suffix is optional because
  // some exports omit it (Prusa-format presets, OrcaSlicer custom names).
  const diameterMatch = hint.match(/(\d+(?:\.\d+)?)\s*(?:nozzle)?\s*$/i);
  if (!diameterMatch) return null;
  const diameter = Number(diameterMatch[1]);
  if (!Number.isFinite(diameter) || diameter <= 0) return null;

  // The substring up to the diameter is the printer-name hint.
  const modelHint = hint
    .slice(0, diameterMatch.index)
    .trim()
    .replace(/[-—]\s*$/, "");
  if (!modelHint) return null;

  // Find printers whose name CONTAINS the model hint (case-insensitive).
  // Users name their printers freely ("My Bambu", "Prusa in the garage"),
  // so the contains check on either side is a pragmatic heuristic.
  //
  // Codex P2 on PR #387: collect ALL matches and punt to unresolved when
  // >1 — silently picking the first when "Bambu Lab P1S" matches both
  // "Bambu Lab P1S" and "Bambu Lab P1S (downstairs)" would tag the
  // calibration to whichever Mongo returned first (nondeterministic, and
  // wrong on average). Same posture as the ambiguous-nozzle branch
  // below.
  const printers = await Printer.find({ _deletedAt: null })
    .populate("installedNozzles")
    .lean();
  const re = new RegExp(escapeRegex(modelHint), "i");
  const matches = printers.filter(
    (p) => re.test(p.name) || re.test(`${p.manufacturer} ${p.printerModel}`),
  );
  if (matches.length !== 1) return null;
  const matched = matches[0];

  // `installedNozzles` is typed as ObjectId[] on the model, but
  // `.populate()` replaces those refs with the full Nozzle docs at
  // runtime. Cast through `unknown` so TS lets us read the populated shape.
  const candidates =
    ((matched.installedNozzles as unknown) as Array<{ _id: unknown; diameter: number }> | undefined) ?? [];
  const sameDiameter = candidates.filter(
    (n) => Math.abs(n.diameter - diameter) < 0.001,
  );
  if (sameDiameter.length === 1) {
    return {
      printerId: String(matched._id),
      printerName: matched.name,
      nozzleId: String(sameDiameter[0]._id),
      nozzleDiameter: diameter,
    };
  }
  if (sameDiameter.length === 0) {
    // Fallback: the diameter exists in the global catalog but isn't yet
    // attached to this printer's `installedNozzles`. Pick any nozzle at
    // that diameter so the calibration row can land — the user can
    // re-tag it later via the form.
    const anyNozzle = await Nozzle.findOne({ diameter, _deletedAt: null }).lean();
    if (!anyNozzle) return null;
    return {
      printerId: String(matched._id),
      printerName: matched.name,
      nozzleId: String(anyNozzle._id),
      nozzleDiameter: diameter,
    };
  }
  // >1 candidate — ambiguous (e.g. Brass + ObXidian 0.4 on the same
  // machine). Punt rather than guess; the caller surfaces unresolved.
  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
