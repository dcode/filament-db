/**
 * SSRF guard for user-supplied MongoDB connection strings (GH #254).
 *
 * `POST /api/filaments/import-atlas` and `POST /api/setup` take a `uri`
 * straight from the request body and hand it to `new MongoClient(uri)`
 * + `connect()`. Without a guard, `mongodb://10.0.0.5:27017` turns the
 * server into an internal-network port scanner / service prober — and
 * because the app runs an unauthenticated HTTP server, any web page the
 * user visits can drive it cross-origin.
 *
 * Policy:
 *   - The scheme must be `mongodb://` or `mongodb+srv://`.
 *   - `import-atlas` (importing from a *remote* Atlas) additionally
 *     requires `mongodb+srv://` and rejects hosts that resolve to a
 *     private/internal address — it never legitimately targets a LAN
 *     host.
 *   - `setup` (configuring the app's OWN database) only gets the scheme
 *     check: a local/Docker deployment legitimately points at
 *     `mongodb://localhost` or a private Docker-network host, so
 *     IP-blocking there is wrong. Restricting *who* may call `setup`
 *     is the job of the destructive-route access guard (GH #252).
 */

import { lookup } from "node:dns/promises";
import { isPrivateIp } from "@/lib/externalUrlGuard";

export interface MongoUriGuardOptions {
  /** Require the `mongodb+srv://` scheme (reject plain `mongodb://`). */
  requireSrv?: boolean;
  /** Resolve every host and reject private/internal addresses. */
  blockPrivateHosts?: boolean;
}

/** Strip `:port` and IPv6 brackets from a single `host[:port]` spec. */
function extractHost(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end !== -1 ? trimmed.slice(1, end) : trimmed.slice(1);
  }
  const colon = trimmed.indexOf(":");
  return colon !== -1 ? trimmed.slice(0, colon) : trimmed;
}

async function resolveHostIps(host: string): Promise<string[]> {
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  if (isIpLiteral) return [host];
  const records = await lookup(host, { all: true }).catch(() => []);
  if (records.length === 0) {
    throw new Error(`Database host does not resolve: ${host}`);
  }
  return records.map((r) => r.address);
}

/**
 * Validate a user-supplied MongoDB connection string before it is passed
 * to a `MongoClient`. Throws an `Error` describing the rejection.
 */
export async function assertSafeMongoUri(
  uri: string,
  opts: MongoUriGuardOptions = {},
): Promise<void> {
  const match = /^(mongodb(?:\+srv)?):\/\/(.+)$/i.exec(uri.trim());
  if (!match) {
    throw new Error(
      "Connection string must be a mongodb:// or mongodb+srv:// URI.",
    );
  }
  const isSrv = match[1].toLowerCase() === "mongodb+srv";
  if (opts.requireSrv && !isSrv) {
    throw new Error(
      "Only mongodb+srv:// connection strings are accepted here.",
    );
  }

  // authority = everything before the first '/' or '?'; drop userinfo
  // (everything up to and including the last '@').
  let authority = match[2].split(/[/?]/)[0];
  const at = authority.lastIndexOf("@");
  if (at !== -1) authority = authority.slice(at + 1);

  const hostSpecs = authority
    .split(",")
    .map((h) => h.trim())
    .filter(Boolean);
  if (hostSpecs.length === 0) {
    throw new Error("Connection string has no host.");
  }
  if (isSrv && hostSpecs.length > 1) {
    throw new Error(
      "A mongodb+srv:// connection string must have exactly one host.",
    );
  }

  if (!opts.blockPrivateHosts) return;

  for (const spec of hostSpecs) {
    const host = extractHost(spec);
    if (!host) throw new Error("Connection string has an empty host.");
    const ips = await resolveHostIps(host);
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        throw new Error(
          "Connection string points at a private/internal address — only public database hosts are allowed.",
        );
      }
    }
  }
}
