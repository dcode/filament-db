import { NextRequest, NextResponse } from "next/server";
import { MongoClient } from "mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";
import { assertSafeMongoUri } from "@/lib/mongoUriGuard";

export async function POST(request: NextRequest) {
  // GH #252: this route makes the server open an outbound MongoDB
  // connection to a caller-supplied host — reject cross-origin (CSRF)
  // callers so a hostile page can't drive it.
  const guard = assertSameOriginRequest(request);
  if (guard) return guard;

  let body;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { mongodbUri } = body;

  if (!mongodbUri || typeof mongodbUri !== "string") {
    return NextResponse.json({ error: "MongoDB URI is required" }, { status: 400 });
  }

  // GH #254: reject non-mongodb schemes outright. Unlike import-atlas,
  // `setup` configures the app's OWN database — a local/Docker install
  // legitimately points at `mongodb://localhost` or a private
  // Docker-network host, so private-IP blocking is deliberately NOT
  // applied here; restricting who may reach this route is GH #252.
  try {
    await assertSafeMongoUri(mongodbUri, { requireSrv: false, blockPrivateHosts: false });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid connection string" },
      { status: 400 },
    );
  }

  const client = new MongoClient(mongodbUri, {
    serverSelectionTimeoutMS: 5000,
    connectTimeoutMS: 5000,
  });

  try {
    await client.connect();
    await client.db().command({ ping: 1 });
    return NextResponse.json({ success: true, message: "Connection successful" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Connection failed";
    const safe = message.replace(/mongodb(\+srv)?:\/\/[^\s]+/g, "mongodb://***");
    return NextResponse.json({ error: safe }, { status: 400 });
  } finally {
    await client.close().catch(() => {});
  }
}
