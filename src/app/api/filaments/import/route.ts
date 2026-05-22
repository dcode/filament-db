import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import { parseIniFilaments } from "@/lib/parseIni";
import { checkFileSize } from "@/lib/apiErrorHandler";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const sizeError = checkFileSize(file);
    if (sizeError) return sizeError;

    const content = await file.text();
    const filaments = parseIniFilaments(content);

    if (filaments.length === 0) {
      return NextResponse.json(
        { error: "No filament profiles found in the INI file" },
        { status: 400 }
      );
    }

    // GH #297: cap the bundle size — mirrors parseCsv's 10k maxRows.
    // A huge bundle would otherwise drive unbounded sequential writes.
    const MAX_IMPORT_FILAMENTS = 10_000;
    if (filaments.length > MAX_IMPORT_FILAMENTS) {
      return NextResponse.json(
        {
          error: `Import too large: ${filaments.length} profiles exceeds the ${MAX_IMPORT_FILAMENTS} limit.`,
        },
        { status: 400 },
      );
    }

    await dbConnect();

    let created = 0;
    let updated = 0;
    const errors: string[] = [];

    for (const filament of filaments) {
      try {
        const { name, ...rest } = filament;

        // Update an existing active filament with this name.
        const active = await Filament.findOne({ name, _deletedAt: null });
        if (active) {
          // GH #308: runValidators so the update branch enforces the
          // same schema constraints (cost.min, etc.) as a create.
          await Filament.updateOne(
            { _id: active._id },
            { $set: rest },
            { runValidators: true, context: "query" },
          );
          updated++;
          continue;
        }

        // GH #297: if a TRASHED (non-purged) filament owns this name,
        // resurrect-and-update it rather than creating a second active
        // row. Creating a duplicate would strand the trashed one — its
        // restore would then 409 on the name conflict, forever. Mirrors
        // the resurrect behaviour of the CSV importer.
        const trashed = await Filament.findOne({
          name,
          _deletedAt: { $ne: null },
          _purged: { $ne: true },
        });
        if (trashed) {
          await Filament.updateOne(
            { _id: trashed._id },
            { $set: { ...rest, _deletedAt: null } },
            { runValidators: true, context: "query" },
          );
          updated++;
          continue;
        }

        await Filament.create({ name, ...rest });
        created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${filament.name}: ${msg}`);
      }
    }

    const result: Record<string, unknown> = {
      message: `Imported ${created + updated} filaments (${created} new, ${updated} updated)`,
      total: created + updated,
      created,
      updated,
    };
    if (errors.length > 0) {
      result.errors = errors;
      result.message = `${result.message}. ${errors.length} error(s).`;
    }

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "Failed to import filaments", detail: message },
      { status: 500 },
    );
  }
}
