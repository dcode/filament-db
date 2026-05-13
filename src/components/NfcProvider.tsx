"use client";

import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";
import { useNfc, type NfcStatus } from "@/hooks/useNfc";
import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";
import {
  createScanMatchHandler,
  type FilamentMatch,
  type NfcTagReadResult,
} from "@/lib/scanMatchHandler";

export type { NfcTagReadResult } from "@/lib/scanMatchHandler";

interface NfcContextValue {
  isElectron: boolean;
  status: NfcStatus;
  writing: boolean;
  writeError: string | null;
  writeTag: (payload: Uint8Array, productUrl?: string) => Promise<void>;
  /**
   * Last decoded scan result. Survives dialog dismissal and stays put
   * while the same tag (or a successor) is on the reader, so the
   * status pill can keep showing "Loaded: <name>" after the dialog is
   * dismissed.
   */
  tagReadResult: NfcTagReadResult | null;
  /** Whether the read-result dialog is currently visible. */
  dialogOpen: boolean;
  /** Hide the dialog without clearing `tagReadResult`. */
  dismissTagRead: () => void;
  /**
   * Call this from the write button on the filament detail page after
   * `writeTag` resolves successfully. Updates the pill to reflect the
   * filament that's now physically on the tag, without having to lift
   * and replace it to trigger a fresh read.
   */
  notifyTagWritten: (filament: FilamentMatch) => void;
}

const NfcContext = createContext<NfcContextValue | null>(null);

/**
 * Fire-and-forget POST to /api/scan/publish so SSE subscribers (the
 * PrusaSlicer / OrcaSlicer FilamentDB module) can react to the scan.
 * Failure is intentionally silent — the user-visible tag dialog must not
 * wait on this, and any error here is logged for diagnostics only.
 */
function publishScan(
  decoded: DecodedOpenPrintTag,
  match: FilamentMatch | null,
  candidates: FilamentMatch[],
): void {
  const body = {
    filament: match,
    candidates,
    decoded: {
      materialName: decoded.materialName,
      brandName: decoded.brandName,
      materialType: decoded.materialType,
      color: decoded.color,
      spoolUid: decoded.spoolUid,
      tagSource: decoded.tagSource,
    },
  };
  void fetch("/api/scan/publish", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch((err) => {
    console.warn("[nfc] scan publish failed", err);
  });
}

export function useNfcContext(): NfcContextValue {
  const ctx = useContext(NfcContext);
  if (!ctx) {
    // Return a safe default for non-Electron / outside provider
    return {
      isElectron: false,
      status: { readerConnected: false, readerName: null, tagPresent: false, tagUid: null },
      writing: false,
      writeError: null,
      writeTag: async () => {},
      tagReadResult: null,
      dialogOpen: false,
      dismissTagRead: () => {},
      notifyTagWritten: () => {},
    };
  }
  return ctx;
}

export default function NfcProvider({ children }: { children: ReactNode }) {
  const { isElectron, status, writing, error: writeError, writeTag } = useNfc();
  const [tagReadResult, setTagReadResult] = useState<NfcTagReadResult | null>(null);
  // The dialog and the "current scan" state used to be one flag —
  // dismissing the dialog cleared tagReadResult and the status pill
  // lost its "Loaded: <name>" label. Decouple them: tagReadResult
  // stays put after dismissal so the pill keeps showing what's on the
  // reader; dialogOpen controls the modal independently. A fresh scan
  // overwrites tagReadResult and re-opens the dialog.
  const [dialogOpen, setDialogOpen] = useState(false);

  // Listen for auto-read events from the main process. Match-and-publish
  // sequencing (cancel-stale-fetch + ignore-stale-commit) lives in
  // createScanMatchHandler so the race-prone async path is unit-testable
  // and rapid back-to-back scans can't have the older match clobber the
  // newer one.
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI!;
    const handler = createScanMatchHandler({
      onResult: (result) => {
        setTagReadResult(result);
        setDialogOpen(true);
      },
      onPublish: publishScan,
    });
    const unsub = api.onNfcTagRead(handler);
    return unsub;
  }, [isElectron]);

  const dismissTagRead = useCallback(() => setDialogOpen(false), []);

  // Called by the filament detail page after a successful Write NFC.
  // Synthesises a `tagReadResult` that mirrors what a fresh read would
  // produce, so the pill flips to "Loaded: <name>" right away rather
  // than waiting for the user to lift + replace the tag.
  const notifyTagWritten = useCallback((filament: FilamentMatch) => {
    setTagReadResult({ match: filament, candidates: [] });
    // Intentionally not opening the dialog — the user just clicked
    // "Write NFC" on the filament detail page; popping a modal on top
    // of that workflow would be jarring. The pill update is enough.
  }, []);

  return (
    <NfcContext.Provider
      value={{
        isElectron,
        status,
        writing,
        writeError,
        writeTag,
        tagReadResult,
        dialogOpen,
        dismissTagRead,
        notifyTagWritten,
      }}
    >
      {children}
    </NfcContext.Provider>
  );
}
