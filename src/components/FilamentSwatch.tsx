"use client";

import type { CSSProperties } from "react";
import type { Finish } from "@/lib/filamentFinish";

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
  /**
   * Visual finish derived from the filament's optTags. Drives a texture
   * treatment on top of the color: matte = flat fill, silk = sheen
   * gradient, sparkle = speckles, glow = inner halo, translucent /
   * transparent = real alpha over a checker backdrop. Ignored when
   * `isParent` is true (parents are finish-agnostic). Callers should run
   * `deriveFinish(filament.optTags)` from `src/lib/filamentFinish.ts` to
   * compute this; the helper returns `null` for plain solid fills.
   */
  finish?: Finish | null;
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
 * fill from `color` (optionally with a finish texture on top); parents
 * (filaments with one or more variants) get a cross-hatched fill — they
 * don't have a single canonical color of their own.
 *
 * Centralised so the cross-hatch + finish renders are consistent across
 * the inventory list, detail page, parent picker, and any dialog that
 * shows a color swatch.
 */
export default function FilamentSwatch({
  color,
  isParent = false,
  finish = null,
  size = 20,
  className = "",
  title,
  ariaLabel,
}: FilamentSwatchProps) {
  const dimensionStyle: CSSProperties = {
    width: `${size}px`,
    height: `${size}px`,
  };

  // Parents always render hatched, regardless of color/finish.
  if (isParent) {
    const finalLabel = ariaLabel ?? "Multi-color parent";
    const hatchStyle: CSSProperties = {
      ...dimensionStyle,
      backgroundColor: "#e5e7eb",
      backgroundImage: [
        "repeating-linear-gradient(45deg, rgba(75,85,99,0.55) 0 2px, transparent 2px 6px)",
        "repeating-linear-gradient(-45deg, rgba(75,85,99,0.55) 0 2px, transparent 2px 6px)",
      ].join(", "),
    };
    return (
      <div
        className={`rounded-full border border-gray-400 dark:border-gray-500 flex-shrink-0 dark:bg-gray-700 ${className}`}
        style={hatchStyle}
        title="Multi-color parent"
        aria-label={finalLabel}
        role="img"
        data-multicolor="true"
      />
    );
  }

  const baseColor = color ?? "#808080";
  const rgb = hexToRgb(baseColor);
  const finalLabel =
    ariaLabel ?? (finish ? `${title ?? baseColor} (${finish})` : title ?? `Color swatch: ${baseColor}`);
  const finalTitle = finish ? `${title ?? baseColor} · ${finish}` : title;

  // Transparent / translucent: real alpha over a checkered backdrop.
  // Falls back to a neutral light grey if we couldn't parse the hex
  // (callers do their own sanity checks; this is belt-and-braces).
  if ((finish === "transparent" || finish === "translucent") && rgb) {
    const alpha = finish === "transparent" ? 0.25 : 0.55;
    const fillRgba = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
    return (
      <div
        className={`rounded-full border border-gray-400 dark:border-gray-500 flex-shrink-0 relative overflow-hidden ${className}`}
        style={dimensionStyle}
        title={finalTitle}
        aria-label={finalLabel}
        role="img"
        data-finish={finish}
      >
        {/* Checker backdrop — the universal "this is see-through" signal. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "#f3f4f6",
            backgroundImage: [
              "linear-gradient(45deg, #cbd5e1 25%, transparent 25%)",
              "linear-gradient(-45deg, #cbd5e1 25%, transparent 25%)",
              "linear-gradient(45deg, transparent 75%, #cbd5e1 75%)",
              "linear-gradient(-45deg, transparent 75%, #cbd5e1 75%)",
            ].join(", "),
            backgroundSize: "6px 6px",
            backgroundPosition: "0 0, 0 3px, 3px -3px, -3px 0",
          }}
        />
        {/* Tinted alpha overlay — the filament's actual color, washed. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: fillRgba,
          }}
        />
      </div>
    );
  }

  // Solid-fill finishes (matte / silk / sparkle / glow) + plain.
  const overlay = solidFinishOverlay(finish, rgb);
  return (
    <div
      className={`rounded-full border border-gray-300 dark:border-gray-600 flex-shrink-0 relative overflow-hidden ${className}`}
      style={{ ...dimensionStyle, backgroundColor: baseColor }}
      title={finalTitle}
      aria-label={finalLabel}
      role="img"
      {...(finish ? { "data-finish": finish } : {})}
    >
      {overlay && (
        <div
          aria-hidden="true"
          style={{ position: "absolute", inset: 0, ...overlay }}
        />
      )}
    </div>
  );
}

/**
 * CSS for the decorative overlay on top of the solid color fill. Returns
 * `null` for plain swatches (no overlay needed) and for matte (the
 * absence of a gloss highlight IS the matte treatment — the parent
 * element has no inset shadow either way).
 *
 * `rgb` is the parsed underlying color; we use its luminance to decide
 * sparkle speckle color so sparkles read on both light and dark fills.
 */
function solidFinishOverlay(
  finish: Finish | null,
  rgb: { r: number; g: number; b: number } | null,
): CSSProperties | null {
  if (!finish || finish === "matte") return null;

  if (finish === "silk") {
    // Soft white-to-transparent sheen on the upper-left — reads as a
    // satin highlight without obscuring the underlying color.
    return {
      backgroundImage:
        "radial-gradient(ellipse at 30% 28%, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 60%)",
    };
  }

  if (finish === "sparkle") {
    // Four tiny dots positioned around the swatch. Speckle color flips
    // based on the fill's luminance so the effect reads on white silk
    // and black sparkle alike. mix-blend-mode is intentionally NOT used
    // here — empirically it disappears on near-grey fills.
    const isDark = rgb ? relativeLuminance(rgb) < 0.5 : true;
    const dot = isDark ? "rgba(255,255,255,0.9)" : "rgba(31,41,55,0.55)";
    return {
      backgroundImage: [
        `radial-gradient(circle at 28% 28%, ${dot} 0 1px, transparent 2px)`,
        `radial-gradient(circle at 64% 38%, ${dot} 0 1px, transparent 2px)`,
        `radial-gradient(circle at 76% 70%, ${dot} 0 1px, transparent 2px)`,
        `radial-gradient(circle at 36% 70%, ${dot} 0 1px, transparent 2px)`,
      ].join(", "),
    };
  }

  if (finish === "glow") {
    // Soft phosphorescent inner halo — light-yellow to clear.
    return {
      boxShadow: "inset 0 0 6px 1px rgba(255, 247, 180, 0.85)",
    };
  }

  return null;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const cleaned = hex.trim().replace(/^#/, "");
  if (cleaned.length === 3) {
    const r = parseInt(cleaned[0] + cleaned[0], 16);
    const g = parseInt(cleaned[1] + cleaned[1], 16);
    const b = parseInt(cleaned[2] + cleaned[2], 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b };
  }
  if (cleaned.length === 6) {
    const r = parseInt(cleaned.slice(0, 2), 16);
    const g = parseInt(cleaned.slice(2, 4), 16);
    const b = parseInt(cleaned.slice(4, 6), 16);
    if ([r, g, b].some(Number.isNaN)) return null;
    return { r, g, b };
  }
  return null;
}

function relativeLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  // Quick perceptual approximation (Rec. 601). Good enough to pick a
  // contrasting speckle color; full sRGB linearisation would be overkill.
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
