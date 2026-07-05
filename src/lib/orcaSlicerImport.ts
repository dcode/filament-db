/**
 * OrcaSlicer filament-library import — the pure (DB-free) half.
 *
 * The OrcaSlicer system library (`…/OrcaSlicer/system/OrcaFilamentLibrary/
 * filament/**.json`) is a forest of presets linked by an `inherits` field:
 * a vendor profile inherits a generic one, which inherits an abstract
 * `fdm_filament_*` template (chains can be 3+ levels). A preset only stores
 * the keys it overrides, so importing one file in isolation loses most of
 * its values — the chain has to be resolved first.
 *
 * This module owns everything up to (but not including) the database:
 *   - indexing raw preset JSONs by `name` (the key `inherits` references)
 *   - classifying abstract templates (`instantiation: "false"`) vs concrete
 *   - resolving + flattening `inherits` chains (child key wins)
 *   - planning the import: which profiles become parent records, which
 *     become variants, and the raw-key diff each variant stores
 *
 * Everything stays in RAW Orca-key space (values remain single-element
 * string arrays); the route feeds the planned payloads to the existing
 * `parseBambuStudioProfile` (Bambu Studio JSON ≡ OrcaSlicer JSON) so all
 * unwrap/coercion/settings-bag machinery is reused unchanged.
 *
 * Mapping onto Filament DB's one-level parent/variant model:
 *   - Abstract templates are NEVER imported as records — they only flatten
 *     into their descendants (a record named "fdm_filament_pla" with no
 *     vendor would be noise, not a filament).
 *   - Each selected concrete profile's parent is its ROOT CONCRETE ANCESTOR
 *     (the top-most `instantiation: "true"` profile in its chain), imported
 *     as a root record with its own abstract ancestors baked in. The
 *     selected profile becomes a variant storing only its diffs; unset
 *     fields inherit dynamically via `resolveFilament` (GH #106).
 *   - Chains with 3+ concrete levels COLLAPSE TO THE CONCRETE ROOT
 *     (Filament DB bans variants-of-variants): in a concrete chain
 *     C → B → A, both B and C become direct variants of A, each diffed
 *     against flat(A) — nothing is lost because the diff is computed
 *     against the collapsed parent's full flattened values.
 *
 * This module is also imported client-side by the import dialog (folder
 * scan + ancestor-closure collection), so it must stay DB- and Node-free.
 */

import { BED_PLATE_KEYS, CALIBRATION_KEYS } from "@/lib/bambuStudioImport";

/** One profile from the submitted set, indexed by `name`. */
export interface OrcaProfileNode {
  /** `name` key — the identifier `inherits` references. */
  name: string;
  /** The original JSON object, untouched. */
  raw: Record<string, unknown>;
  /** False only for `instantiation: "false"` templates. */
  concrete: boolean;
  /** `inherits` value, undefined when absent/empty. */
  inheritsName?: string;
}

export interface OrcaImportPlanEntry {
  kind: "root" | "variant";
  name: string;
  /**
   * Full flattened raw keys. For roots this is the import payload; for
   * variants it's the fallback payload when the name collides with an
   * existing standalone (non-variant) filament, which is updated in place
   * with full values rather than re-parented.
   */
  flattenedRaw: Record<string, unknown>;
  /** Variant only: name of the planned parent record (a root entry earlier in the list). */
  parentName?: string;
  /** Variant only: raw-key diff vs the parent's flattenedRaw. */
  diffRaw?: Record<string, unknown>;
}

export interface OrcaImportPlan {
  /** Topologically ordered: all roots first, then variants. */
  entries: OrcaImportPlanEntry[];
  /** Per-profile failures (missing base, cycle, abstract selection, …). */
  errors: string[];
}

/**
 * Mirror of `unwrap` in bambuStudioImport.ts (module-private there):
 * collapse the Orca single-element-array convention to a scalar string,
 * returning undefined for absent/empty values.
 */
function unwrapString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    if (value.length === 0) return undefined;
    const first = value[0];
    if (first == null) return undefined;
    const s = String(first);
    return s === "" ? undefined : s;
  }
  if (typeof value === "string") return value === "" ? undefined : value;
  return String(value);
}

/**
 * Identity / bookkeeping keys that are never inherited across the chain —
 * a child must not adopt its ancestor's `filament_id` or `setting_id` (they
 * identify the ANCESTOR's row in the vendor catalog). `inherits`,
 * `instantiation` and `from` are additionally stripped from flattened
 * output entirely (see flattenOrcaProfile).
 */
const NON_INHERITED_KEYS = new Set<string>([
  "name",
  "filament_settings_id",
  "setting_id",
  "filament_id",
  "renamed_from",
  "inherits",
  "instantiation",
  "from",
]);

/**
 * Keys a variant diff ALWAYS keeps (when present on the flattened child),
 * even when equal to the parent:
 *   - `name` — the record's identity.
 *   - `filament_type` / `filament_vendor` — schema-required on create
 *     (mirrors optResync's PRUNE_SKIP_FIELDS posture).
 *   - `filament_colour` / `filament_color` — `color` is variant-only in
 *     resolveFilament (never inherited), so dropping it would leave the
 *     variant at the gray default, not at the parent's color.
 *   - `filament_id` / `setting_id` — the vendor-catalog identity of THIS
 *     preset; inheriting the parent's via the settings bag would mislabel
 *     the variant.
 */
