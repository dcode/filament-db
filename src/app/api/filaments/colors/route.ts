import { NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";

/**
 * GET /api/filaments/colors
 *
 * Returns the distinct `(colorName, color)` pairs across all
 * non-deleted filaments — fuel for the colorName typeahead on
 * `FilamentForm`. Skips entries where `colorName` is empty/null so
 * the suggestion list doesn't include un-named entries; multiple
 * filaments sharing the same name with the same hex collapse to one
 * row (e.g. four spools labelled "Prusa Orange" with hex `#FA6E1C`
 * give one suggestion, not four).
 *
 * Different hexes under the same name are kept as separate
 * suggestions — that's intentional. The picker shows the swatch
 * alongside the name so the user can pick the right one even when
 * their previously-saved "Galaxy Black" differs in shade across
 * filaments.
 */
export async function GET() {
  try {
    await dbConnect();
    // $group on (colorName, color) so a single named hex pair appears
    // once regardless of how many filaments share it. The filter on
    // `colorName` keeps non-null, non-empty names only; the same
    // applies to color (defensive — schema default is "#808080" so
    // it's normally non-empty, but a malformed import could land null).
    const docs: Array<{ _id: { name: string; hex: string } }> = await Filament.aggregate([
      {
        $match: {
          _deletedAt: null,
          colorName: { $exists: true, $nin: [null, ""] },
          color: { $exists: true, $nin: [null, ""] },
        },
      },
      {
        $group: {
          _id: { name: "$colorName", hex: "$color" },
        },
      },
    ]);
    const pairs = docs
      .map((d) => ({ name: d._id.name, hex: d._id.hex }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return NextResponse.json(pairs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to fetch colors", detail: message }, { status: 500 });
  }
}
