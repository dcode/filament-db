import { describe, it, expect } from "vitest";
import {
  generateOpenPrintTagBinary,
  type OpenPrintTagInput,
} from "@/lib/openprinttag";
import { decodeOpenPrintTagBinary } from "@/lib/openprinttag-decode";
import { parseBambuBlocks } from "../electron/bambu-tag";
import { parseNdefFromTag } from "../electron/ndef";

/**
 * Robustness tests for the NFC binary parsers/encoders — code-review
 * issues #274, #275, #311, #313, #314. These paths consume bytes that
 * come straight off a physical tag (or off a bad import for the
 * encoder), so they must fail cleanly rather than crash or silently
 * decode garbage.
 */
describe("NFC binary parsing robustness", () => {
  // ── #274: generateOpenPrintTagBinary tolerates negative temps ──────

  describe("#274 — negative temperature input", () => {
    const base: OpenPrintTagInput = {
      materialName: "Test PLA",
      brandName: "Test",
      materialType: "PLA",
    };

    it("does not throw on a negative nozzle temperature", () => {
      expect(() =>
        generateOpenPrintTagBinary({ ...base, nozzleTemp: -40 }),
      ).not.toThrow();
    });

    it("does not throw on a negative bed temperature", () => {
      expect(() =>
        generateOpenPrintTagBinary({ ...base, bedTemp: -10 }),
      ).not.toThrow();
    });

    it("does not throw on a negative chamber temperature", () => {
      expect(() =>
        generateOpenPrintTagBinary({ ...base, chamberTemp: -5 }),
      ).not.toThrow();
    });

    it("a negative nozzle temp round-trips as a clamped (>= 0) value", () => {
      const bin = generateOpenPrintTagBinary({ ...base, nozzleTemp: -40 });
      const decoded = decodeOpenPrintTagBinary(bin);
      // Every encoded temperature must be a non-negative integer.
      for (const [k, v] of Object.entries(decoded.main)) {
        if (k.includes("TEMPERATURE") && typeof v === "number") {
          expect(v).toBeGreaterThanOrEqual(0);
        }
      }
    });
  });

  // ── #275: 4-byte CBOR uint with the high bit set decodes unsigned ──

  it("#275 — a 4-byte CBOR uint with the high bit set decodes as positive", () => {
    // Meta map { 2: 0x80000001 } — value uses the 4-byte uint form
    // (0x1A) with the high bit set. Followed by an empty main map.
    // Pre-fix the signed `|` chain decoded this as a negative number.
    const data = new Uint8Array([
      0xa1, // map, 1 pair
      0x02, // key: uint 2
      0x1a, 0x80, 0x00, 0x00, 0x01, // value: uint32 0x80000001
      0xa0, // main map: empty
    ]);
    const decoded = decodeOpenPrintTagBinary(data);
    // The single meta value must come back as the true unsigned value.
    expect(Object.values(decoded.meta)).toContain(0x80000001);
    // And nothing in meta is negative.
    for (const v of Object.values(decoded.meta)) {
      expect(v).toBeGreaterThanOrEqual(0);
    }
  });

  // ── #311: negative aux-region offset is rejected, not dereferenced ──

  it("#311 — a negative AUX_REGION_OFFSET is skipped cleanly", () => {
    // Meta map { 2: -5 } (AUX_REGION_OFFSET = -5) + empty main map.
    // -5 in CBOR is major type 1: 0x20 + 4 = 0x24.
    const data = new Uint8Array([
      0xa1, // map, 1 pair
      0x02, // key: uint 2 (AUX_REGION_OFFSET)
      0x24, // value: negative int -5
      0xa0, // main map: empty
    ]);
    // Must not throw, and must not populate `aux` from a bogus offset.
    let decoded: ReturnType<typeof decodeOpenPrintTagBinary>;
    expect(() => {
      decoded = decodeOpenPrintTagBinary(data);
    }).not.toThrow();
    expect(decoded!.aux).toBeUndefined();
  });

  // ── #313: NDEF payload bounded by the TLV, not the whole buffer ────

  it("#313 — a record claiming a payload past the TLV end is rejected", () => {
    // CC (4 bytes) + NDEF TLV (tag 0x03, len 5) whose single record
    // declares a 100-byte payload — well past the 5-byte TLV — but the
    // overall buffer is long enough that a `data.length` bound would
    // have let it through.
    const raw = new Uint8Array(120);
    raw[0] = 0xe1; // CC magic
    raw[1] = 0x40;
    raw[4] = 0x03; // NDEF Message TLV tag
    raw[5] = 0x05; // TLV length = 5
    raw[6] = 0x12; // record flags: SR | TNF=2
    raw[7] = 0x00; // type length = 0
    raw[8] = 0x64; // payload length = 100 — exceeds the 5-byte TLV
    expect(() => parseNdefFromTag(raw)).toThrow(/NDEF message TLV/);
  });

  // ── #314: parseBambuBlocks tolerates a short block ─────────────────

  it("#314 — a short MIFARE block does not throw a RangeError", () => {
    // Block 5 (read with readUInt16LE(4) / readFloatLE(8)) supplied as
    // a 4-byte buffer — shorter than the 16 bytes the fixed offsets
    // assume. Pre-fix this threw an unhandled RangeError.
    const blocks: (Buffer | undefined)[] = [];
    blocks[1] = Buffer.alloc(16);
    blocks[5] = Buffer.from([0x01, 0x02, 0x03, 0x04]); // only 4 bytes
    let result: ReturnType<typeof parseBambuBlocks>;
    expect(() => {
      result = parseBambuBlocks(blocks);
    }).not.toThrow();
    // The short block's missing bytes read back as zero-padded.
    expect(result!.spoolWeight).toBe(0);
    expect(result!.filamentDiameter).toBe(0);
    // The present colour bytes still come through.
    expect(result!.colorRGBA).toEqual([1, 2, 3, 4]);
  });

  it("#314 — an over-long block is truncated to 16 bytes, not rejected", () => {
    const blocks: (Buffer | undefined)[] = [];
    blocks[5] = Buffer.alloc(64, 0xff); // 64 bytes, all 0xff
    expect(() => parseBambuBlocks(blocks)).not.toThrow();
  });
});
