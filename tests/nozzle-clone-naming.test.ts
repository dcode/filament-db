import { describe, it, expect } from "vitest";
import {
  nextCloneName,
  clonePeerNamePattern,
  escapeRegExp,
} from "@/lib/nozzleConflicts";

/**
 * GH #298 — the nozzle clone-naming helpers must restrict "peers" to the
 * exact base name and its numbered clones. A prefix-only match pulled in
 * unrelated siblings ("E3D" → "E3D V6", "E3D Revo") and let an
 * unrelated "#N" suffix bump the clone counter.
 */
describe("GH #298 — nozzle clone naming is exact, not prefix", () => {
  describe("nextCloneName", () => {
    it("returns #2 when only the base name exists", () => {
      expect(nextCloneName("E3D", ["E3D"])).toBe("E3D #2");
    });

    it("counts numbered clones of the exact base name", () => {
      expect(nextCloneName("E3D", ["E3D", "E3D #2", "E3D #3"])).toBe("E3D #4");
    });

    it("ignores a prefix-sharing sibling that is NOT a numbered clone", () => {
      // "E3D V6" / "E3D Revo" share the prefix but aren't clones of
      // "E3D" — they must not affect the counter.
      expect(nextCloneName("E3D", ["E3D", "E3D V6", "E3D Revo"])).toBe("E3D #2");
    });

    it("ignores a numbered clone that belongs to a DIFFERENT base name", () => {
      // "E3D Revo #5" is a clone of "E3D Revo", not of "E3D". Pre-fix it
      // pushed the "E3D" counter to #6.
      expect(nextCloneName("E3D", ["E3D", "E3D Revo #5"])).toBe("E3D #2");
    });

    it("handles base names with regex metacharacters", () => {
      // "0.4mm" — the "." must be escaped or it would match "0X4mm".
      expect(nextCloneName("0.4mm", ["0.4mm", "0.4mm #2"])).toBe("0.4mm #3");
      expect(nextCloneName("0.4mm", ["0.4mm", "0X4mm #9"])).toBe("0.4mm #2");
    });
  });

  describe("clonePeerNamePattern", () => {
    it("matches the exact base name and its numbered clones only", () => {
      const re = new RegExp(clonePeerNamePattern("E3D"));
      expect(re.test("E3D")).toBe(true);
      expect(re.test("E3D #2")).toBe(true);
      expect(re.test("E3D #17")).toBe(true);
      // Not a clone of "E3D":
      expect(re.test("E3D V6")).toBe(false);
      expect(re.test("E3D Revo #5")).toBe(false);
      expect(re.test("My E3D")).toBe(false);
      expect(re.test("E3D #")).toBe(false);
      expect(re.test("E3D#2")).toBe(false); // suffix requires a space
    });

    it("escapes regex metacharacters in the base name", () => {
      const re = new RegExp(clonePeerNamePattern("0.4mm"));
      expect(re.test("0.4mm")).toBe(true);
      expect(re.test("0X4mm")).toBe(false); // the "." is literal, not "any char"
    });
  });

  describe("escapeRegExp", () => {
    it("escapes characters that are special in a RegExp", () => {
      expect(escapeRegExp("a.b*c")).toBe("a\\.b\\*c");
      expect(escapeRegExp("plain")).toBe("plain");
    });
  });
});
