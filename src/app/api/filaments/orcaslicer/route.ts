import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import "@/models/Nozzle";
import "@/models/Printer";
import "@/models/BedType";
import { resolveFilament } from "@/lib/resolveFilament";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";
import {
  checkContentLength,
  errorResponse,
  MAX_UPLOAD_SIZE,
} from "@/lib/apiErrorHandler";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { parseBambuStudioProfile } from "@/lib/bambuStudioImport";
import { upsertParsedBambuFilament } from "@/lib/bambuUpsert";
import { indexOrcaProfiles, planOrcaImport } from "@/lib/orcaSlicerImport";

/** 24-hex ObjectId, for validating user-supplied `?ids=` before a `$in`. */
const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

/**
 * GET /api/filaments/orcaslicer
 *
 * Export filaments as OrcaSlicer-compatible JSON profiles.
 * All structured Filament DB fields are mapped to their OrcaSlicer
 * equivalents (nozzle_temperature, hot_plate_temp, filament_flow_ratio, etc.)
 * with values wrapped in arrays per OrcaSlicer multi-extruder convention.
 *
 * Query params:
 *   type   — filter by filament type (e.g. PLA, PETG)
 *   vendor — filter by vendor name
 *   ids    — comma-separated list of filament IDs
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const { searchParams } = request.nextUrl;
    const typeFilter = searchParams.get("type");
    const vendorFilter = searchParams.get("vendor");
    const idsFilter = searchParams.get("ids");

    // Build query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: Record<string, any> = { _deletedAt: null };
    if (typeFilter) query.type = typeFilter;
    if (vendorFilter) query.vendor = vendorFilter;
    if (idsFilter) {
      // Validate each id is a real ObjectId before the $in — an invalid value
      // would otherwise throw a Mongoose CastError and 500 (#677).
      const ids = idsFilter.split(",").map((id) => id.trim()).filter(Boolean);
      const bad = ids.filter((id) => !OBJECT_ID_RE.test(id));
      if (bad.length > 0) {
        return errorResponse(`Invalid filament ID(s): ${bad.join(", ")}`, 400);
      }
      query._id = { $in: ids };
    }

    const filaments = await Filament.find(query)
      .sort({ name: 1 })
      .populate("calibrations.nozzle")
      .populate("calibrations.printer")
      .populate("calibrations.bedType")
      .lean();

    // Build parent lookup for resolving variants
    const parentMap = new Map<string, (typeof filaments)[number]>();
    for (const f of filaments) {
      if (!f.parentId) {
        parentMap.set(f._id.toString(), f);
      }
    }

    // If a variant's parent isn't in the filtered results, batch-fetch missing parents
    const missingParentIds = [
      ...new Set(
        filaments
          .filter((f) => f.parentId && !parentMap.has(f.parentId.toString()))
          .map((f) => f.parentId!.toString()),
      ),
    ];
    if (missingParentIds.length > 0) {
      const missingParents = await Filament.find({
        _id: { $in: missingParentIds },
        _deletedAt: null,
      })
        .populate("calibrations.nozzle")
        .populate("calibrations.printer")
        .populate("calibrations.bedType")
        .lean();
      for (const parent of missingParents) {
        parentMap.set(parent._id.toString(), parent);
      }
    }

    // Resolve variants
    const resolved = filaments.map((f) =>
      f.parentId
        ? resolveFilament(f, parentMap.get(f.parentId.toString()))
        : f,
    );

    const profiles = generateOrcaSlicerProfiles(resolved);

    return NextResponse.json(profiles);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to export OrcaSlicer profiles", detail: message },
      { status: 500 },
    );
  }
}

/** GH #297-style cap, mirroring the PrusaSlicer bulk route. */
const MAX_IMPORT_PROFILES = 10_000;

/**
 * POST /api/filaments/orcaslicer
 *
 * Bulk-import OrcaSlicer filament-library presets (closes the GH #341 gap
 * — this was a documented 501 stub). Body (`application/json` only):
 *
 *   { "selected": ["Vendor PLA @System", …],   // names to import
 *     "profiles": [ { raw OrcaSlicer preset JSON }, … ] }
 *
 * `profiles` must contain the selected presets plus every ancestor their
 * `inherits` chains reference (the UI collects that closure from the
 * user's library folder). The inheritance handling — flattening, abstract
 * templates, the parent/variant mapping onto Filament DB's model, and the
 * collapse rule for 3+-level concrete chains — lives in
 * `src/lib/orcaSlicerImport.ts` (see its module docblock).
 *
 * Each planned record runs through `parseBambuStudioProfile` (OrcaSlicer
 * JSON ≡ Bambu Studio JSON) and the shared three-phase upsert in
 * `src/lib/bambuUpsert.ts`. Parents (roots) are written first so variants
 * can link to them. Name collisions with existing rows:
 *   - existing variant of the SAME parent → diff update (idempotent
 *     re-import; GH #403 pruning keeps inheritance live)
 *   - existing ROOT filament → updated in place with the FULL flattened
 *     payload; it is never re-parented
 *   - existing variant of a DIFFERENT parent → skipped with a per-profile
 *     error (a full-payload update would sever its inheritance — the OPT
 *     variant importer's refuse-collision posture)
 * A trashed row of the same name is resurrected (keeping its old parent
 * state — updates never touch parentId).
 *
 * Calibration hints in the presets are applied exactly like the Bambu
 * importer (printer/nozzle auto-detect via `printer_settings_id`;
 * ambiguity punts to unresolved); the response carries aggregate
 * `calibrationApplied` / `calibrationUnresolved` counts.
 *
 * Per-profile failures (missing base, invalid values, collisions) land in
 * `errors[]` — one bad profile never sinks the batch.
 *
 * Returns: { created, updated, variants, filaments, calibrationApplied,
 *   calibrationUnresolved, errors? }
 */