const DIFF_ALWAYS_KEEP = new Set<string>([
  "name",
  "filament_type",
  "filament_vendor",
  "filament_colour",
  "filament_color",
  "filament_id",
  "setting_id",
]);

/**
 * The calibration-context keys that must ride along whenever the
 * calibration group is kept (see the atomicity note in diffOrcaRaw):
 * without a printer hint the route can't resolve the variant's own
 * calibrations[] row and the differing values would land unresolved.
 */
const CALIBRATION_CONTEXT_KEYS = [
  "printer_settings_id",
  "compatible_printers",
  "compatible_printers_condition",
];

/**
 * `instantiation: "false"` (string, possibly array-wrapped) marks an
 * abstract template. Anything else — including a missing key — counts as
 * concrete (library leaves always say "true", but hand-rolled presets may
 * omit the key entirely).
 */
export function isConcreteOrcaProfile(raw: Record<string, unknown>): boolean {
  const v = unwrapString(raw.instantiation);
  return v == null || v.trim().toLowerCase() !== "false";
}

/**
 * Index raw preset JSONs by `name`. Malformed entries (non-objects,
 * nameless profiles, duplicate names) are reported in `errors` and skipped
 * — one bad file must not sink the batch. On a duplicate name the FIRST
 * occurrence wins (deterministic, and matches how OrcaSlicer itself
 * resolves an `inherits` reference to a single profile).
 */
export function indexOrcaProfiles(raws: unknown[]): {
  byName: Map<string, OrcaProfileNode>;
  errors: string[];
} {
  const byName = new Map<string, OrcaProfileNode>();
  const errors: string[] = [];
  raws.forEach((raw, i) => {
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
      errors.push(`profile at index ${i} is not a JSON object`);
      return;
    }
    const obj = raw as Record<string, unknown>;
    const name = unwrapString(obj.name);
    if (!name) {
      errors.push(`profile at index ${i} has no "name"`);
      return;
    }
    if (byName.has(name)) {
      errors.push(`duplicate profile name "${name}" — first occurrence wins`);
      return;
    }
    byName.set(name, {
      name,
      raw: obj,
      concrete: isConcreteOrcaProfile(obj),
      inheritsName: unwrapString(obj.inherits),
    });
  });
  return { byName, errors };
}

/**
 * Walk the `inherits` chain from `name` upward. Returns `[self, parent,
 * grandparent, …]`. Throws (with a per-profile message the planner turns
 * into a per-profile error) on an unknown name, a base missing from the
 * submitted set, or a cycle.
 */
export function resolveOrcaChain(
  name: string,
  byName: Map<string, OrcaProfileNode>,
): OrcaProfileNode[] {
  const head = byName.get(name);
  if (!head) {
    throw new Error(`profile "${name}" not found in the submitted set`);
  }
  const chain: OrcaProfileNode[] = [head];
  const visited = new Set<string>([name]);
  let cur = head;
  while (cur.inheritsName) {
    const next = byName.get(cur.inheritsName);
    if (!next) {
      throw new Error(
        `inherits "${cur.inheritsName}" not found in the submitted set — include the base profile`,
      );
    }
    if (visited.has(next.name)) {
      throw new Error(`inheritance cycle detected at "${next.name}"`);
    }
    chain.push(next);
    visited.add(next.name);
    cur = next;
  }
  return chain;
}

/**
 * Merge a profile's chain root-first so the child's keys win — Orca's own
 * semantics ("a preset stores only the keys it overrides"). Identity keys
 * (NON_INHERITED_KEYS) come only from the profile itself, never an
 * ancestor. The output:
 *   - strips `inherits` — parseBambuStudioProfile doesn't know the key, so
 *     it would leak into the settings bag; and the model's `inherits`
 *     column is PrusaSlicer provenance, where a library template name
 *     would export as a dangling INI reference.
 *   - strips `instantiation` + `from` (schema bookkeeping).
 *   - strips `filament_settings_id` and forces `name` — the parser prefers
 *     `filament_settings_id` for the record name, and the import plan is
 *     keyed on `name` (what `inherits` references); letting the two
 *     diverge would break parent linking and re-import idempotency.
 * Values stay in raw form (single-element string arrays untouched).
 */
export function flattenOrcaProfile(
  name: string,
  byName: Map<string, OrcaProfileNode>,
): Record<string, unknown> {
  const chain = resolveOrcaChain(name, byName);
  const out: Record<string, unknown> = {};
  for (let i = chain.length - 1; i >= 0; i--) {
    const node = chain[i];
    const isSelf = i === 0;
    for (const [key, value] of Object.entries(node.raw)) {
      if (!isSelf && NON_INHERITED_KEYS.has(key)) continue;
      out[key] = value;
    }
  }
  delete out.inherits;
  delete out.instantiation;
  delete out.from;
  delete out.filament_settings_id;
  out.name = name;
  return out;
}

