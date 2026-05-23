"use client";

import type { CSSProperties } from "react";

interface FilamentSwatchProps {
  /** Hex color string; ignored when `isParent` is true. */
  color: string | null | undefined;
  /**
   * True when this filament currently has ≥1 variant pointing at it. A
   * filament is never a parent unless it actually has variants — there is
   * no explicit flag on the schema; callers derive this from `hasVariants`
   * on the API response or from a non-empty `_variants` array on the
   * detail-page response.
   */
  isParent?: boolean;
  /** Pixel size for both width and height. Defaults to 20px (w-5 h-5). */
  size?: number;
  /** Optional extra class names (border styling, ring, etc.). */
  className?: string;
  /** Native `title` attribute — appears on hover. */
  title?: string;
  /** Accessibility label; falls back to title or color. */
  ariaLabel?: string;
}

/**
 * Renders a filament color swatch. Variants and standalones get a solid
 * fill from `color`. Parents (filaments with one or more variants) get a
 * cross-hatched fill instead — they don't have a single canonical color of
 * their own, so showing a flat #808080 (the schema default) was misleading.
 *
 * Centralised so the cross-hatch render is consistent across the inventory
 * list, detail page, parent picker, and any dialog that shows a color
 * swatch. Inline `style={{ backgroundColor }}` sites should migrate to
 * this component.
 */
export default function FilamentSwatch({
  color,
  isParent = false,
  size = 20,
  className = "",
  title,
  ariaLabel,
}: FilamentSwatchProps) {
  const dimensionStyle: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
  };

  // For parents we ignore the caller's title/color because the swatch
  // represents "no canonical color", not the parent's nominal color value
  // (which is usually the schema default #808080 or a placeholder). Variants
  // and standalones still surface their hex on hover.
  const finalLabel = isParent
    ? (ariaLabel ?? "Multi-color parent")
    : (ariaLabel ?? title ?? `Color swatch: ${color ?? "unset"}`);
  const finalTitle = isParent ? "Multi-color parent" : title;

  if (isParent) {
    // Two diagonals at +45° and -45° approximate a cross-hatch. The base
    // layer is a neutral grey so the swatch reads as "no specific color"
    // rather than a faded version of the schema default. Dark mode swaps
    // the hatch and base via the `dark:` ring class — the gradient stops
    // themselves are neutral enough to work on both themes without a
    // second style block.
    const hatchStyle: CSSProperties = {
      ...dimensionStyle,
      backgroundColor: "#e5e7eb", // gray-200
      backgroundImage: [
        "repeating-linear-gradient(45deg, rgba(75,85,99,0.55) 0 2px, transparent 2px 6px)",
        "repeating-linear-gradient(-45deg, rgba(75,85,99,0.55) 0 2px, transparent 2px 6px)",
      ].join(", "),
    };
    return (
      <div
        className={`rounded-full border border-gray-400 dark:border-gray-500 flex-shrink-0 dark:bg-gray-700 ${className}`}
        style={hatchStyle}
        title={finalTitle}
        aria-label={finalLabel}
        role="img"
        data-multicolor="true"
      />
    );
  }

  return (
    <div
      className={`rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0 ${className}`}
      style={{ ...dimensionStyle, backgroundColor: color ?? "#808080" }}
      title={finalTitle}
      aria-label={finalLabel}
      role="img"
    />
  );
}
