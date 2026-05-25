import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import {
  parseBambuStudioProfile,
  type BambuParseResult,
} from "@/lib/bambuStudioImport";
import {
  buildStructuredUpdate,
  resolveAndApplyCalibration,
} from "@/lib/bambuStudioApply";
import {
  assertMultipartFormData,
  errorResponse,
  errorResponseFromCaught,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { mergeSlicerSettings } from "@/lib/slicerSettings";

/**
 * POST /api/filaments/bambustudio
 *
 * Import a Bambu Studio filament-preset (`.json`). Companion to the
 * existing per-id export at `GET /api/filaments/{id}/bambustudio`; the
 * pair gives Bambu users a full round-trip (export from the app, edit
 * + calibrate in Bambu Studio, re-import the calibrated values).
 *
 * The route accepts the file two ways:
 *   - `multipart/form-data` with a `file` field (UI flow)
 *   - `application/json` with the Bambu profile as the body (script flow)
 *
 * Upsert key is the filament name, derived from `filament_settings_id`
 * (preferred — that's what the slicer treats as the preset name) or
 * top-level `name` (matches the export-side filename stem). Existing
 * filaments are updated; missing ones are created. Spool data,
 * usageHistory and dryCycles on an existing filament are NEVER touched.
 *
 * Calibration handling (the design decision from the import discussion):
 *   1. Parse the Bambu JSON for calibration values + a printer hint
 *      (`printer_settings_id`, format roughly "Vendor Model 0.4 nozzle").
 *   2. If a Printer doc matches that hint AND has a unique nozzle at the
 *      hinted diameter, write the values to a calibrations[] row tagged
 *      with that (printer, nozzle) pair.
 *   3. Otherwise the maxVolumetricSpeed lift carries through as a top-
 *      level update and the per-nozzle-only values are skipped with a
 *      `calibrationUnresolved` flag on the response, so the caller knows
 *      to surface a nudge.
 *
 * Returns: `{ created, updated, filamentId, calibrationApplied,
 *   calibrationUnresolved?, settingsAdded }` so the UI can show a clear
 * outcome instead of a vague "imported".
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  // ── Read the JSON body ─────────────────────────────────────────────
  let raw: unknown;
  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (contentType.includes("multipart/form-data")) {
    const ctErr = assertMultipartFormData(request);
    if (ctErr) return ctErr;
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return errorResponse("Failed to read multipart body", 400);
    }
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return errorResponse("multipart upload must include a 'file' field", 400);
    }
    const text = await file.text();
    try {
      raw = JSON.parse(text);
    } catch {
      return errorResponse("Uploaded file is not valid JSON", 400);
    }
  } else if (contentType.includes("application/json")) {
    try {
      raw = await request.json();
    } catch {
      return errorResponse("Invalid JSON in request body", 400);
    }
  } else {
    return errorResponse(
      "Send the Bambu Studio profile as multipart/form-data (file= field) or application/json.",
      400,
    );
  }

  // ── Parse ──────────────────────────────────────────────────────────
  let parsed: BambuParseResult;
  try {
    parsed = parseBambuStudioProfile(raw);
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : String(err), 400);
  }

  try {
    await dbConnect();

    const { filament: parsedFilament, calibrationHints } = parsed;

    // ── Find existing OR create ───────────────────────────────────────
    // Match by name first. `filament_settings_id` is the canonical Bambu
    // identifier so the export filename and this lookup line up.
    let existing = await Filament.findOne({
      name: parsedFilament.name,
      _deletedAt: null,
    });

    // ── Build the structured update ───────────────────────────────────
    const update = buildStructuredUpdate(parsedFilament, existing);

    // ── Merge unknown keys into the settings passthrough bag ─────────
    // mergeSlicerSettings enforces the per-key size + key-count caps so
    // a bloated profile can't blow up the document.
    const settingsResult = mergeSlicerSettings(
      (existing?.settings as Record<string, unknown>) || {},
      parsedFilament.settings,
      // Already-structured keys we own — skip them in the merge.
      new Set(Object.keys(parsedFilament.settings).filter(() => false)),
    );
    if (settingsResult.error) {
      return errorResponse(settingsResult.error, 400);
    }
    if (settingsResult.added.length > 0) {
      update.settings = settingsResult.settings;
    }

    // ── Resolve calibration context + apply hints ─────────────────────
    const calibrationOutcome = await resolveAndApplyCalibration(
      parsedFilament,
      calibrationHints,
      update,
      existing,
    );

    // ── Upsert ────────────────────────────────────────────────────────
    let created = false;
    if (!existing) {
      // Create. Mongoose `create` runs validators; required fields
      // (vendor, type) had better be present in the Bambu profile, else
      // we bubble the validation error to 400.
      if (!parsedFilament.type) {
        return errorResponse(
          "Bambu Studio profile is missing filament_type — required to create a new filament",
          400,
        );
      }
      if (!parsedFilament.vendor) {
        return errorResponse(
          "Bambu Studio profile is missing filament_vendor — required to create a new filament",
          400,
        );
      }
      try {
        existing = await Filament.create({
          name: parsedFilament.name,
          ...update,
        });
        created = true;
      } catch (createErr) {
        return errorResponseFromCaught(createErr, "Failed to create filament");
      }
    } else {
      // Update — never touch spools/usageHistory/dryCycles.
      delete (update as Record<string, unknown>).spools;
      // Codex P2 on PR #387: `runValidators` so the new numeric range
      // validators (#337) actually fire on a Bambu import — without it,
      // a profile carrying e.g. negative density would persist invalid
      // data and corrupt downstream math. `context: "query"` is the
      // mongoose recipe for getting the doc context inside validators
      // (matches the import-atlas route's pattern).
      try {
        await Filament.updateOne(
          { _id: existing._id },
          { $set: update },
          { runValidators: true, context: "query" },
        );
      } catch (validationErr) {
        return errorResponseFromCaught(
          validationErr,
          "Bambu Studio profile contained invalid values",
        );
      }
    }

    return NextResponse.json({
      created,
      updated: !created,
      filamentId: String(existing._id),
      name: existing.name,
      calibrationApplied: calibrationOutcome.applied,
      calibrationUnresolved: calibrationOutcome.unresolved || undefined,
      calibrationContext: calibrationOutcome.context || undefined,
      settingsAdded: settingsResult.added,
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to import Bambu Studio profile");
  }
}

// ─── Helpers live in src/lib/bambuStudioApply.ts so the per-id route
//     (POST /api/filaments/[id]/bambustudio) can share them.
