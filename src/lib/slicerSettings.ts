/**
 * GH #266: the slicer round-trip sync routes (PrusaSlicer / OrcaSlicer)
 * merge every unrecognised body key into a filament's `settings` Mixed
 * bag so slicer-specific config round-trips cleanly on the next export.
 *
 * Pre-fix that merge was unbounded — a caller could mass-assign an
 * arbitrary number of keys, or one multi-megabyte value, into the
 * embedded `settings` field. That document then bloats every subsequent
 * read of the filament (list aggregation, detail page, exports). This
 * helper caps both the total key count and the per-value serialized size
 * so a sync write can't degrade the filament.
 */

/** Max number of keys allowed in the merged `settings` bag. A real
 * slicer filament preset has on the order of ~100 keys; 400 is generous
 * headroom for forks / future keys without being an amplification sink. */
export const MAX_SETTINGS_KEYS = 400;

/** Max serialized length of any single settings value. Slicer values are
 * short scalars or small string arrays; 20k characters is far above any
 * legitimate value. */
export const MAX_SETTING_VALUE_LENGTH = 20_000;

export interface SettingsMergeResult {
  /** The merged bag (existing ∪ incoming non-structured keys). */
  settings: Record<string, unknown>;
  /** Keys that were added/updated from `incoming`. */
  added: string[];
  /** Non-null when a cap was exceeded — the caller should reject with 400. */
  error: string | null;
}

/**
 * Merge `incoming` config keys into a copy of `existing`, skipping any
 * key in `structuredKeys` (those map to first-class Filament fields).
 * Enforces {@link MAX_SETTING_VALUE_LENGTH} per value and
 * {@link MAX_SETTINGS_KEYS} on the resulting bag.
 */
export function mergeSlicerSettings(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  structuredKeys: Set<string>,
): SettingsMergeResult {
  const settings: Record<string, unknown> = { ...existing };
  const added: string[] = [];

  for (const [key, value] of Object.entries(incoming)) {
    if (structuredKeys.has(key)) continue;
    const serialized = JSON.stringify(value ?? null);
    if (serialized.length > MAX_SETTING_VALUE_LENGTH) {
      return {
        settings,
        added,
        error: `settings.${key} value exceeds the ${MAX_SETTING_VALUE_LENGTH}-character limit`,
      };
    }
    settings[key] = value;
    added.push(key);
  }

  if (Object.keys(settings).length > MAX_SETTINGS_KEYS) {
    return {
      settings,
      added,
      error: `settings bag exceeds the ${MAX_SETTINGS_KEYS}-key limit`,
    };
  }

  return { settings, added, error: null };
}
