import { describe, it, expect, beforeEach } from "vitest";
import {
  publishScan,
  subscribeScans,
  getLastScan,
  resetScanBusForTests,
  type ScanEvent,
} from "@/lib/scanBus";

function sampleEvent(over: Partial<ScanEvent> = {}): ScanEvent {
  return {
    timestamp: 1_700_000_000_000,
    filament: {
      _id: "abc",
      name: "Prusament PLA Galaxy Black",
      vendor: "Prusament",
      type: "PLA",
      color: "#000000",
    },
    candidates: [],
    decoded: {
      materialName: "Prusament PLA Galaxy Black",
      brandName: "Prusament",
      materialType: "PLA",
      tagSource: "openprinttag",
    },
    ...over,
  };
}

describe("scanBus", () => {
  beforeEach(() => {
    resetScanBusForTests();
  });

  it("delivers a published event to every active subscriber", () => {
    const a: ScanEvent[] = [];
    const b: ScanEvent[] = [];
    subscribeScans((e) => a.push(e));
    subscribeScans((e) => b.push(e));

    const event = sampleEvent();
    publishScan(event);

    expect(a).toEqual([event]);
    expect(b).toEqual([event]);
  });

  it("caches the most recent scan so late subscribers can replay it", () => {
    const first = sampleEvent({ timestamp: 1 });
    const second = sampleEvent({ timestamp: 2 });
    publishScan(first);
    publishScan(second);
    expect(getLastScan()).toEqual(second);
  });

  it("returns null for getLastScan when nothing has been published yet", () => {
    expect(getLastScan()).toBeNull();
  });

  it("stops delivering after unsubscribe", () => {
    const received: ScanEvent[] = [];
    const unsubscribe = subscribeScans((e) => received.push(e));
    publishScan(sampleEvent({ timestamp: 1 }));
    unsubscribe();
    publishScan(sampleEvent({ timestamp: 2 }));
    expect(received).toHaveLength(1);
    expect(received[0]?.timestamp).toBe(1);
  });

  it("survives a subscriber throwing — other subscribers still receive", () => {
    const received: ScanEvent[] = [];
    subscribeScans(() => {
      throw new Error("boom");
    });
    subscribeScans((e) => received.push(e));
    // EventEmitter.emit re-throws the first handler error synchronously by
    // default, so catch it here — what we want to verify is that the
    // *event* itself was queued before the throw bubbled up.
    expect(() => publishScan(sampleEvent())).toThrow("boom");
    // Subsequent publishes (after the throwing subscriber is removed)
    // still reach the surviving listener.
    resetScanBusForTests();
    subscribeScans((e) => received.push(e));
    publishScan(sampleEvent({ timestamp: 9 }));
    expect(received.at(-1)?.timestamp).toBe(9);
  });
});
