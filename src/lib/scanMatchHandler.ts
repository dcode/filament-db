import type { DecodedOpenPrintTag } from "@/lib/openprinttag-decode";

/**
 * Per-scan match-and-publish sequencer. Extracted from NfcProvider so the
 * race-prone async path is testable in isolation and so the React side
 * stays declarative.
 *
 * Two back-to-back tag scans were racing — each invocation kicked off its
 * own `/api/filaments/match` fetch, and whichever resolved last won.
 * If the slower one was older (e.g. user puts down tag A, then quickly
 * swaps in tag B), the local dialog and the SSE replay cache ended up
 * with tag A's filament after the user had moved on to B (codex P1 on
 * PR #234). The sequencer fixes both halves:
 *
 *   1. Each invocation bumps a monotonic counter and stashes it as
 *      `mySeq`. Before any state write the handler re-reads the counter
 *      and bails if it isn't the latest — so a superseded handler can
 *      never commit.
 *   2. Each invocation creates an AbortController and aborts the prior
 *      one. The earlier handler's `await fetch(...)` rejects with
 *      AbortError, which the catch block ignores. Saves a wasted DB
 *      roundtrip on rapid scans and makes the cancellation observable.
 */

export interface FilamentMatch {
  _id: string;
  name: string;
  vendor: string;
  type: string;
  color: string;
}

export interface NfcTagReadEvent {
  data?: DecodedOpenPrintTag;
  error?: string;
  empty?: boolean;
}

export interface NfcTagReadResult {
  data?: DecodedOpenPrintTag;
  error?: string;
  empty?: boolean;
  match?: FilamentMatch | null;
  candidates?: FilamentMatch[];
}

export interface ScanMatchDeps {
  /** Optional fetch override — tests inject a deferred mock. */
  fetch?: typeof globalThis.fetch;
  /** Called with the latest dialog state (or {error}/{empty}). */
  onResult: (result: NfcTagReadResult) => void;
  /** Called once per fresh scan after a successful match attempt. */
  onPublish: (
    decoded: DecodedOpenPrintTag,
    match: FilamentMatch | null,
    candidates: FilamentMatch[],
  ) => void;
}

function isAbortError(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  if (typeof err === "object" && err !== null && "name" in err) {
    return (err as { name?: string }).name === "AbortError";
  }
  return false;
}

export function createScanMatchHandler(deps: ScanMatchDeps) {
  const doFetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  let seq = 0;
  let inFlight: AbortController | null = null;

  return async function handleScan(raw: unknown): Promise<void> {
    const mySeq = ++seq;
    inFlight?.abort();
    inFlight = null;

    const event = raw as NfcTagReadEvent;

    if (event.error) {
      deps.onResult({ error: event.error });
      return;
    }
    if (event.empty) {
      deps.onResult({ empty: true });
      return;
    }
    if (!event.data) return;

    const controller = new AbortController();
    inFlight = controller;

    const params = new URLSearchParams();
    if (event.data.materialName) params.set("name", event.data.materialName);
    if (event.data.brandName) params.set("vendor", event.data.brandName);
    if (event.data.materialType) params.set("type", event.data.materialType);

    const commit = (
      result: NfcTagReadResult,
      match: FilamentMatch | null,
      candidates: FilamentMatch[],
    ) => {
      if (mySeq !== seq) return;
      deps.onResult(result);
      deps.onPublish(event.data!, match, candidates);
    };

    try {
      const res = await doFetch(`/api/filaments/match?${params}`, {
        signal: controller.signal,
      });
      if (!res.ok) {
        commit({ data: event.data, match: null, candidates: [] }, null, []);
        return;
      }
      const parsed = await res.json();
      const match: FilamentMatch | null = parsed?.match ?? null;
      const candidates: FilamentMatch[] = Array.isArray(parsed?.candidates)
        ? parsed.candidates
        : [];
      commit({ data: event.data, match, candidates }, match, candidates);
    } catch (err) {
      if (isAbortError(err, controller.signal)) return;
      commit({ data: event.data, match: null, candidates: [] }, null, []);
    }
  };
}
