import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockLookup, mockResolveSrv } = vi.hoisted(() => ({
  mockLookup: vi.fn(),
  mockResolveSrv: vi.fn(),
}));

// Stub DNS so host resolution + SRV lookups are deterministic in CI.
vi.mock("node:dns/promises", () => ({
  lookup: mockLookup,
  resolveSrv: mockResolveSrv,
}));

import { assertSafeMongoUri } from "@/lib/mongoUriGuard";

/**
 * GH #254 — SSRF guard for user-supplied MongoDB connection strings.
 * `import-atlas` / `setup` pass `uri` straight to `MongoClient`; without
 * this guard a request body can drive the server to probe internal hosts.
 */
describe("assertSafeMongoUri", () => {
  beforeEach(() => {
    mockLookup.mockReset();
    mockResolveSrv.mockReset();
  });

  it("rejects a non-mongodb scheme", async () => {
    await expect(assertSafeMongoUri("http://evil.example/")).rejects.toThrow(/mongodb/i);
    await expect(assertSafeMongoUri("file:///etc/passwd")).rejects.toThrow(/mongodb/i);
    await expect(assertSafeMongoUri("not a uri")).rejects.toThrow(/mongodb/i);
  });

  it("rejects plain mongodb:// when requireSrv is set (import-atlas policy)", async () => {
    await expect(
      assertSafeMongoUri("mongodb://cluster.example.com/db", { requireSrv: true }),
    ).rejects.toThrow(/mongodb\+srv/i);
  });

  it("rejects a literal RFC1918 host without a DNS lookup", async () => {
    await expect(
      assertSafeMongoUri("mongodb://10.0.0.5:27017/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/private\/internal/);
    expect(mockLookup).not.toHaveBeenCalled();
  });

  it("rejects mongodb://localhost when blocking private hosts", async () => {
    mockLookup.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
    await expect(
      assertSafeMongoUri("mongodb://localhost:27017/db", { blockPrivateHosts: true }),
    ).rejects.toThrow(/private\/internal/);
  });

  it("checks every host of a multi-host plain URI", async () => {
    mockLookup.mockImplementation((host: string) =>
      host === "bad.example.com"
        ? Promise.resolve([{ address: "192.168.1.1", family: 4 }])
        : Promise.resolve([{ address: "8.8.8.8", family: 4 }]),
    );
    await expect(
      assertSafeMongoUri(
        "mongodb://good.example.com:27017,bad.example.com:27017/db",
        { blockPrivateHosts: true },
      ),
    ).rejects.toThrow(/private\/internal/);
  });

  // ── mongodb+srv: the SRV *targets* are the real connection hosts ──

  it("rejects a mongodb+srv URI whose SRV target resolves to a private address", async () => {
    // GH #332: the seed host can be public while its SRV records point
    // at RFC1918 space — the guard must validate the SRV targets.
    mockResolveSrv.mockResolvedValue([
      { name: "shard0.internal.corp", port: 27017, priority: 0, weight: 0 },
    ]);
    mockLookup.mockResolvedValue([{ address: "10.1.2.3", family: 4 }]);
    await expect(
      assertSafeMongoUri("mongodb+srv://seed.example.com/db", {
        requireSrv: true,
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/private\/internal/);
    expect(mockResolveSrv).toHaveBeenCalledWith("_mongodb._tcp.seed.example.com");
  });

  it("rejects a mongodb+srv host with no SRV records", async () => {
    mockResolveSrv.mockRejectedValue(new Error("ENOTFOUND"));
    await expect(
      assertSafeMongoUri("mongodb+srv://not-a-cluster.example.com/db", {
        requireSrv: true,
        blockPrivateHosts: true,
      }),
    ).rejects.toThrow(/SRV records/i);
  });

  it("accepts a mongodb+srv host whose SRV targets are all public (Atlas)", async () => {
    mockResolveSrv.mockResolvedValue([
      { name: "shard0.abcd.mongodb.net", port: 27017, priority: 0, weight: 0 },
      { name: "shard1.abcd.mongodb.net", port: 27017, priority: 0, weight: 0 },
    ]);
    mockLookup.mockResolvedValue([{ address: "13.37.13.37", family: 4 }]);
    await expect(
      assertSafeMongoUri(
        "mongodb+srv://user:p%40ss@cluster0.abcd.mongodb.net/filament-db?retryWrites=true",
        { requireSrv: true, blockPrivateHosts: true },
      ),
    ).resolves.toBeUndefined();
  });

  it("only validates the scheme when blockPrivateHosts is false (setup policy)", async () => {
    // setup legitimately targets the app's own DB — localhost / Docker
    // hosts must pass; only the scheme is enforced here.
    await expect(
      assertSafeMongoUri("mongodb://localhost:27017/db", { blockPrivateHosts: false }),
    ).resolves.toBeUndefined();
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockResolveSrv).not.toHaveBeenCalled();
  });
});
