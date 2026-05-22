import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import SharedCatalog from "@/models/SharedCatalog";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/share/{slug} — fetch a public shared catalog by its slug.
 *
 * Returns the denormalised payload captured at publish time. Increments
 * viewCount as a lightweight popularity signal. Respects expiresAt.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    await dbConnect();
    const { slug } = await params;

    // GH #272: look the catalog up first, then increment viewCount only
    // for a valid, non-expired hit. The pre-fix handler `$inc`'d on every
    // GET *before* the expiry check, so expired catalogs kept accruing
    // views and any caller could inflate the count by hammering the slug.
    // Filter on _deletedAt: null so an unpublished (soft-deleted) slug
    // returns 404 rather than 200.
    const catalog = await SharedCatalog.findOne({ slug, _deletedAt: null });
    if (!catalog) {
      return errorResponse("Shared catalog not found", 404);
    }
    if (catalog.expiresAt && catalog.expiresAt < new Date()) {
      return errorResponse("Shared catalog has expired", 410);
    }

    // Targeted `$inc` — atomic and collision-safe under concurrent
    // viewers, so simultaneous hits don't drop updates the way a
    // read-modify-write (findOne + save) would.
    await SharedCatalog.updateOne(
      { _id: catalog._id },
      { $inc: { viewCount: 1 } },
    );

    return NextResponse.json({
      slug: catalog.slug,
      title: catalog.title,
      description: catalog.description,
      createdAt: catalog.createdAt,
      expiresAt: catalog.expiresAt,
      viewCount: (catalog.viewCount ?? 0) + 1,
      payload: catalog.payload,
    });
  } catch (err) {
    return errorResponse("Failed to fetch shared catalog", 500, getErrorMessage(err));
  }
}

/**
 * DELETE /api/share/{slug} — unpublish a shared catalog.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    await dbConnect();
    const { slug } = await params;
    // Soft-delete instead of hard `deleteOne` so the unpublish actually
    // sticks across peers. syncCollection treats a missing row as
    // "pull/push back" rather than "propagate the delete" — without a
    // _deletedAt tombstone the next sync from the other peer would
    // resurrect the catalog and re-expose the link the user took down.
    const res = await SharedCatalog.updateOne(
      { slug, _deletedAt: null },
      { $set: { _deletedAt: new Date() } },
    );
    if (res.matchedCount === 0) {
      return errorResponse("Shared catalog not found", 404);
    }
    return NextResponse.json({ message: "Unpublished" });
  } catch (err) {
    return errorResponse("Failed to unpublish shared catalog", 500, getErrorMessage(err));
  }
}
