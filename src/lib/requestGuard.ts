import { NextRequest, NextResponse } from "next/server";
import { errorResponse } from "@/lib/apiErrorHandler";

/** Extract the bare, lower-cased hostname from a `host`, `host:port`,
 * `[ipv6]` or `[ipv6]:port` value — i.e. strip the port and any IPv6
 * brackets so two equivalent authorities compare equal. */
function hostnameOf(value: string): string {
  const v = value.trim();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return (end !== -1 ? v.slice(1, end) : v.slice(1)).toLowerCase();
  }
  const colon = v.indexOf(":");
  return (colon !== -1 ? v.slice(0, colon) : v).toLowerCase();
}

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
    const hostHeader = request.headers.get("host");
    let originHostname: string;
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
    // Compare HOSTNAMES only. `Host` is `hostname[:port]`; matching the
    // raw `host[:port]` string false-rejects a legitimate same-origin
    // request whenever one side carries an explicit default port
    // (`Origin: https://app` vs `Host: app:443`) — common behind a
    // reverse proxy. A genuine cross-origin request that shares the
    // hostname but differs in scheme or port reads `same-site` to the
    // Sec-Fetch-Site check above, so hostname equality is sufficient
    // here (Codex review).
    const hostHostname = hostHeader ? hostnameOf(hostHeader) : "";
    if (!hostHostname || hostnameOf(originHostname) !== hostHostname) {
      return errorResponse(
        "Cross-origin request to a protected route was rejected.",
        403,
      );
    }
  }

  return null;
}
