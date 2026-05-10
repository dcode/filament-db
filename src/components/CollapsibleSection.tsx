"use client";

import { useEffect, useState, type ReactNode } from "react";

interface Props {
  /** Stable identifier — used as the DOM id for scroll-into-view, the aria
   * relationship between header and panel, and the localStorage key for
   * persisted open/closed state. Use a kebab-case slug. */
  id: string;
  /** Header label rendered as the legend. */
  title: string;
  /** Optional one-line subtitle shown to the right of the title in muted text. */
  subtitle?: string;
  /** Whether this section starts open on first mount when no localStorage
   * preference has been written yet. Default false. */
  defaultOpen?: boolean;
  /** Optional badge content rendered after the title — e.g. a red pill when
   * a section contains validation errors. */
  badge?: ReactNode;
  /** Body of the section. Lazy-mounted: not rendered until the section has
   * been opened at least once. Once opened, stays mounted (so React/form
   * state survives subsequent collapse + re-expand). */
  children: ReactNode;
}

/** Storage key for a section's open/closed state. */
function storageKey(id: string): string {
  return `filamentdb-form-section-${id}`;
}

/** Read the persisted open/closed flag for a section. SSR-safe (returns the
 * caller's default during server render) and survives a missing/disabled
 * localStorage. */
function readStoredOpen(id: string, defaultOpen: boolean): boolean {
  if (typeof window === "undefined") return defaultOpen;
  try {
    const raw = localStorage.getItem(storageKey(id));
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // ignore
  }
  return defaultOpen;
}

/**
 * Collapsible section wrapper used to chunk the long Edit Filament form into
 * skimmable groups without hiding their existence (Cmd+F still works once a
 * section is opened, and the FormToc sidebar lists every section regardless
 * of state).
 *
 * Design choices:
 *
 * - **Skip rendering the body when collapsed.** Avoids expensive sub-trees
 *   (the calibration grid in particular) running on every form re-render
 *   while collapsed. The trade-off is that re-opening re-mounts the body —
 *   that's fine here because every input in FilamentForm reads/writes the
 *   parent's `form` state, so there's no local component state to lose.
 * - **Persist open/closed per-section in localStorage** so power users can
 *   curate their own default shape across sessions.
 * - **Imperative open** via the exported expandAndScrollToSection helper.
 *   Useful for "open the offending section + scroll" on validation error
 *   without lifting state to the parent.
 *
 * SSR note: localStorage is unavailable on the server. The lazy initializer
 * returns `defaultOpen` during SSR, then the post-mount effect re-reads the
 * persisted value. With `suppressHydrationWarning` on the wrapping section
 * we avoid a console warning when the persisted value differs from the
 * default. The `hidden` attribute changes nothing visible during the
 * brief flicker because the body is hidden either way until first open.
 */
export default function CollapsibleSection({
  id,
  title,
  subtitle,
  defaultOpen = false,
  badge,
  children,
}: Props) {
  const [open, setOpen] = useState<boolean>(defaultOpen);

  // Read the persisted preference on mount. We can't use a lazy initializer
  // for `open` because localStorage is undefined during SSR, and using it
  // would cause a hydration mismatch when the persisted value differs from
  // defaultOpen. We accept one re-render after hydration in exchange.
  useEffect(() => {
    const stored = readStoredOpen(id, defaultOpen);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- post-hydration sync from localStorage
    if (stored !== defaultOpen) setOpen(stored);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist whenever the user toggles.
  useEffect(() => {
    try {
      localStorage.setItem(storageKey(id), String(open));
    } catch {
      // ignore
    }
  }, [id, open]);

  // Listen for synthetic storage events fired by expandAndScrollToSection so
  // the form's submit-error handler can pop a collapsed section open from
  // outside the React tree without a parent state lift.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== storageKey(id)) return;
      if (e.newValue === "true") setOpen(true);
      else if (e.newValue === "false") setOpen(false);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [id]);

  const headerId = `${id}-header`;
  const panelId = `${id}-panel`;

  return (
    <section
      id={id}
      suppressHydrationWarning
      className="border border-gray-300 dark:border-gray-700 rounded scroll-mt-20"
    >
      <button
        type="button"
        id={headerId}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50 dark:hover:bg-gray-900/50 rounded-t transition-colors"
      >
        <svg
          aria-hidden="true"
          className={`w-3.5 h-3.5 flex-shrink-0 transition-transform ${open ? "rotate-90" : ""}`}
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <path d="M4 2l4 4-4 4z" />
        </svg>
        <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {title}
        </span>
        {subtitle && (
          <span className="text-xs text-gray-500 dark:text-gray-400 truncate">
            {subtitle}
          </span>
        )}
        {badge && <span className="ml-auto">{badge}</span>}
      </button>
      <div
        id={panelId}
        role="region"
        aria-labelledby={headerId}
        hidden={!open}
        className="px-4 pb-4 pt-1"
      >
        {/* Don't render the body when collapsed. See the design note in the
         *  component header for why we accept the re-mount on re-open. */}
        {open && children}
      </div>
    </section>
  );
}

/**
 * Imperative helper used by the form's submit handler when validation fails
 * inside a collapsed section: it un-collapses the section (writes localStorage
 * + dispatches a storage event so the live React tree picks it up) and
 * scrolls into view. Falls back to a no-op outside the browser.
 */
export function expandAndScrollToSection(id: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(storageKey(id), "true");
  } catch {
    // ignore
  }
  // The mounted CollapsibleSection won't pick up a same-tab localStorage
  // write — fire a synthetic storage event so it can react.
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: storageKey(id),
      newValue: "true",
    }),
  );
  const el = document.getElementById(id);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}
