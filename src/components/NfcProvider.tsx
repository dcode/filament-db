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
  tagReadResult: NfcTagReadResult | null;
  dismissTagRead: () => void;
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
      dismissTagRead: () => {},
    };
  }
  return ctx;
}

export default function NfcProvider({ children }: { children: ReactNode }) {
  const { isElectron, status, writing, error: writeError, writeTag } = useNfc();
  const [tagReadResult, setTagReadResult] = useState<NfcTagReadResult | null>(null);

  // Listen for auto-read events from the main process. Match-and-publish
  // sequencing (cancel-stale-fetch + ignore-stale-commit) lives in
  // createScanMatchHandler so the race-prone async path is unit-testable
  // and rapid back-to-back scans can't have the older match clobber the
  // newer one.
  useEffect(() => {
    if (!isElectron) return;
    const api = window.electronAPI!;
    const handler = createScanMatchHandler({
      onResult: setTagReadResult,
      onPublish: publishScan,
    });
    const unsub = api.onNfcTagRead(handler);
    return unsub;
  }, [isElectron]);

  const dismissTagRead = useCallback(() => setTagReadResult(null), []);

  return (
    <NfcContext.Provider
      value={{
        isElectron,
        status,
        writing,
        writeError,
        writeTag,
        tagReadResult,
        dismissTagRead,
      }}
    >
      {children}
    </NfcContext.Provider>
  );
}
