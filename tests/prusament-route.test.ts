import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Route tests for GET /api/prusament — scrapes a Prusament spool page and
 * extracts the embedded `spoolData` JSON. Previously had no route-level test
 * (the parser `src/lib/prusament.ts` is covered by tests/prusament.test.ts,
 * but the route's SSRF guard / body-cap / status-mapping wiring was not).
 *
 * `node:dns/promises` is mocked so `assertExternalUrl` treats prusament.com as
 * a public host (mirrors tests/tds-route-status.test.ts); the page fetch is
 * stubbed per-test via `vi.stubGlobal("fetch", …)`.
 */
vi.mock("node:dns/promises", () => ({
  lookup: vi.fn().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]),
}));

import { GET } from "@/app/api/prusament/route";

// Same fixture shape as tests/prusament.test.ts.
const SAMPLE_JSON =
  '{"ff_goods_id":4715,"country":"CZ","sample":null,"diameter_avg":1.748,"diameter_measurement":"1.75","weight":1050,"spool_weight":186,"length":345,"manufacture_date":"2025-01-05 08:21:40","filament":{"color_name":"Prusa Galaxy Black","color_rgb":"292929","material":"PETG","name":"Prusament PETG Prusa Galaxy Black 1kg - v1","photo_url":"https://example.com/photo.jpg","grade":"standard","he_min":240,"he_max":260,"hb_min":70,"hb_max":90},"ovality":0.971,"max_diameter_offset":0.011,"standard_deviation":0.008,"price_usd":29.99}';
const SAMPLE_HTML = `<html><body><script>var spoolData = '${SAMPLE_JSON}';</script></body></html>`;

function req(spoolId?: string): NextRequest {
  const url =
    spoolId != null
      ? `http://localhost/api/prusament?spoolId=${encodeURIComponent(spoolId)}`
      : "http://localhost/api/prusament";
  return new NextRequest(url, { method: "GET" });
}

function stubFetch(body: string, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status })),
  );
}

describe("GET /api/prusament", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 400 when spoolId is missing", async () => {
    const res = await GET(req());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/spoolId query parameter is required/i);
  });

  it("returns 400 when spoolId is a malformed URL", async () => {
    // Contains 'spoolId=' so the route tries `new URL(...)`, which throws.
    const res = await GET(req("spoolId=broken"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid url/i);
  });

  it("parses the spool page into the normalized result shape", async () => {
    stubFetch(SAMPLE_HTML, 200);
    const res = await GET(req("CZPMPETG25S123"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      spoolId: "CZPMPETG25S123",
      material: "PETG",
      colorName: "Prusa Galaxy Black",
      colorHex: "#292929", // color_rgb had no leading '#'
      diameter: 1.75,
      netWeight: 1050,
      spoolWeight: 186,
      totalWeight: 1236,
      nozzleTempMin: 240,
      nozzleTempMax: 260,
      bedTempMin: 70,
      bedTempMax: 90,
      diameterStdDev: 0.008,
      priceUsd: 29.99,
      priceEur: null,
      goodsId: 4715,
    });
    expect(body.pageUrl).toContain("spoolId=CZPMPETG25S123");
  });

  it("accepts a full spool URL and extracts the id from it", async () => {
    stubFetch(SAMPLE_HTML, 200);
    const res = await GET(req("https://prusament.com/spool/?spoolId=ABC123"));
    expect(res.status).toBe(200);
    expect((await res.json()).spoolId).toBe("ABC123");
  });

  it("maps a non-ok upstream response to 502", async () => {
    stubFetch("", 500);
    const res = await GET(req("X"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/HTTP 500/);
  });

  it("returns 404 when the page indicates the spool was not found", async () => {
    stubFetch("<html><body>Spool not found</body></html>", 200);
    const res = await GET(req("MISSING"));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not found/i);
  });

  it("returns 502 when the page has no extractable spoolData", async () => {
    stubFetch("<html><body>homepage, no data here</body></html>", 200);
    const res = await GET(req("X"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/could not extract/i);
  });

  it("maps a network/fetch failure to 502", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("socket hang up");
      }),
    );
    const res = await GET(req("X"));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatch(/failed to fetch prusament page/i);
  });
});
