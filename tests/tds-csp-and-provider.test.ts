import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * GH #250 — the filament detail page embeds an embeddable vendor TDS
 * document in an <iframe>. Without an explicit `frame-src` the load falls
 * back to `default-src 'self'` and the browser blocks it even after
 * /api/embed-check confirmed the vendor permits framing. This guards that
 * the app CSP keeps a frame directive.
 *
 * GH #251 — provider resolution must be consistent between GET (config
 * reporting) and POST (extraction). An env-only deploy with only
 * ANTHROPIC_API_KEY / OPENAI_API_KEY set must extract via that provider,
 * not silently fall back to Gemini and 401; and a stored key must never
 * be handed to a provider it was not saved for.
 */

// ── #250: CSP frame directive ──────────────────────────────────────────

describe("GH #250 — app CSP permits framing external TDS documents", () => {
  it("next.config.ts CSP includes a frame-src directive", async () => {
    const { default: nextConfig } = await import("../next.config");
    const headerGroups = (await nextConfig.headers?.()) ?? [];
    const csp = headerGroups
      .flatMap((g) => g.headers)
      .find((h) => h.key === "Content-Security-Policy")?.value;

    expect(csp).toBeTruthy();
    // A frame-src must be present, otherwise the iframe falls back to
    // default-src 'self' and the TDS preview is silently blocked.
    expect(csp).toMatch(/(?:^|;\s*)frame-src\s+[^;]*https:/);
  });
});

// ── #251: provider / key resolution ────────────────────────────────────

const extractFromTds = vi.fn();
const extractFromTdsContent = vi.fn();
const validateApiKey = vi.fn();

vi.mock("@/lib/tdsExtractor", () => ({
  extractFromTds: (...a: unknown[]) => extractFromTds(...a),
  extractFromTdsContent: (...a: unknown[]) => extractFromTdsContent(...a),
  validateApiKey: (...a: unknown[]) => validateApiKey(...a),
}));

const ENV_KEYS = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const;

function jsonReq(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/tds", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * The route keeps the web-mode key/provider in module-level state, so
 * each test re-imports the module fresh to get a clean store.
 */
async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/tds/route");
}

describe("GH #251 — TDS provider/key resolution is consistent and safe", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (originalEnv[k] === undefined) delete process.env[k];
      else process.env[k] = originalEnv[k];
    }
  });

  it("GET reports the env-detected provider (claude) when only ANTHROPIC_API_KEY is set", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.provider).toBe("claude");
    expect(body.configured).toBe(true);
  });

  it("GET reports openai when only OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-openai-test";
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.provider).toBe("openai");
    expect(body.configured).toBe(true);
  });

  it("GET reports configured:false when no key is available", async () => {
    const { GET } = await loadRoute();
    const body = await (await GET()).json();
    expect(body.configured).toBe(false);
  });

  it("POST without an explicit provider uses the env-detected provider, not gemini", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    extractFromTds.mockResolvedValue({ success: true, data: {} });
    const { POST } = await loadRoute();
    const res = await POST(jsonReq({ url: "https://example.com/tds.pdf" }));
    expect(res.status).toBe(200);
    expect(extractFromTds).toHaveBeenCalledWith(
      "https://example.com/tds.pdf",
      "sk-ant-test",
      "claude",
    );
  });

  it("POST with an explicit provider that has no matching key returns 401", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { POST } = await loadRoute();
    const res = await POST(
      jsonReq({ url: "https://example.com/tds.pdf", provider: "openai" }),
    );
    expect(res.status).toBe(401);
    expect(extractFromTds).not.toHaveBeenCalled();
  });

  it("does not hand a stored key to a provider it was not saved for", async () => {
    validateApiKey.mockResolvedValue(true);
    const { PUT, POST } = await loadRoute();
    // Store a Gemini key via PUT (web mode).
    const putRes = await PUT(jsonReq({ apiKey: "gemini-stored-key", provider: "gemini" }));
    expect(putRes.status).toBe(200);
    // A Claude request with no key must NOT reuse the stored Gemini key.
    const res = await POST(
      jsonReq({ url: "https://example.com/tds.pdf", provider: "claude" }),
    );
    expect(res.status).toBe(401);
    expect(extractFromTds).not.toHaveBeenCalled();
  });

  it("uses the stored key when the request provider matches the stored provider", async () => {
    validateApiKey.mockResolvedValue(true);
    extractFromTds.mockResolvedValue({ success: true, data: {} });
    const { PUT, POST } = await loadRoute();
    await PUT(jsonReq({ apiKey: "gemini-stored-key", provider: "gemini" }));
    const res = await POST(
      jsonReq({ url: "https://example.com/tds.pdf", provider: "gemini" }),
    );
    expect(res.status).toBe(200);
    expect(extractFromTds).toHaveBeenCalledWith(
      "https://example.com/tds.pdf",
      "gemini-stored-key",
      "gemini",
    );
  });
});
