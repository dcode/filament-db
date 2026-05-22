import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiErrorHandler";

/**
 * GH #252: trusted-origin guard for destructive / admin API routes —
 * snapshot export·restore·wipe, the MongoDB connection test, and the
 * Atlas import.
 *
 * The app serves an UNAUTHENTICATED HTTP server (the Electron renderer
 * and a web/Docker deployment both talk to it same-origin). Without a
 * guard, any web page the user visits can drive these routes
 * cross-origin (CSRF): wipe the database, exfiltrate a snapshot, or
 * make the server open MongoDB connections to probe the LAN.
 *
 * The guard rejects requests that carry cross-origin browser
 * provenance:
 *   - `Sec-Fetch-Site` present and not `same-origin` / `none` — every
 *     modern browser tags each request; a CSRF request reads
 *     `cross-site` or `same-site`.
 *   - an `Origin` header whose host does not match the request `Host`.
 *
 * A non-browser client (curl, a slicer integration script) sends
 * neither header and cannot be a CSRF vector, so it passes — this is a
 * CSRF / trusted-origin guard, not an authentication layer. Protecting
 * an instance that is reachable from an untrusted network is a
 * deployment concern the README already calls out.
 *
 * Returns a 403 `NextResponse` to short-circuit the handler, or `null`
 * when the request may proceed.
 */
export function assertSameOriginRequest(request: NextRequest): NextResponse | null {
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (
    secFetchSite &&
    secFetchSite !== "same-origin" &&
    secFetchSite !== "none"
  ) {
    return errorResponse(
      "Cross-origin request to a protected route was rejected.",
      403,
    );
  }

  const origin = request.headers.get("origin");
  if (origin) {
    const host = request.headers.get("host");
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
    if (!host || originHost !== host) {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
  }

  return null;
}
