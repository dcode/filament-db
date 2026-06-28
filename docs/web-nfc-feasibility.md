# Web-Frontend NFC (WebNFC) — Feasibility & Design

**Status:** Design proposal · **Date:** 2026-06-28 · **Scope:** Browser/PWA NFC for OpenPrintTag, *not* the Electron desktop app

---

## 1. Executive summary

Today **all NFC in Filament DB is Electron-only.** The PC/SC transport lives in
`electron/nfc-service.ts`, and every NFC surface in the web UI is hard-gated behind
`useIsElectron()` / `window.electronAPI`. A plain web user sees nothing: `NfcStatus` returns
`null`, the "Write NFC" button is hidden, and no read dialog ever opens.

The goal is to let web users **read and write OpenPrintTag tags from their own devices**,
without installing the desktop app. The conclusion:

- **Android Chromium (Chrome/Edge/Samsung Internet): feasible and cheap.** Read + write of
  NDEF-wrapped OpenPrintTag/OpenTag3D works via the [Web NFC API]. The hard parts are already
  done — our entire codec layer is browser-safe (zero Node deps), and the server decode/encode
  endpoints the mobile app uses already exist. This is the real "no Electron, no app store" win,
  best delivered as an installable **PWA**.
- **iOS via the web: genuinely out of reach.** Safari has no Web NFC, and `WKWebView` does not
  expose Core NFC to JavaScript — so neither a mobile-Safari visit nor a Capacitor wrapper can
  read a tag through web code. iOS NFC *requires* native Core NFC, which the existing Expo
  companion app (`packages/mobile/`) already provides. **We should not add Capacitor** (see §3).
- **Desktop browsers: no path.** Desktop machines have no NFC reader the browser can drive
  (the PC/SC reader is reachable only through the Electron native module). Electron stays the
  desktop story.
- **Bambu tags: native-only.** Bambu Lab tags are MIFARE Classic and need raw block reads +
  HKDF key derivation. Web NFC only exposes parsed NDEF, never raw MIFARE blocks, so Bambu read
  stays Electron/mobile-only. (It is read-only everywhere anyway.)

[Web NFC API]: https://developer.mozilla.org/en-US/docs/Web/API/Web_NFC_API

---

## 2. Platform support matrix

| Platform / surface | Read (OpenPrintTag/OpenTag3D, NDEF) | Write | Bambu (MIFARE) | Notes |
|---|---|---|---|---|
| **Android — Chrome / Edge / Samsung Internet** | ✅ | ✅ | ❌ | Full `NDEFReader` support |
| **Android — System WebView** (Capacitor/in-app) | ❌ | ❌ | ❌ | Web NFC not implemented in WebView |
| **iOS — Safari** | ❌ | ❌ | ❌ | No Web NFC in any iOS browser |
| **iOS — WKWebView** (Capacitor/in-app) | ❌ | ❌ | ❌ | Core NFC not exposed to JS → needs a native plugin |
| **Desktop — Chrome/Edge** | ❌ | ❌ | ❌ | No NFC hardware path from the browser |
| **Electron desktop (today)** | ✅ | ✅ | ✅ (read) | PC/SC via `electron/nfc-service.ts` |
| **Expo mobile app (today)** | ✅ | — | ✅ Android only | Native Core NFC / `react-native-nfc-manager` |

**Web NFC runtime requirements (all must hold):**
- **Secure context** — `https://` origin (or `localhost` for dev). Plain `http://` is rejected.
- **Transient user activation** — `scan()` / `write()` must be called from a user gesture (a tap).
- **Chromium-only, still a draft spec** — feature-detect at runtime; never assume availability.

---

## 3. Why not Capacitor (and why iOS-via-web is a dead end)

The instinct to "wrap the web app in Capacitor to get iOS" does not work for NFC:

- **`WKWebView` does not surface Core NFC to JavaScript.** There is no `NDEFReader` inside an
  iOS web view. The only way to read a tag on iOS is native Swift/Obj-C Core NFC.
- **Android System WebView doesn't implement Web NFC either**, so even on Android a Capacitor
  app couldn't rely on `NDEFReader` — it would need a native plugin too.

So a Capacitor build would have to use a **native** NFC plugin (e.g.
`@capawesome-team/capacitor-nfc`) on *both* platforms. That is a third, parallel NFC
implementation — functionally duplicating `packages/mobile/` — plus a new build/signing
pipeline, for **zero incremental capability** over what the Expo app already ships.

**Recommendation:** Use Web NFC directly for the Android browser/PWA win. Leave iOS (and
cross-platform native) to the existing Expo companion app. Do not add Capacitor.

---

## 4. Why this is cheap: what already exists

### 4.1 The codec layer is 100% browser-safe

Every module needed to decode and encode a tag uses only `Uint8Array`, `TextEncoder` /
`TextDecoder`, and `DataView` — **no `Buffer`, no `node:crypto`, no `fs`, no native bindings.**
They are already imported by Next.js API routes (which exclude `electron/` from tsconfig), so
they bundle cleanly into client code:

