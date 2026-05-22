import { NextRequest, NextResponse } from "next/server";
import mongoose from "mongoose";
import dbConnect from "@/lib/mongodb";
import Printer from "@/models/Printer";
import Filament from "@/models/Filament";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";
import { findSpoolSlot, assignSpoolToSlot } from "@/lib/spoolSlots";

/**
 * GH #242 — manage which printer AMS/MMU slot a spool currently occupies,
 * from the spool's side. Writes only `Printer` documents; never touches
 * the spool's `locationId` ("home"). See src/lib/spoolSlots.ts for the
 * one-slot invariant and the hybrid-sync caveat.
 */

/** GET — the spool's current slot assignment, or `{ assignment: null }`. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ spoolId: string }> },
) {
  try {
    await dbConnect();
    const { spoolId } = await params;
    if (!mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid spool id", 400);
    }
    const assignment = await findSpoolSlot(Printer, spoolId);
    return NextResponse.json({ assignment });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to look up spool slot");
  }
}

/** PUT — assign the spool to `{ printerId, slotId }`, clearing it from any
 * other slot it currently occupies. */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ spoolId: string }> },
) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON in request body", 400);
  }

  try {
    await dbConnect();
    const { spoolId } = await params;
    if (!mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid spool id", 400);
    }

    const printerId = (body as { printerId?: unknown })?.printerId;
    const slotId = (body as { slotId?: unknown })?.slotId;
    if (
      typeof printerId !== "string" ||
      typeof slotId !== "string" ||
      !printerId ||
      !slotId
    ) {
      return errorResponse("printerId and slotId are required", 400);
    }
    if (
      !mongoose.isValidObjectId(printerId) ||
      !mongoose.isValidObjectId(slotId)
    ) {
      return errorResponse("Invalid printerId or slotId", 400);
    }

    // The spool must exist on some active filament.
    const spoolExists = await Filament.exists({
      _deletedAt: null,
      "spools._id": spoolId,
    });
    if (!spoolExists) {
      return errorResponse("Spool not found", 404);
    }

    // The target printer must be active and actually own the slot.
    const printer = await Printer.findOne({
      _id: printerId,
      _deletedAt: null,
      "amsSlots._id": slotId,
    })
      .select("_id")
      .lean();
    if (!printer) {
      return errorResponse("Printer or slot not found", 404);
    }

    await assignSpoolToSlot(Printer, spoolId, { printerId, slotId });
    const assignment = await findSpoolSlot(Printer, spoolId);
    return NextResponse.json({ assignment });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to assign spool to slot");
  }
}

/** DELETE — clear the spool from whatever slot it is in. Idempotent. */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ spoolId: string }> },
) {
  try {
    await dbConnect();
    const { spoolId } = await params;
    if (!mongoose.isValidObjectId(spoolId)) {
      return errorResponse("Invalid spool id", 400);
    }
    await assignSpoolToSlot(Printer, spoolId, null);
    return NextResponse.json({ assignment: null });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to clear spool slot");
  }
}
