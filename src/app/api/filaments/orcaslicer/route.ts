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
import {
  indexOrcaProfiles,
  planOrcaImport,
  variantUpdateRaw,
} from "@/lib/orcaSlicerImport";

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
 * can link to them. Name collisions with existing rows — ACTIVE or TRASHED
 * alike (a trashed non-purged row is resurrected by the upsert's phase 2,
 * so it collides exactly like an active row; PR #985 P2):
 *   - existing variant of the SAME parent → diff update, or diff resurrect
 *     (phase 2 never touches parentId, so the link survives; idempotent
 *     re-import). The parent-equal prunable keys (`PRUNABLE_RAW_KEYS`)
 *     ride the payload so the GH #403 pruning can clear a stale local
 *     override the profile no longer carries (Codex P2 on PR #985);
 *     everything else stays diff-only so parent-equal values aren't
 *     pinned.
 *   - existing ROOT filament → updated/resurrected in place with the FULL
 *     flattened payload (a diff-only resurrect would leave every inherited
 *     field missing/stale); it is never re-parented
 *   - existing variant of a DIFFERENT parent → skipped with a per-profile
 *     error (a full-payload update would sever its inheritance — the OPT
 *     variant importer's refuse-collision posture)
 *   - a ROOT entry colliding with an existing VARIANT (of anything) →
 *     skipped with a per-profile error, and its planned variants fail with
 *     "parent failed to import": the upsert would keep the row's parentId,
 *     and registering that _id as a parent would create
 *     variants-of-variants, which the app resolves only one level deep
 *     (Codex P2 on PR #985).
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
        // Set only by the same-parent-variant-update branch below — an
        // update/resurrect there always counts toward `variants`, unlike
        // the fresh-create branch which only counts when the write actually
        // created (see the `variants++` guard below).
        let sameParentVariantUpdate = false;
        // Set by every branch below — asserts the branch's parent
        // expectation atomically at write time via
        // upsertParsedBambuFilament's expectedParentId option: `null` means
        // "must currently be a root/standalone", a string means "must
        // currently be a variant of exactly this parent". A concurrent
        // write that changes the row's actual parent between the advisory
        // findCollision() above and the atomic write now fails closed
        // (falls through to the E11000 race-recovery merge, which rejects
        // the mismatch) instead of silently applying a payload baselined
        // against the wrong parent.
        let expectedParentId: string | null | undefined;

        // Advisory pre-check for the collision trees below — the atomic
        // phases in upsertParsedBambuFilament are what actually protect the
        // write (updates never $set parentId, so a re-parent can't slip
        // through a TOCTOU window; worst case a racing delete/trash demotes
        // a collision case to the create or resurrect path). Resolution
        // order mirrors the upsert's own: an ACTIVE row first (phase 1),
        // else a TRASHED non-purged row (phase 2 resurrects it, so it
        // collides exactly like an active row — PR #985 P2).
        const findCollision = async () =>
          ((await Filament.findOne({ name: entry.name, _deletedAt: null })
            .select("parentId")
            .lean()) ??
            (await Filament.findOne({
              name: entry.name,
              _deletedAt: { $ne: null },
              _purged: { $ne: true },
            })
              .select("parentId")
              .lean())) as { parentId?: unknown } | null;

        if (entry.kind === "root") {
          // A root name colliding with an existing VARIANT is refused: the
          // upsert would update/resurrect it without touching parentId, and
          // registering its _id in parentIds below would then create
          // variants-of-variants — the app resolves inheritance one level
          // deep only (Codex P2 on PR #985).
          const existing = await findCollision();
          if (existing?.parentId) {
            errors.push(
              `"${entry.name}": already exists as a variant of another filament — skipped`,
            );
            continue;
          }
          // We just observed no VARIANT at this name (either nothing at
          // all, or a standalone/root row). Assert "must currently be a
          // root/standalone" atomically at write time too, using the exact
          // same expectedParentId machinery the same-parent-variant branch
          // below already relies on — a concurrent write that turns this
          // name into a variant between this check and the atomic write
          // now fails closed (falls through to the E11000 race-recovery
          // merge, which rejects the parent mismatch) instead of landing
          // on the wrong-parent row.
          expectedParentId = null;
        } else {
          const parentDocId = parentIds.get(entry.parentName!);
          if (!parentDocId) {
            errors.push(`"${entry.name}": parent "${entry.parentName}" failed to import`);
            continue;
          }
          const existing = await findCollision();
          if (!existing) {
            // No same-name row at all: create as a variant carrying only
            // its diffs.
            rawPayload = entry.diffRaw!;
            createParentId = parentDocId;
            intendsVariant = true;
            // We intend a fresh create under `parentDocId`. Asserting that
            // expectation costs nothing extra — the E11000 race-recovery
            // merge already unconditionally re-fetches the racing doc on a
            // collision, so this reuses that same fetch to reject a
            // wrong-parent collision instead of silently applying our diff
            // (baselined against parentDocId) onto a row that actually
            // belongs to a different parent.
            expectedParentId = parentDocId;
          } else if (existing.parentId && String(existing.parentId) === parentDocId) {
            // Variant of the same parent — active (diff update) or trashed
            // (diff resurrect; phase 2 keeps its parentId, so the link
            // survives): idempotent re-import either way. The payload is
            // the diff PLUS the parent-equal PRUNABLE_RAW_KEYS from the
            // flattened child — riding those along is what lets the GH
            // #403 pruning in buildStructuredUpdate clear a stale local
            // override the profile no longer carries, instead of leaving
            // the variant stuck on it forever (Codex P2 on PR #985). The
            // groups with no apply-side pruning (settings bag, bed-plate,
            // calibrations) stay diff-only so parent-equal values aren't
            // pinned.
            rawPayload = variantUpdateRaw(entry);
            intendsVariant = true;
            sameParentVariantUpdate = true;
            // P3 on PR #985 (review round 4): if the row is purged between
            // this advisory findCollision() and the atomic upsert below,
            // phase 1/2 both miss and phase 3 falls through to a CREATE —
            // which only links to a parent when `createParentId` is set.
            // Setting it here (even though this branch expects an UPDATE)
            // means a race-triggered fallback create still links to the
            // parent instead of landing as an orphaned, diff-only root
            // missing every inherited field. `sameParentVariantUpdate`
            // (not `createParentId === null`) is what keeps the `variants`
            // counter below correct for the common non-race update path.
            createParentId = parentDocId;
            // We just directly observed
            // `existing.parentId === parentDocId`, so assert that fact
            // atomically at write time too — closes the TOCTOU window
            // where a concurrent write re-homes this row to a different
            // parent between this check and upsertParsedBambuFilament's
            // actual write (which would otherwise silently apply a diff
            // baselined against the WRONG parent).
            expectedParentId = parentDocId;
          } else if (!existing.parentId) {
            // Existing standalone/root filament — active or trashed: update
            // or resurrect it in place with the FULL flattened payload. A
            // diff-only resurrect would leave every inherited field
            // missing/stale on an unlinked row (hyiger P2 on PR #985), and
            // we never silently re-parent a record the user may have
            // created by hand.
            rawPayload = entry.flattenedRaw;
            // Same guard as the other three branches above/below. Without
            // it, a concurrent write re-parenting this row between the
            // advisory check and the atomic write would let the write land
            // anyway (no filter constrains it), leaving the row with
            // content baselined against ONE lineage while parented under a
            // completely different one.
            expectedParentId = null;
          } else {
            errors.push(
              `"${entry.name}": already exists as a variant of a different filament — skipped`,
            );
            continue;
          }
        }

        const parsedPreset = parseBambuStudioProfile(rawPayload);
        const result = await upsertParsedBambuFilament(parsedPreset, {
          parentId: createParentId,
          expectedParentId,
        });
        if (!result.ok) {
          errors.push(
            `"${entry.name}": ${result.error}${result.detail ? ` (${result.detail})` : ""}`,
          );
          continue;
        }

        // A root-kind write could once land on a document that turned out
        // to be a variant of another filament (a race between the advisory
        // findCollision() above and the atomic write), which would then
        // get registered as a parent below and create variants-of-variants
        // for every child planned under it. Every root-kind entry now sets
        // `expectedParentId = null` above, which upsertParsedBambuFilament
        // enforces atomically across all three write paths (Phase 1/2
        // filters + the E11000 race-recovery merge) — a mismatch fails the
        // WRITE itself with `!result.ok` before this line is ever reached,
        // so `result.doc.parentId` is unconditionally falsy here for a
        // root-kind entry. Pinned by the "fails the write closed..."
        // regression test below.

        if (result.created) created++;
        else updated++;
        // A resurrect keeps the trashed row's old parent state, so only a
        // fresh create or a confirmed same-parent update counts as a variant.
        if (intendsVariant && (result.created || createParentId === null || sameParentVariantUpdate)) {
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
        errors.push(`"${entry.name}": ${msg}`);
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