| Module | Key exports | Role |
|---|---|---|
| `src/lib/openprinttag.ts` | `generateOpenPrintTagBinary()` | CBOR **encode** (write) |
| `src/lib/openprinttag-decode.ts` | `decodeOpenPrintTagBinary()` | CBOR **decode** (read) |
| `src/lib/ndef.ts` | `parseNdefRecords()`, `parseNdefRecordsAuto()`, `wrapNdefForTag()`, build helpers | NDEF parse/build (Type-2 & Type-5) |
| `src/lib/tagCodecs.ts` | `selectCodec()`, `decodeFromNdefRecords()` | MIME-based codec dispatch |
| `src/lib/opentag3d.ts` / `opentag3d-decode.ts` | `decodeOpenTag3D()`, `ot3dToDecodedTag()` | OpenTag3D fixed-map codec |
| `src/lib/decodedTagToFilament.ts` | `decodedTagToFilamentPayload()` | Decoded tag → filament create payload |

`electron/ndef.ts` is just a re-export of `src/lib/ndef.ts`; the PC/SC transport in
`electron/nfc-service.ts` is the *only* Node-bound NFC code, and it delegates all parsing to
the shared layer. The transport is the pluggable part — Web NFC is simply a new transport.

### 4.2 The thin-client endpoints already exist

The Expo app proves the exact architecture a Web NFC client would use — *the client does no
decoding*; it sends bytes and the server returns a decoded tag + DB match:

- **`POST /api/nfc/decode`** (`src/app/api/nfc/decode/route.ts`) — body
  `{ tagType, payload }` (base64 NDEF record payload) **or** `{ tagType, tagMemory }` (base64
  raw memory, auto-sniffed). Returns `{ decoded: DecodedOpenPrintTag, match, candidates,
  matchedBy, matchedSpool }`. Read-only; no same-origin guard (reachable cross-origin by design,
  gated only by the optional `FILAMENTDB_API_KEY` when set).
- **`GET /api/filaments/match`** (`src/app/api/filaments/match/route.ts`) — `?instanceId=` /
  `?name=` / `?vendor=` / `?type=` resolution for QR/label scans; same `MatchResult` shape.
- **`GET /api/filaments/{id}/openprinttag?spool=<id>`**
  (`src/app/api/filaments/[id]/openprinttag/route.ts`) — server-side **encode**: returns the
  ready-to-write OpenPrintTag `.bin` for a filament/spool (spool-aware via `selectSpoolForWrite`).

### 4.3 The UI is reusable

`src/components/NfcReadDialog.tsx` and `src/components/NfcStatus.tsx` are **pure presentation**
— they read from the NFC context and make no `electronAPI` calls. The match/SSE orchestration in
`scanMatchHandler` is transport-agnostic. Only `src/hooks/useNfc.ts` and
`src/components/NfcProvider.tsx` are bound to `window.electronAPI`.

---

## 5. Proposed architecture (web / Android)

Make the **transport pluggable** instead of hard-wired to Electron, and broaden the gating from
"is Electron" to "is NFC available."

### 5.1 Transport abstraction

- Add `src/hooks/useNfcWeb.ts` — a Web NFC adapter that mirrors the `useNfc.ts` surface
  (`status`, `readTag`, `writeTag`, `writing`, `error`), backed by `NDEFReader`. Gate on runtime
  feature detection: `typeof window !== "undefined" && "NDEFReader" in window`.
- Refactor `src/components/NfcProvider.tsx` to **select a transport at mount**:
  Electron IPC → Web NFC → none. The provider's context value and the dialog/status components
  stay unchanged.
- Extend `src/hooks/useIsElectron.ts` (or add a sibling `useNfcAvailable`) to expose
  `webNfcSupported` and a combined `nfcAvailable = isElectron || webNfcSupported`.
- Replace `{isElectron && …}` gates at the NFC surfaces with `{nfcAvailable && …}`:
  the "Write NFC" button on `src/app/filaments/[id]/page.tsx`, the prefill indicator on
  `src/app/filaments/new/page.tsx`, and the header pill (`NfcStatus`).

### 5.2 Read flow (Android)

1. User taps a **"Scan tag"** button (Web NFC requires the gesture) → `new NDEFReader().scan()`.
2. On the `reading` event, find the record whose `mediaType` is
   `application/vnd.openprinttag` (or `application/opentag3d`) and take its `record.data`
   (`DataView` → `Uint8Array`).
3. **Decode (recommended: server-side):** base64-encode the bytes → `POST /api/nfc/decode`
   `{ tagType, payload }` → feed the returned `DecodedOpenPrintTag` + match into the existing
   `tagReadResult` context so `NfcReadDialog` renders with **no UI changes**.

This matches the mobile rule "the client does no decoding," giving one tested decode path with
zero drift between web, mobile, and desktop. See §6 for the client-side alternative.

### 5.3 Write flow (Android)

