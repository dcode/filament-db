"use client";

import type { Finish } from "@/lib/filamentFinish";
import { useTranslation } from "@/i18n/TranslationProvider";

interface FinishChipProps {
  finish: Finish;
  /** "xs" matches the size of other inline list badges (variant / low-stock); "sm" is for the detail-page header. */
  size?: "xs" | "sm";
  className?: string;
}

/**
 * Tag-style label rendered beside the filament's name in the inventory
 * list, on the detail page header, and on each color-variant chip under
 * a parent. Pairs with the `<FilamentSwatch finish={...}>` texture
 * treatment so the same visual signal shows up both on the swatch and
 * as a readable label — covers the case where the texture alone is too
 * subtle (very dark transparents) and is more accessible than relying
 * on hover tooltips.
 */
const STYLES: Record<Finish, string> = {
  matte:
    "bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200",
  silk:
    "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  sparkle:
    "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  glow:
    "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
  translucent:
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  transparent:
    "bg-slate-200 text-slate-800 dark:bg-slate-600 dark:text-slate-100",
};

export default function FinishChip({ finish, size = "xs", className = "" }: FinishChipProps) {
  const { t } = useTranslation();
  const label = t(`swatch.finish.${finish}`);
  const sizeCls =
    size === "xs"
      ? "text-[10px] px-1.5 py-0.5"
      : "text-xs px-2 py-0.5";
  return (
    <span
      className={`inline-block rounded font-medium uppercase tracking-wide ${sizeCls} ${STYLES[finish]} ${className}`}
      title={label}
    >
      {label}
    </span>
  );
}