export async function POST(request: NextRequest) {
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  const sizeError = checkContentLength(request);
  if (sizeError) return sizeError;

  try {
    await dbConnect();

    const body = await request.text();
    // Byte length, not String.length (UTF-16 code units) — a non-ASCII UTF-8
    // body can exceed 10 MB of bytes while staying under the char count when
    // Content-Length was missing/wrong (Codex P2 on PR #685).
    if (Buffer.byteLength(body, "utf8") > MAX_UPLOAD_SIZE) {
      return errorResponse("Request body too large. Maximum is 10 MB.", 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return errorResponse("Invalid JSON in request body", 400);
    }
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return errorResponse(
        'Body must be a JSON object: { "selected": string[], "profiles": object[] }',
        400,
      );
    }
    const { selected, profiles } = parsed as {
      selected?: unknown;
      profiles?: unknown;
    };
    if (
      !Array.isArray(selected) ||
      selected.length === 0 ||
      !selected.every((s) => typeof s === "string" && s.trim() !== "")
    ) {
      return errorResponse(
        '"selected" must be a non-empty array of profile names',
        400,
      );
    }
    if (!Array.isArray(profiles) || profiles.length === 0) {
      return errorResponse('"profiles" must be a non-empty array of preset objects', 400);
    }
    if (profiles.length > MAX_IMPORT_PROFILES || selected.length > MAX_IMPORT_PROFILES) {
      return errorResponse(
        `Import too large: exceeds the ${MAX_IMPORT_PROFILES} profile limit.`,
        400,
      );
    }

    const { byName, errors: indexErrors } = indexOrcaProfiles(profiles);
    const plan = planOrcaImport(selected as string[], byName);
    const errors: string[] = [...indexErrors, ...plan.errors];

    let created = 0;
    let updated = 0;
    let variants = 0;
    let calibrationApplied = 0;
    let calibrationUnresolved = 0;
    const names: string[] = [];
    /** Root name → created/updated document _id, for variant linking. */
    const parentIds = new Map<string, string>();

    for (const entry of plan.entries) {
      try {
        let rawPayload = entry.flattenedRaw;
        let createParentId: string | null = null;
        let intendsVariant = false;

        if (entry.kind === "variant") {
          const parentDocId = parentIds.get(entry.parentName!);
          if (!parentDocId) {
            errors.push(`${entry.name}: parent "${entry.parentName}" failed to import`);
            continue;
          }
          // Advisory pre-check for the collision tree — the atomic phases in
          // upsertParsedBambuFilament are what actually protect the write
          // (updates never $set parentId, so a re-parent can't slip through
          // a TOCTOU window; worst case a racing delete demotes case 2/3 to
          // the create path, which links correctly).
          const existing = (await Filament.findOne({
            name: entry.name,
            _deletedAt: null,
          })
            .select("parentId")
            .lean()) as { parentId?: unknown } | null;
          if (!existing) {
            // No active row: create as a variant carrying only its diffs.
            rawPayload = entry.diffRaw!;
            createParentId = parentDocId;
            intendsVariant = true;
          } else if (existing.parentId && String(existing.parentId) === parentDocId) {
            // Already a variant of the same parent: idempotent diff update.
            rawPayload = entry.diffRaw!;
            intendsVariant = true;
          } else if (!existing.parentId) {
            // Existing standalone/root filament: update it in place with the
            // FULL flattened payload — never silently re-parent a record the
            // user may have created by hand.
            rawPayload = entry.flattenedRaw;
          } else {
            errors.push(
              `${entry.name}: already exists as a variant of a different filament — skipped`,
            );
            continue;
          }
        }

        const parsedPreset = parseBambuStudioProfile(rawPayload);
        const result = await upsertParsedBambuFilament(parsedPreset, {
          parentId: createParentId,
        });
        if (!result.ok) {
          errors.push(
            `${entry.name}: ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
          );
          continue;
        }

        if (result.created) created++;
        else updated++;
        // A resurrect keeps the trashed row's old parent state, so only a
        // fresh create or a confirmed same-parent update counts as a variant.
        if (intendsVariant && (result.created || createParentId === null)) {
          variants++;
        }
        names.push(result.doc.name);
        if (entry.kind === "root") {
          parentIds.set(entry.name, String(result.doc._id));
        }
        if (result.payload.calibrationOutcome.applied) calibrationApplied++;
        if (result.payload.calibrationOutcome.unresolved) calibrationUnresolved++;
      } catch (entryErr) {
        const msg = entryErr instanceof Error ? entryErr.message : String(entryErr);
        errors.push(`${entry.name}: ${msg}`);
      }
    }

    const result: Record<string, unknown> = {
      created,
      updated,
      variants,
      filaments: names,
      calibrationApplied,
      calibrationUnresolved,
    };
    if (errors.length > 0) result.errors = errors;
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to import OrcaSlicer profiles", detail: message },
      { status: 500 },
    );
  }
}
