"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { useTranslation } from "@/i18n/TranslationProvider";
import {
  collectOrcaClosure,
  indexOrcaProfiles,
  isNonFilamentOrcaPath,
  isOrcaFilamentPreset,
  orcaProfileMeta,
  type OrcaProfileNode,
} from "@/lib/orcaSlicerImport";

interface Props {
  onClose: () => void;
  /** Called with a ready-to-toast summary after a successful import. */
  onImported: (message: string) => void;
}

interface ImportResponse {
  created: number;
  updated: number;
  variants: number;
  filaments: string[];
  calibrationApplied: number;
  calibrationUnresolved: number;
  errors?: string[];
}

interface PickerRow {
  name: string;
  vendor?: string;
  material?: string;
}

/** Client-side mirror of the route's 10k profile cap. */
const MAX_FILES = 10_000;

/**
 * Modal dialog for importing the OrcaSlicer filament library
 * (`…/OrcaSlicer/system/OrcaFilamentLibrary/filament`) via a directory
 * upload. The folder is read and parsed locally (`webkitdirectory`), the
 * user picks concrete profiles from a searchable/filterable list, and the
 * selection plus its `inherits` ancestor closure is POSTed to
 * `/api/filaments/orcaslicer`, which resolves inheritance server-side and
 * links base profiles as parents. Abstract templates never show in the
 * picker — they only merge into their descendants.
 *
 * The picker also accepts a directory ABOVE `filament/` — e.g. the whole
 * `OrcaSlicer` config root — which is useful when a user profile
 * `inherits` a system-library base: both trees need to be in the parsed
 * set for `collectOrcaClosure` to resolve the chain (see the module
 * docblock on `src/lib/orcaSlicerImport.ts`). `webkitdirectory` recurses
 * into subdirectories, so one folder pick covers `system/` and `user/`
 * together; `isNonFilamentOrcaPath` + `isOrcaFilamentPreset` filter the
 * sibling `machine/`/`process/` trees back out so only filament presets
 * reach the picker.
 */
