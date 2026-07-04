import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import {
  parseBambuStudioProfile,
  type BambuParseResult,
} from "@/lib/bambuStudioImport";
import { type BambuUpdatePayload } from "@/lib/bambuStudioApply";
import { upsertParsedBambuFilament } from "@/lib/bambuUpsert";
import {
  assertMultipartFormData,
  checkFileSize,
  errorResponse,
  errorResponseFromCaught,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";

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
 * The write itself is the shared three-phase upsert in
 * `src/lib/bambuUpsert.ts` (active → resurrect-trashed → create with
 * E11000 race recovery), also used by the bulk OrcaSlicer library
 * importer (POST /api/filaments/orcaslicer).
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
    // Codex P2 on PR #387 round 2: cap upload size BEFORE reading.
    // `file.text()` materialises the entire body into memory; without
    // this guard a multi-GB upload would happily exhaust the server.
    // Matches the existing 10 MB cap used by /api/filaments/import* and
    // /api/filaments/parse-ini.
    const sizeErr = checkFileSize(file);
    if (sizeErr) return sizeErr;
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

    const result = await upsertParsedBambuFilament(parsed);
    if (!result.ok) {
      return errorResponse(result.error, result.status, result.detail);
    }
    return importResponse(result.doc, result.created, result.payload);
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to import Bambu Studio profile");
  }
}

/** Common response shape for the upsert outcome. */
function importResponse(
  doc: { _id: unknown; name: string },
  created: boolean,
  payload: BambuUpdatePayload,
) {
  return NextResponse.json({
    created,
    updated: !created,
    filamentId: String(doc._id),
    name: doc.name,
    calibrationApplied: payload.calibrationOutcome.applied,
    calibrationUnresolved: payload.calibrationOutcome.unresolved || undefined,
    calibrationContext: payload.calibrationOutcome.context || undefined,
    settingsAdded: payload.settingsResult.added,
  });
}

// ─── Field-mapping helpers live in src/lib/bambuStudioApply.ts (shared
//     with POST /api/filaments/[id]/bambustudio); the three-phase upsert
//     lives in src/lib/bambuUpsert.ts (shared with the bulk OrcaSlicer
//     importer at POST /api/filaments/orcaslicer).
