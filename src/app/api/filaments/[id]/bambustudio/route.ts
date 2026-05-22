import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import { generateOrcaSlicerProfiles } from "@/lib/orcaSlicerBundle";
import {
  resolveFilamentForExport,
  exportFilenameStem,
} from "@/lib/singleFilamentExport";
import { errorResponse, errorResponseFromCaught } from "@/lib/apiErrorHandler";

/**
 * GET /api/filaments/{id}/bambustudio
 *
 * Download a single filament as a Bambu Studio filament-preset (`.json`).
 *
 * OrcaSlicer is a fork of Bambu Studio and the two share the filament-
 * preset JSON schema (same keys, same single-element-array value
 * convention). So this route reuses the OrcaSlicer profile generator and
 * applies the one meaningful Bambu-specific tweak:
 *
 *   `from` → "User"
 *
 * Bambu Studio classifies presets by their `from` field — "User" marks a
 * user-created preset (which is what an exported filament is). The
 * OrcaSlicer generator stamps a custom "filament_db" marker there, which
 * Bambu Studio doesn't recognise as a user preset.
 *
 * No `inherits` is set: that would have to name a base system preset
 * present in *this user's* Bambu Studio install, which the server can't
 * know. The exported preset is therefore standalone — it imports fine
 * via Bambu Studio's custom-filament import, the user just won't get
 * system-preset inheritance.
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

    const profile = generateOrcaSlicerProfiles([filament])[0];
    // Bambu-specific: mark as a user preset so Bambu Studio files it
    // under the user's custom filaments on import.
    profile.from = "User";

    const stem = exportFilenameStem(filament.name);

    return new NextResponse(JSON.stringify(profile, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.json"`,
      },
    });
  } catch (err) {
    return errorResponseFromCaught(err, "Failed to export filament for Bambu Studio");
  }
}
