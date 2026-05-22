import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * Match a scanned NFC tag against the filament database.
 *
 * A non-null `match` is only ever returned for a *confident* match:
 *   1. an exact (case-insensitive) name match, or
 *   2. exactly one filament agreeing on BOTH vendor and type.
 *
 * Vendor alone is never enough — a PC spool must not silently match the
 * user's only Bambu PLA filament. The vendor-only fallback returns the
 * vendor's filaments as `candidates` for the user to pick from, with
 * `match: null`.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();

    const params = request.nextUrl.searchParams;
    const name = params.get("name");
    const vendor = params.get("vendor");
    const type = params.get("type");

    // 1. Exact name match (case-insensitive) — a confident match.
    if (name) {
      const exact = await Filament.findOne({
        name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
        _deletedAt: null,
      }).lean();
      if (exact) {
        return NextResponse.json({ match: exact, candidates: [] });
      }
    }

    // 2. Vendor + type match. A confident auto-match requires BOTH vendor
    //    and type to agree.
    const vendorTypeMatches =
      vendor && type
        ? await Filament.find({
            vendor: { $regex: escapeRegex(vendor), $options: "i" },
            type: { $regex: `^${escapeRegex(type)}$`, $options: "i" },
            _deletedAt: null,
          })
            .sort({ name: 1 })
            .limit(5)
            .lean()
        : [];

    // Exactly one vendor+type hit → confident match. More than one → hand
    // them back as candidates for the user to disambiguate.
    if (vendorTypeMatches.length === 1) {
      return NextResponse.json({ match: vendorTypeMatches[0], candidates: [] });
    }
    if (vendorTypeMatches.length > 1) {
      return NextResponse.json({ match: null, candidates: vendorTypeMatches });
    }

    // 3. Vendor-only fallback — suggestions ONLY, never an auto-match. The
    //    type didn't agree (or none was supplied), so the most we can do
    //    is surface the vendor's filaments for the user to pick from.
    if (vendor) {
      const vendorMatches = await Filament.find({
        vendor: { $regex: escapeRegex(vendor), $options: "i" },
        _deletedAt: null,
      })
        .sort({ name: 1 })
        .limit(5)
        .lean();
      return NextResponse.json({ match: null, candidates: vendorMatches });
    }

    return NextResponse.json({ match: null, candidates: [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to match filaments", detail: message },
      { status: 500 },
    );
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
