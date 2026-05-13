"use client";

import { useState, useEffect } from "react";
import { useNfcContext } from "@/components/NfcProvider";
import { useTranslation } from "@/i18n/TranslationProvider";

export default function NfcStatus() {
  const { isElectron, status, tagReadResult } = useNfcContext();
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);

  // Avoid hydration mismatch — only render after client mount
  useEffect(() => {
    setMounted(true); // eslint-disable-line react-hooks/set-state-in-effect -- mount-only initialization to avoid hydration mismatch
  }, []);

  if (!mounted || !isElectron) return null;

  let dotColor: string;
  let label: string;

  if (!status.readerConnected) {
    dotColor = "bg-gray-500";
    label = t("nfc.status.noReader");
  } else if (!status.tagPresent) {
    dotColor = "bg-yellow-400";
    label = t("nfc.status.readyPlaceTag");
  } else {
    dotColor = "bg-green-400";
    // Once a tag has been decoded we want the pill to remember what's
    // physically loaded — the dialog is dismissable and there's no other
    // persistent surface that shows it. Prefer the DB-matched name (the
    // user's own filament label), fall back to the tag's declared
    // material name, then UID, then a generic "Tag detected".
    const matchedName = tagReadResult?.match?.name ?? null;
    const decodedName = tagReadResult?.data?.materialName ?? null;
    const displayName = matchedName ?? decodedName ?? null;
    if (displayName) {
      label = t("nfc.status.tagLoaded", { name: displayName });
    } else if (status.tagUid) {
      label = t("nfc.status.tagDetectedWithUid", { uid: status.tagUid.slice(-8).toUpperCase() });
    } else {
      label = t("nfc.status.tagDetected");
    }
  }

  return (
    <div
      className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-gray-100 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-full text-xs text-gray-600 dark:text-gray-300 max-w-[260px]"
      title={label}
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`} />
      <span className="truncate">{label}</span>
    </div>
  );
}
