import type { NextConfig } from "next";
import { readFileSync } from "fs";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const nextConfig: NextConfig = {
  output: "standalone",
  allowedDevOrigins: process.env.ALLOWED_DEV_ORIGINS
    ? process.env.ALLOWED_DEV_ORIGINS.split(",").map(s => s.trim())
    : [],
  env: {
    APP_VERSION: pkg.version,
  },
  async headers() {
    // GH #225 — Content-Security-Policy:
    //
    // Adds CSP alongside the existing X-Content-Type-Options /
    // X-Frame-Options / Referrer-Policy trio. Matters most for the
    // Docker / web deployment — Electron's contextIsolation already
    // sandboxes the renderer.
    //
    // Why `'unsafe-inline'` on `script-src` and `style-src`:
    //
    // - `script-src`: Next.js streams the React Server Components flight
    //   protocol via inline `<script>` payloads on first paint. There's no
    //   stable nonce we can plumb in without a per-request middleware
    //   layer (see #225 follow-up — move to nonce-based once we have a
    //   custom edge middleware). The anti-FOUC theme-init script in
    //   `src/lib/themeInitScript.ts` is also inline. Until both move to
    //   a nonce, `'unsafe-inline'` is the price of having CSP at all on
    //   this codebase.
    // - `style-src`: Tailwind emits inline `<style>` tags (its preflight
    //   and the JIT-compiled atomic classes) and swagger-ui-react injects
    //   per-component styles into the head. Both rely on `'unsafe-inline'`.
    //
    // `img-src` allows `data:` and `blob:` so the spool photo-data-URL
    // pipeline (`src/lib/validateSpoolBody.ts` accepts those MIMEs) keeps
    // working. `https:` covers TDS-extracted thumbnails and product
    // photos. `connect-src 'self'` limits fetch/XHR to same-origin —
    // the /api/embed-check + TDS extractor routes are server-side and
    // unaffected. `frame-ancestors 'none'` matches X-Frame-Options:
    // DENY.
    //
    // Tightening checklist for follow-up:
    //   - Per-request nonce middleware → drop 'unsafe-inline' on
    //     script-src and style-src (Tailwind v4 supports nonces via
    //     buildEsbuild).
    //   - Hash-pin the theme-init script.
    //   - Consider report-uri once we have an endpoint.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
