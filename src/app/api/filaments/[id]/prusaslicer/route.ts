import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { generatePrusaSlicerBundle } from "@/lib/prusaSlicerBundle";
import {
  resolveFilamentForExport,
  exportFilenameStem,
} from "@/lib/singleFilamentExport";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/{id}/prusaslicer
 *
 * Download a single filament as a PrusaSlicer config bundle (`.ini`).
 * The user imports it via PrusaSlicer → File → Import → Import Config
 * Bundle. Variants are resolved against their parent so the exported
 * preset carries the full effective values.
 *
 * The bundle generator works on an array; a single filament is just a
 * one-element bundle.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await dbConnect();
    const { id } = await params;

    const filament = await resolveFilamentForExport(id);
    if (!filament) {
      return errorResponse("Filament not found", 404);
    }

    const ini = generatePrusaSlicerBundle([filament]);
    const stem = exportFilenameStem(filament.name);

    return new NextResponse(ini, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.ini"`,
      },
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to export filament for PrusaSlicer");
  }
}
