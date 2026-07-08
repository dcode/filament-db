import Filament from "@/models/Filament";
import { type BambuParseResult } from "@/lib/bambuStudioImport";
import { prepareBambuUpdate, type BambuUpdatePayload } from "@/lib/bambuStudioApply";
import {
  getErrorMessage,
  isClientInputError,
  isDuplicateKeyError,
} from "@/lib/apiErrorHandler";

/**
 * Shared three-phase upsert for a parsed Bambu Studio / OrcaSlicer preset
 * (the two JSON schemas are identical — see src/lib/bambuStudioImport.ts).
 *
 * Extracted verbatim from the POST /api/filaments/bambustudio route so the
 * bulk OrcaSlicer library importer (POST /api/filaments/orcaslicer) can run
 * the exact same battle-hardened upsert per record without the two routes
 * drifting (same rationale as src/lib/iniImportApply.ts for the INI side).
 * The route-level concerns (body ingestion, response envelopes) stay in the
 * routes; this module owns only the write.
 *
 * Pattern mirrors `src/app/api/filaments/import/route.ts` (#327):
 *   1. update an existing ACTIVE row
 *   2. resurrect a TRASHED (non-purged) row
 *   3. create — handling the E11000 race against a concurrent create
 *
 * Each phase uses an atomic `findOneAndUpdate` guarded by the doc's `_id`
 * (and the soft-delete state at the time it was read) so a concurrent
 * soft-delete / purge / restore can't slip through the findOne→write
 * window. `runValidators: true` so the GH #337 numeric validators fire on
 * every write path (Codex P2 round 2).
 *
 * The merge logic in `prepareBambuUpdate` depends on the existing doc
 * (settings carry-over + calibration row dedup), so the payload is
 * recomputed per phase against whatever `existing` was resolved.
 *
 * Expected failures (payload validation, missing required fields, Mongoose
 * validator rejections) come back as `{ ok: false, status, error }` so the
 * bulk caller can degrade them to per-profile errors; unexpected errors
 * (driver faults etc.) propagate to the caller's catch, exactly as they
 * did when this code lived in the route.
 */
export interface BambuUpsertOptions {
  /**
   * Parent filament id to link on the CREATE branch only (phase 3). The
   * update phases (1, 2, and the E11000 race-update) deliberately IGNORE
   * this — an existing row is never silently re-parented by an import.
   */
  parentId?: string | null;
  /**
   * When set, every UPDATE path (phase 1's atomic filter, phase 2's atomic
   * filter, AND the E11000 race-recovery merge) additionally requires the
   * matched row's CURRENT `parentId` to equal this value — `null` means
   * "must currently be a root/standalone". This closes a TOCTOU window: a
   * caller that observed a specific parent for this name via its own
   * advisory pre-check can assert that observation still holds at write
   * time, instead of silently applying a payload that was computed against
   * a baseline that may no longer match reality. A filter mismatch on
   * phase 1/2 falls through exactly like "row deleted mid-flight" already
   * does; a mismatch on the
   * race-recovery merge returns a distinct 409 so the caller can surface a
   * clean per-item error instead of corrupting the row. Omit (the default)
   * to preserve the original no-expectation behavior — every existing
   * caller that doesn't pass this is unaffected.
   */
  expectedParentId?: string | null;
}

export type BambuUpsertResult =
  | {
      ok: true;
      created: boolean;
      doc: { _id: unknown; name: string; parentId?: unknown };
      payload: BambuUpdatePayload;
    }
  | { ok: false; status: number; error: string; detail?: string };

/**
 * Per-phase validation gate for a prepared Bambu update: the settings-bag
 * size-cap error AND the GH #892 inverted-nozzle-range guard (min > max,
 * which the per-field 0–600 schema validators can't express — matching the
 * OrcaSlicer sync route). Returns a failure result, or null when the
 * payload is clean. Used at every upsert phase so the guard can't be
 * dropped from one of them.
 */
function bambuPayloadFailure(payload: BambuUpdatePayload): BambuUpsertResult | null {
  if (payload.settingsResult.error) {
    return { ok: false, status: 400, error: payload.settingsResult.error };
  }
  if (payload.nozzleRangeInverted) {
    return {
      ok: false,
      status: 400,
      error:
        "Nozzle range minimum temperature must be less than or equal to the maximum",
    };
  }
  return null;
}

/**
 * Map a caught error to a failure result the same way the route's
 * `errorResponseFromCaught` did: client-input rejections (Mongoose
 * validators etc.) become a 400 with the real message; anything else keeps
 * the fallback message at 500 with the underlying message as detail.
 */
