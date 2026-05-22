import { MongoMemoryServer } from "mongodb-memory-server-core";
import path from "path";
import { app } from "electron";
import fs from "fs";

let mongod: MongoMemoryServer | null = null;
let uri: string | null = null;

/**
 * Start an embedded local MongoDB instance.
 * Data is persisted under the app's userData directory.
 */
export async function startLocalMongo(): Promise<string> {
  if (mongod && uri) return uri;

  const dbPath = path.join(app.getPath("userData"), "mongodb-data");
  if (!fs.existsSync(dbPath)) {
    fs.mkdirSync(dbPath, { recursive: true });
  }

  // MongoDB ships no native Windows arm64 build — only x86_64. Without this
  // override, mongodb-memory-server derives the arch from os.arch() ("arm64"
  // → "aarch64") and tries to download a nonexistent
  // mongodb-windows-aarch64-*.zip. Windows on ARM runs the x64 binary fine
  // under emulation, so pin the download to x86_64. (GH #240)
  const binary =
    process.platform === "win32" && process.arch === "arm64"
      ? { arch: "x86_64" }
      : undefined;

  mongod = await MongoMemoryServer.create({
    binary,
    instance: {
      dbPath,
      storageEngine: "wiredTiger",
      launchTimeout: 60000,
      // GH #318: pin the bind address to loopback explicitly. The
      // embedded database is unauthenticated; relying on the library's
      // default bind would silently expose it to the LAN if a future
      // mongodb-memory-server release changed that default.
      ip: "127.0.0.1",
    },
  });

  uri = mongod.getUri();
  // Append the database name
  const url = new URL(uri);
  url.pathname = "/filament-db";
  uri = url.toString();

  console.log("Local MongoDB started:", uri);
  return uri;
}

/**
 * Stop the embedded MongoDB instance.
 */
export async function stopLocalMongo(): Promise<void> {
  if (mongod) {
    await mongod.stop();
    mongod = null;
    uri = null;
    console.log("Local MongoDB stopped");
  }
}

/**
 * Get the current local MongoDB URI, or null if not running.
 */
export function getLocalMongoUri(): string | null {
  return uri;
}