export default function OrcaLibraryImportDialog({ onClose, onImported }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [byName, setByName] = useState<Map<string, OrcaProfileNode> | null>(null);
  const [scanInfo, setScanInfo] = useState<{ found: number; skipped: number } | null>(null);
  const [scanning, setScanning] = useState(false);
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [materialFilter, setMaterialFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<ImportResponse | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  // Abort the in-flight import on unmount / on a new submit (GH #319 pattern).
  const acRef = useRef<AbortController | null>(null);
  useEffect(() => () => acRef.current?.abort(), []);

  // Focus capture/restore + Tab loop + initial focus, mirroring
  // SpoolCsvImportDialog (GH #522.1 / Codex P2 #540: filter to VISIBLE
  // focusables so the hidden folder input can't become a Tab boundary).
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const collectFocusable = (): HTMLElement[] => {
      if (!dialogRef.current) return [];
      return Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter(
        (el) =>
          !el.hasAttribute("inert") &&
          !el.hasAttribute("hidden") &&
          el.offsetParent !== null,
      );
    };
    const focusableOnOpen = collectFocusable();
    (focusableOnOpen[0] ?? dialogRef.current)?.focus();

    const handleKeydown = (e: KeyboardEvent) => {
      if (e.key !== "Tab" || !dialogRef.current) return;
      const focusable = collectFocusable();
      if (focusable.length === 0) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", handleKeydown);
    return () => {
      document.removeEventListener("keydown", handleKeydown);
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleFolder = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const allFiles = Array.from(e.target.files ?? []).filter((f) =>
      f.name.toLowerCase().endsWith(".json"),
    );
    if (folderInputRef.current) folderInputRef.current.value = "";
    if (allFiles.length === 0) {
      setByName(new Map());
      setScanInfo({ found: 0, skipped: 0 });
      return;
    }
    setScanning(true);
    try {
      // Drop machine/process directories up front — by PATH, without
      // parsing — when the user picked a folder above `filament/` (e.g.
      // the whole OrcaSlicer config directory). Content sniffing alone
      // can't always tell (some machine/process presets omit `type`).
      let skipped = 0;
      const files = allFiles.filter((f) => {
        const relPath = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
        if (isNonFilamentOrcaPath(relPath)) {
          skipped++;
          return false;
        }
        return true;
      });
      const raws: unknown[] = [];
      for (const file of files.slice(0, MAX_FILES)) {
        try {
          const parsed: unknown = JSON.parse(await file.text());
          // Only filament presets belong in the picker — a defense-in-depth
          // content check for files the path filter above didn't catch.
          if (isOrcaFilamentPreset(parsed)) raws.push(parsed);
          else skipped++;
        } catch {
          skipped++;
        }
      }
      skipped += Math.max(0, files.length - MAX_FILES);
      const indexed = indexOrcaProfiles(raws);
      skipped += indexed.errors.length;
      setByName(indexed.byName);
      setScanInfo({
        found: [...indexed.byName.values()].filter((n) => n.concrete).length,
        skipped,
      });
      setSelected(new Set());
      setResults(null);
    } finally {
      setScanning(false);
    }
  };

  // Picker rows: concrete profiles only (abstract templates merge into
  // their descendants and are never records).
  const rows = useMemo<PickerRow[]>(() => {
    if (!byName) return [];
    return [...byName.values()]
      .filter((n) => n.concrete)
      .map((n) => ({ name: n.name, ...orcaProfileMeta(n, byName) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [byName]);

  const vendors = useMemo(
    () => [...new Set(rows.map((r) => r.vendor).filter((v): v is string => !!v))].sort(),
    [rows],
  );
  const materials = useMemo(
    () => [...new Set(rows.map((r) => r.material).filter((m): m is string => !!m))].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(
      (r) =>
        (!vendorFilter || r.vendor === vendorFilter) &&
        (!materialFilter || r.material === materialFilter) &&
        (!q ||
          r.name.toLowerCase().includes(q) ||
          r.vendor?.toLowerCase().includes(q) ||
          r.material?.toLowerCase().includes(q)),
    );
  }, [rows, search, vendorFilter, materialFilter]);

  const toggle = (name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const handleSubmit = async () => {
    if (selected.size === 0 || submitting || !byName) return;
    setSubmitting(true);
    setResults(null);
    acRef.current?.abort();
    const ac = new AbortController();
    acRef.current = ac;
    try {
      const selectedNames = [...selected];
      const res = await fetch("/api/filaments/orcaslicer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selected: selectedNames,
          profiles: collectOrcaClosure(selectedNames, byName),
        }),
        signal: ac.signal,
      });
      const body = await res.json().catch(() => null);
      if (ac.signal.aborted) return;
      if (!res.ok) {
        toast(t("filaments.importFailed", { error: body?.error ?? res.status }), "error");
        return;
      }
      const data = body as ImportResponse;
      setResults(data);
      if (data.created + data.updated > 0) {
        onImported(
          t("orcaImport.success", { created: data.created, updated: data.updated }),
        );
      }
    } catch (err) {
      if (ac.signal.aborted || (err instanceof DOMException && err.name === "AbortError")) return;
      toast(t("filaments.importNetworkError"), "error");
    } finally {
      if (!ac.signal.aborted) setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="orca-import-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl max-w-3xl w-full mx-4 max-h-[85vh] flex flex-col"
      >
        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
          <h2 id="orca-import-title" className="text-lg font-semibold">
            {t("orcaImport.dialogTitle")}
          </h2>
          <p className="text-sm text-gray-500 mt-1">{t("orcaImport.dialogDescription")}</p>
        </div>

        <div className="p-4 overflow-y-auto flex-1">
          <div className="flex items-center gap-2 mb-3">
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFolder}
              // React has no type for the directory-picker attribute; the
              // spread keeps TS/lint quiet while emitting webkitdirectory.
              {...({ webkitdirectory: "" } as React.InputHTMLAttributes<HTMLInputElement>)}
            />
            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={scanning}
              className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 disabled:opacity-50"
            >
              {scanning ? t("orcaImport.scanning") : t("orcaImport.chooseFolder")}
            </button>
            {scanInfo && (
              <span className="text-xs text-gray-500">
                {t("orcaImport.parsedSummary", {
                  count: scanInfo.found,
                  skipped: scanInfo.skipped,
                })}
              </span>
            )}
          </div>

          {scanInfo && rows.length === 0 && !scanning && (
            <p className="text-sm text-gray-500">{t("orcaImport.noProfiles")}</p>
          )}

          {rows.length > 0 && (
            <>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t("orcaImport.searchPlaceholder")}
                  aria-label={t("orcaImport.searchPlaceholder")}
                  className="flex-1 min-w-40 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-transparent"
                />
                <select
                  value={vendorFilter}
                  onChange={(e) => setVendorFilter(e.target.value)}
                  aria-label={t("orcaImport.allVendors")}
                  className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-transparent dark:bg-gray-900"
                >
                  <option value="">{t("orcaImport.allVendors")}</option>
                  {vendors.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
                <select
                  value={materialFilter}
                  onChange={(e) => setMaterialFilter(e.target.value)}
                  aria-label={t("orcaImport.allMaterials")}
                  className="px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-transparent dark:bg-gray-900"
                >
                  <option value="">{t("orcaImport.allMaterials")}</option>
                  {materials.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center gap-2 mb-2 text-xs">
                <button
                  type="button"
                  onClick={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      for (const r of filtered) next.add(r.name);
                      return next;
                    })
                  }
                  className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400"
                >
                  {t("orcaImport.selectAllFiltered", { count: filtered.length })}
                </button>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  disabled={selected.size === 0}
                  className="px-2 py-1 border border-gray-300 dark:border-gray-600 rounded hover:border-gray-400 disabled:opacity-50"
                >
                  {t("orcaImport.clearSelection")}
                </button>
                <span className="text-gray-500 ml-auto">
                  {t("orcaImport.selectedCount", { count: selected.size })}
                </span>
              </div>

              <div className="max-h-72 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded">
                {filtered.map((r) => (
                  <label
                    key={r.name}
                    className="flex items-center gap-2 px-2 py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-b-0 text-sm cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(r.name)}
                      onChange={() => toggle(r.name)}
                    />
                    <span className="flex-1 truncate">{r.name}</span>
                    <span className="text-xs text-gray-500 flex-shrink-0">
                      {[r.vendor, r.material].filter(Boolean).join(" · ")}
                    </span>
                  </label>
                ))}
                {filtered.length === 0 && (
                  <p className="px-2 py-3 text-sm text-gray-500">
                    {t("orcaImport.noMatches")}
                  </p>
                )}
              </div>
            </>
          )}

          {results && (
            <div className="mt-4">
              <p className="text-sm">
                {t("orcaImport.resultsSummary", {
                  created: results.created,
                  updated: results.updated,
                  variants: results.variants,
                })}
              </p>
              {results.errors && results.errors.length > 0 && (
                <>
                  <h3 className="text-sm font-medium mt-2 mb-1 text-red-700 dark:text-red-400">
                    {t("orcaImport.errorsHeading", { count: results.errors.length })}
                  </h3>
                  <div className="max-h-40 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded text-xs">
                    {results.errors.map((err) => (
                      <p
                        key={err}
                        className="px-2 py-1 border-b border-gray-100 dark:border-gray-800 last:border-b-0 text-red-700 dark:text-red-400"
                      >
                        {err}
                      </p>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || selected.size === 0}
            className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {submitting ? t("orcaImport.importing") : t("orcaImport.importButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