function failureFromCaught(err: unknown, fallbackMessage: string): BambuUpsertResult {
  if (isClientInputError(err)) {
    return { ok: false, status: 400, error: getErrorMessage(err) };
  }
  return { ok: false, status: 500, error: fallbackMessage, detail: getErrorMessage(err) };
}

const INVALID_VALUES_MESSAGE = "Bambu Studio profile contained invalid values";

/**
 * Upsert a parsed preset by name through the three-phase pipeline.
 * Caller is responsible for `dbConnect()`.
 */
export async function upsertParsedBambuFilament(
  parsed: BambuParseResult,
  opts?: BambuUpsertOptions,
): Promise<BambuUpsertResult> {
  const name = parsed.filament.name;

  // Phase 1 — active update.
  const existingActive = await Filament.findOne({
    name,
    _deletedAt: null,
  });
  if (existingActive) {
    const payload = await prepareBambuUpdate(
      parsed,
      await augmentExistingWithParent(existingActive),
    );
    const payloadFailure = bambuPayloadFailure(payload);
    if (payloadFailure) return payloadFailure;
    delete (payload.update as Record<string, unknown>).spools;
    try {
      const updateFilter: Record<string, unknown> = {
        _id: existingActive._id,
        _deletedAt: null,
      };
      if (opts?.expectedParentId !== undefined) {
        updateFilter.parentId = opts.expectedParentId;
      }
      const updated = await Filament.findOneAndUpdate(
        updateFilter,
        composeMongoUpdate(payload),
        { runValidators: true, context: "query", returnDocument: "after" },
      );
      if (updated) {
        return { ok: true, created: false, doc: updated, payload };
      }
    } catch (validationErr) {
      return failureFromCaught(validationErr, INVALID_VALUES_MESSAGE);
    }
    // Phase-1 update returned null → either the row was deleted between
    // our findOne and the atomic write, OR (when expectedParentId is set)
    // its parent no longer matches what the caller expected. Fall through
    // to phase 2 / 3 either way.
  }

  // Phase 2 — resurrect a trashed (non-purged) row of the same name
  // rather than creating a duplicate that would strand the trashed
  // record (its restore would 409 forever on the name conflict).
  // (Codex P1 on PR #387 round 5.)
  const existingTrashed = await Filament.findOne({
    name,
    _deletedAt: { $ne: null },
    _purged: { $ne: true },
  });
  if (existingTrashed) {
    const payload = await prepareBambuUpdate(
      parsed,
      await augmentExistingWithParent(existingTrashed),
    );
    const payloadFailure = bambuPayloadFailure(payload);
    if (payloadFailure) return payloadFailure;
    delete (payload.update as Record<string, unknown>).spools;
    try {
      // Splice `_deletedAt: null` into the $set body so the resurrect
      // atomic also drops the tombstone; $unset (if any) for stale
      // variant overrides composes alongside.
      const resurrectUpdate = composeMongoUpdate(payload);
      resurrectUpdate.$set = {
        ...(resurrectUpdate.$set as Record<string, unknown>),
        _deletedAt: null,
      };
      const resurrectFilter: Record<string, unknown> = {
        _id: existingTrashed._id,
        _deletedAt: { $ne: null },
        _purged: { $ne: true },
      };
      if (opts?.expectedParentId !== undefined) {
        resurrectFilter.parentId = opts.expectedParentId;
      }
      const resurrected = await Filament.findOneAndUpdate(
        resurrectFilter,
        resurrectUpdate,
        { runValidators: true, context: "query", returnDocument: "after" },
      );
      if (resurrected) {
        return { ok: true, created: false, doc: resurrected, payload };
      }
    } catch (validationErr) {
      return failureFromCaught(validationErr, INVALID_VALUES_MESSAGE);
    }
    // Phase-2 returned null → the row was purged/restored between findOne
    // and write, OR (when expectedParentId is set) its parent no longer
    // matches. Fall through to phase 3 either way.
  }

  // Phase 3 — create. Required fields (vendor + type) must be present
  // in the profile or the create can't satisfy the schema.
  if (!parsed.filament.type) {
    return {
      ok: false,
      status: 400,
      error:
        "Bambu Studio profile is missing filament_type — required to create a new filament",
    };
  }
  if (!parsed.filament.vendor) {
    return {
      ok: false,
      status: 400,
      error:
        "Bambu Studio profile is missing filament_vendor — required to create a new filament",
    };
  }

  const createPayload = await prepareBambuUpdate(parsed, null);
  const createPayloadFailure = bambuPayloadFailure(createPayload);
  if (createPayloadFailure) return createPayloadFailure;
  try {
    const created = await Filament.create({
      name,
      ...(opts?.parentId ? { parentId: opts.parentId } : {}),
      ...createPayload.update,
    });
    return { ok: true, created: true, doc: created, payload: createPayload };
  } catch (createErr) {
    // Codex P2 on PR #387 round 5: another concurrent import created
    // a row with the same name between our phase-1 findOne and our
    // create. Recompute the payload against THAT row (its settings
    // and calibrations[] differ from the null baseline used above)
    // and update it as if we'd taken the phase-1 path.
    if (!isDuplicateKeyError(createErr)) {
      return failureFromCaught(createErr, "Failed to create filament");
    }
    const racing = await Filament.findOne({ name, _deletedAt: null });
    if (!racing) {
      // The winning row was already deleted; bail out with the
      // original error rather than spinning.
      return failureFromCaught(createErr, "Failed to create filament");
    }
    if (opts?.expectedParentId !== undefined) {
      const racingParentIdStr = racing.parentId ? String(racing.parentId) : null;
      if (racingParentIdStr !== opts.expectedParentId) {
        // The row that won the create race belongs to a different parent
        // than the caller expected — applying `parsed` (a payload baselined
        // against the EXPECTED parent) here would silently write a diff
        // computed against the wrong baseline onto it. Refuse with a
        // distinct error instead of merging blind.
        return {
          ok: false,
          status: 409,
          error:
            "Collision: an existing filament of this name belongs to a different parent than expected",
        };
      }
    }
    const racePayload = await prepareBambuUpdate(
      parsed,
      await augmentExistingWithParent(racing),
    );
    const racePayloadFailure = bambuPayloadFailure(racePayload);
    if (racePayloadFailure) return racePayloadFailure;
    delete (racePayload.update as Record<string, unknown>).spools;
    try {
      const merged = await Filament.findOneAndUpdate(
        { _id: racing._id, _deletedAt: null },
        composeMongoUpdate(racePayload),
        { runValidators: true, context: "query", returnDocument: "after" },
      );
      if (!merged) {
        return failureFromCaught(createErr, "Failed to create filament");
      }
      return { ok: true, created: false, doc: merged, payload: racePayload };
    } catch (validationErr) {
      return failureFromCaught(validationErr, INVALID_VALUES_MESSAGE);
    }
  }
}