/** JSON-stringify deep equality — safe here because values are plain JSON
 * (strings / single-element string arrays) with stable key-free shapes. */
function rawValuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compute the raw-key diff a variant stores against its planned parent.
 * Per-key semantics match how the variant resolves later: scalars and
 * settings-bag keys inherit per-key (resolveFilament shallow-merges the
 * bag), so equal keys are simply dropped.
 *
 * Two ATOMIC GROUPS deviate from per-key dropping, because their DB homes
 * inherit as whole arrays (a variant either owns the whole array or
 * inherits the parent's — resolveFilament, GH #106/#477):
 *   - BED plate keys → `bedTypeTemps[]`: if ANY plate key differs, keep
 *     ALL plate keys present on the flattened child.
 *   - CALIBRATION keys → `calibrations[]`: same rule; additionally keep
 *     the printer-context keys (printer_settings_id etc.) so the route can
 *     resolve the variant's own calibration row.
 */
export function diffOrcaRaw(
  flatChild: Record<string, unknown>,
  flatParent: Record<string, unknown>,
): Record<string, unknown> {
  const childKeys = Object.keys(flatChild);
  const plateKeys = childKeys.filter((k) => k in BED_PLATE_KEYS);
  const calibrationKeys = childKeys.filter((k) => CALIBRATION_KEYS.has(k));

  const anyPlateDiffers = plateKeys.some(
    (k) => !rawValuesEqual(flatChild[k], flatParent[k]),
  );
  const anyCalibrationDiffers = calibrationKeys.some(
    (k) => !rawValuesEqual(flatChild[k], flatParent[k]),
  );

  const out: Record<string, unknown> = {};
  for (const key of childKeys) {
    const keep =
      DIFF_ALWAYS_KEEP.has(key) ||
      (key in BED_PLATE_KEYS
        ? anyPlateDiffers
        : CALIBRATION_KEYS.has(key)
          ? anyCalibrationDiffers
          : !rawValuesEqual(flatChild[key], flatParent[key]));
    if (keep) out[key] = flatChild[key];
  }
  if (anyCalibrationDiffers) {
    for (const key of CALIBRATION_CONTEXT_KEYS) {
      if (key in flatChild) out[key] = flatChild[key];
    }
  }
  return out;
}

/**
 * The whole planning pipeline: map the user's selection to an ordered list
 * of root + variant import entries. Per-profile failures land in `errors`
 * (with the profile name prefixed) and never abort the rest of the plan.
 *
 * Rules (see the module docblock for rationale):
 *   1. A selected name missing from the set, or naming an abstract
 *      template, is a per-profile error.
 *   2. A selected profile's parent is its root concrete ancestor, which is
 *      auto-planned as a root entry even when not itself selected
 *      (deduped — selecting both the root and a variant of it yields one
 *      root entry).
 *   3. Concrete chains deeper than two levels collapse to the concrete
 *      root; intermediate concrete profiles are only imported when
 *      selected themselves (as variants of the same root).
 *   4. A selected profile with no concrete ancestor imports as a root with
 *      its full flattened payload.
 */
export function planOrcaImport(
  selectedNames: string[],
  byName: Map<string, OrcaProfileNode>,
): OrcaImportPlan {
  const errors: string[] = [];
  const rootEntries = new Map<string, OrcaImportPlanEntry>();
  const variantEntries: OrcaImportPlanEntry[] = [];
  const plannedVariants = new Set<string>();

  const ensureRoot = (name: string): OrcaImportPlanEntry => {
    let entry = rootEntries.get(name);
    if (!entry) {
      entry = {
        kind: "root",
        name,
        flattenedRaw: flattenOrcaProfile(name, byName),
      };
      rootEntries.set(name, entry);
    }
    return entry;
  };

  for (const name of new Set(selectedNames)) {
    if (rootEntries.has(name) || plannedVariants.has(name)) continue;
    const node = byName.get(name);
    if (!node) {
      errors.push(`"${name}": not found in the submitted profiles`);
      continue;
    }
    if (!node.concrete) {
      errors.push(
        `"${name}": abstract template (instantiation: false) — templates are merged into their descendants, not imported`,
      );
      continue;
    }
    try {
      const chain = resolveOrcaChain(name, byName);
      // Root concrete ancestor = the LAST concrete node above self in the
      // chain (top-most / closest to the chain root).
      let rootNode: OrcaProfileNode | undefined;
      for (let i = chain.length - 1; i >= 1; i--) {
        if (chain[i].concrete) {
          rootNode = chain[i];
          break;
        }
      }
      if (!rootNode) {
        ensureRoot(name);
        continue;
      }
      const parentEntry = ensureRoot(rootNode.name);
      const flattenedRaw = flattenOrcaProfile(name, byName);
      variantEntries.push({
        kind: "variant",
        name,
        flattenedRaw,
        parentName: rootNode.name,
        diffRaw: diffOrcaRaw(flattenedRaw, parentEntry.flattenedRaw),
      });
      plannedVariants.add(name);
    } catch (err) {
      errors.push(`"${name}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { entries: [...rootEntries.values(), ...variantEntries], errors };
}