1. Obtain the OpenPrintTag CBOR bytes. **Recommended: fetch from the server** —
   `GET /api/filaments/{id}/openprinttag?spool=<id>` — so encoding stays server-authoritative and
   spool selection reuses `selectSpoolForWrite` (same reasoning as decode). The browser-safe
   `generateOpenPrintTagBinary()` is available as a client-side alternative if a round-trip is
   undesirable.
2. Write:
   ```js
   await new NDEFReader().write({
     records: [{ recordType: "mime",
                 mediaType: "application/vnd.openprinttag",
                 data: cborBytes }],
   });
   ```
3. Apply the existing pre-write posture *conceptually* — confirm overwrite, distinguish our tag
   from a foreign one — but note the hard limits in §6.

---

## 6. Decode path: server-side vs client-side

Both work because the codec is browser-safe. **Recommendation: server-side decode.**

| | **Server-side (`POST /api/nfc/decode`)** — recommended | **Client-side (`decodeFromNdefRecords`)** |
|---|---|---|
| Decode logic | One path, shared with mobile + desktop | A second path to keep in lockstep |
| Round-trips | One POST (decode **and** DB match together) | `match` GET still needed for the DB lookup |
| Offline | Needs the server (it's the data source anyway) | Decode works offline; match still needs server |
| Drift risk | None | Codec changes must stay in sync across surfaces |

The marginal round-trip saved by client-side decode is not worth a second decode path. Go
server-side, exactly like the Expo app.

---

## 7. Constraints, risks & unknowns

Called out honestly — some of these are real limitations versus the Electron path:

- **The browser owns NDEF framing on `write()`.** `NDEFReader.write()` builds its own CC bytes
  and TLV layout; the app cannot control them, the SLIX2 block-79 reservation, or the soft
  read-only CC bit (`isCcByteReadOnly` / `setCcByteReadOnly` in `ndef.ts`). **#1 thing to verify
  on hardware:** the Prusa-app requirement that the CBOR `aux_region_offset` point to valid CBOR
  *within the NDEF payload* — confirm it still holds when Chromium writes the framing, by reading
  a Web-NFC-written tag back in the Prusa app. This gates Phase 2.
- **No soft read-only / erase-as-escape-hatch parity.** Those features (#583/#585) depend on
  raw CC-byte control that Web NFC doesn't expose.
- **No Bambu read.** MIFARE Classic blocks aren't available via Web NFC — keep it native-only.
- **iOS unsupported via web** — route iOS users to the Expo app.
- **Feature-detect at runtime** (`"NDEFReader" in window`) and wrap `scan()`/`write()` in
  try/catch; surface a clear "NFC isn't supported on this device/browser" state rather than a
  dead button.
- **HTTPS requirement collides with LAN share.** Web NFC won't run on the plain-HTTP
  `0.0.0.0` origin used by the `exposeToLan` feature, nor on a `localhost` LAN IP from another
  device. A real `https://` deployment (or a PWA served over HTTPS) is required — note this in
  the user-facing docs so people don't try it over `http://192.168.x.x`.

---

## 8. PWA angle

Shipping the web app as an **installable PWA** is the natural delivery vehicle: an Android user
adds it to the home screen and gets an app-like OpenPrintTag scanner with no app store and no
Electron. Requirements: a web app manifest, a service worker, and HTTPS (already needed for Web
NFC). Confirm whether a manifest/service worker already exists before adding one during
implementation.

---

## 9. Phased implementation outline

*(For the eventual build — not part of this design doc.)*

- **Phase 1 — Read on Android.** `useNfcWeb` + transport selection in `NfcProvider` +
  server-side decode wired into the existing `NfcReadDialog`. Lowest risk, immediate value.
- **Phase 2 — Write on Android.** Server-encode (or browser-encode) + `NDEFReader.write()`.
  **Gate on hardware verification** of Prusa-app round-trip compatibility (§7).
- **Phase 3 — PWA packaging.** Manifest + service worker for an installable Android scanner.
- iOS remains the Expo app throughout.

---

## 10. Reuse map

**Reuse directly (browser-safe, no changes):**
`src/lib/openprinttag.ts`, `src/lib/openprinttag-decode.ts`, `src/lib/ndef.ts`,
`src/lib/tagCodecs.ts`, `src/lib/opentag3d.ts`, `src/lib/opentag3d-decode.ts`,
`src/lib/decodedTagToFilament.ts`, `src/lib/selectSpoolForWrite.ts`.

**Server endpoints already in place:**
`src/app/api/nfc/decode/route.ts`, `src/app/api/filaments/match/route.ts`,
`src/app/api/filaments/[id]/openprinttag/route.ts`.

**UI reuse as-is:** `src/components/NfcReadDialog.tsx`, `src/components/NfcStatus.tsx`.

**Refactor for pluggable transport:** `src/components/NfcProvider.tsx`, `src/hooks/useNfc.ts`,
`src/hooks/useIsElectron.ts` (add `webNfcSupported` / `nfcAvailable`); new `src/hooks/useNfcWeb.ts`.

**Reference template (mobile thin client):** `packages/mobile/src/lib/nfc.ts`,
`packages/mobile/src/lib/api.ts`, `packages/mobile/src/app/create-from-tag.tsx`.