/**
 * GH #403: load the parent doc when `existing` is a variant, so
 * `prepareBambuUpdate` → `buildStructuredUpdate` can skip pinning
 * inheritable scalars whose parsed value already matches the parent
 * (keeps inheritance live). A no-op for root filaments.
 */
async function augmentExistingWithParent(existing: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}) {
  let parent: Record<string, unknown> | null = null;
  if (existing.parentId) {
    parent = (await Filament.findOne({
      _id: existing.parentId,
      _deletedAt: null,
    }).lean()) as Record<string, unknown> | null;
  }
  return {
    // Codex P1 on PR #473 round 2: inheritable scalars MUST ride along
    // so `buildStructuredUpdate` can detect a stale variant override
    // (variant=1.30, parent=1.24, import=1.24 → emit $unset). Pre-fix
    // these were stripped, making the $unset branch unreachable in
    // the actual route even though unit tests passed against a richer
    // shape.
    type: existing.type ?? null,
    vendor: existing.vendor ?? null,
    // GH #883: ride color + secondaryColors along so resolveSyncBackColor can
    // detect the coextruded shape and suppress the exported-secondary echo.
    color: existing.color ?? null,
    secondaryColors: existing.secondaryColors ?? null,
    diameter: existing.diameter ?? null,
    density: existing.density ?? null,
    cost: existing.cost ?? null,
    maxVolumetricSpeed: existing.maxVolumetricSpeed ?? null,
    shrinkageXY: existing.shrinkageXY ?? null,
    shrinkageZ: existing.shrinkageZ ?? null,
    temperatures: existing.temperatures,
    bedTypeTemps: existing.bedTypeTemps,
    settings: existing.settings,
    calibrations: existing.calibrations,
    parentId: existing.parentId ? String(existing.parentId) : null,
    parent,
  };
}

/** Codex P1 on PR #473: when the parsed Bambu value equals the parent
 *  and the variant carries a stale local override, `prepareBambuUpdate`
 *  flags those fields in `unsetKeys` so they can be cleared. Compose a
 *  Mongo update body that carries both `$set` and (when needed) `$unset`
 *  in one atomic write — the resurrection branch then splices
 *  `_deletedAt: null` into the `$set` portion. */
function composeMongoUpdate(payload: BambuUpdatePayload): Record<string, unknown> {
  const out: Record<string, unknown> = { $set: payload.update };
  if (payload.unsetKeys.length > 0) {
    out.$unset = Object.fromEntries(payload.unsetKeys.map((k) => [k, ""]));
  }
  return out;
}
