import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * POST /api/filaments/{id}/restore — un-soft-delete a filament.
 *
 * Sets `_deletedAt` back to null, surfacing the filament in the regular list
 * again. There's one tricky case: the partial unique index on `name` only
 * covers non-deleted documents, so while a filament was in the trash, a new
 * filament with the same name could have been created. In that case the
 * restore would violate the index. We detect that up front and refuse with
 * a clear error so the user can rename one or the other rather than getting
 * a Mongo duplicate-key error.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;

    // Match the same filter the trash listing uses — a `_purged` row is a
    // "delete forever" tombstone and shouldn't be revivable from the API.
    const trashed = await Filament.findOne({
      _id: id,
      _deletedAt: { $ne: null },
      _purged: { $ne: true },
    });
    if (!trashed) {
      return errorResponse("Filament not in trash", 404);
    }

    // Name collision check: if a non-deleted filament now uses this name,
    // restoring would violate the partial unique index. Fail with a useful
    // message so the caller can rename one or the other.
    const conflict = await Filament.findOne({
      name: trashed.name,
      _deletedAt: null,
      _id: { $ne: trashed._id },
    })
      .select("_id")
      .lean();
    if (conflict) {
      return errorResponse(
        `Cannot restore: another active filament named "${trashed.name}" already exists. Rename one of them first.`,
        409,
      );
    }

    trashed._deletedAt = null;
    await trashed.save();

    return NextResponse.json({ message: "Restored", _id: String(trashed._id) });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to restore filament");
  }
}
