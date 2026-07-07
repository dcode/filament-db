import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { OPTDatabase } from "@/lib/openprinttagBrowser";

/**
 * Route tests for GET + POST /api/openprinttag — the OpenPrintTag DB browser
 * endpoint (base route, distinct from /api/filaments/[id]/openprinttag which
 * `openprinttag-route.test.ts` covers). Previously had no route-level test.
 *
 * The tarball fetch/parse itself is covered by tests/openprinttagBrowser.test.ts;
 * here we stub `fetchOpenPrintTagDatabase` and assert ONLY the handler wiring:
 * status codes, response shape, the GET vs POST(force) call, and the POST CSRF
 * guard (GH #427 moved the force-refresh from a GET-with-side-effect to a
 * same-origin-only POST).
 */
vi.mock("@/lib/openprinttagBrowser", () => ({
  fetchOpenPrintTagDatabase: vi.fn(),
}));

import { fetchOpenPrintTagDatabase } from "@/lib/openprinttagBrowser";
import { GET, POST } from "@/app/api/openprinttag/route";

const mockFetch = vi.mocked(fetchOpenPrintTagDatabase);

const FAKE_DB: OPTDatabase = {
  brands: [],
  materials: [],
  cachedAt: "2026-07-06T00:00:00.000Z",
  totalFFF: 0,
  totalSLA: 0,
};

function postReq(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/openprinttag", { method: "POST", headers });
}

describe("GET /api/openprinttag", () => {
  beforeEach(() => mockFetch.mockReset());

  it("returns the database on success (no force)", async () => {
    mockFetch.mockResolvedValueOnce(FAKE_DB);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_DB);
    expect(mockFetch).toHaveBeenCalledWith();
  });

  it("returns 500 with detail when the fetch throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("tarball unreachable"));
    const res = await GET();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed to fetch/i);
    expect(body.detail).toBe("tarball unreachable");
  });
});

describe("POST /api/openprinttag (force refresh)", () => {
  beforeEach(() => mockFetch.mockReset());

  it("rejects a cross-site browser request with 403 and never touches the cache", async () => {
    const res = await POST(postReq({ "sec-fetch-site": "cross-site" }));
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("force-refreshes and returns the database on a same-origin request", async () => {
    mockFetch.mockResolvedValueOnce(FAKE_DB);
    const res = await POST(postReq());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(FAKE_DB);
    expect(mockFetch).toHaveBeenCalledWith({ force: true });
  });

  it("returns 500 with detail when the refresh throws", async () => {
    mockFetch.mockRejectedValueOnce(new Error("probe failed"));
    const res = await POST(postReq());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/failed to refresh/i);
    expect(body.detail).toBe("probe failed");
  });
});
