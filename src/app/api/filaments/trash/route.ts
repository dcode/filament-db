import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/trash — list soft-deleted filaments.
 *
 * Returns a lightweight projection sorted by deletion time (newest first).
 * The full document is still in the collection, just hidden from the regular
 * list endpoint by the `_deletedAt: null` filter. Restore via
 * POST /api/filaments/{id}/restore; permanent delete via
 * DELETE /api/filaments/{id}?permanent=true.
 */
export async function GET() {
  try {
    await dbConnect();
    const trashed = await Filament.find({ _deletedAt: { $ne: null } })
      .select("name vendor type color cost _deletedAt parentId")
      .sort({ _deletedAt: -1 })
      .lean();
    return NextResponse.json(trashed);
  } catch (err) {
    return errorResponse("Failed to list trash", 500, getErrorMessage(err));
  }
}
