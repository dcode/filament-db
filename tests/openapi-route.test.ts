import { describe, it, expect } from "vitest";
import { GET } from "@/app/api/openapi/route";

/**
 * Route test for GET /api/openapi. Previously exercised only by the CI smoke
 * curl, never by Vitest. Serves public/openapi.json with the package version
 * injected, memoised after the first read (GH #270).
 */
describe("GET /api/openapi", () => {
  it("serves the OpenAPI spec with an injected string version", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(spec.openapi).toBeTruthy();
    expect(spec.info).toBeTruthy();
    expect(typeof spec.info.version).toBe("string");
    expect(spec.info.version.length).toBeGreaterThan(0);
    expect(spec.paths).toBeTruthy();
  });

  it("returns identical memoised content on a second call (GH #270 cache branch)", async () => {
    const first = await (await GET()).json();
    const second = await (await GET()).json();
    expect(second).toEqual(first);
  });
});
