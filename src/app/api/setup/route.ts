import { NextRequest, NextResponse } from "next/server";
import { MongoClient } from "mongodb";
import { assertSameOriginRequest } from "@/lib/requestGuard";

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
