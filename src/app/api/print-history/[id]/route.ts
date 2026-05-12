import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import PrintHistory from "@/models/PrintHistory";
import Filament from "@/models/Filament";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * DELETE /api/print-history/{id} — remove a print history entry and refund
 * the corresponding spool weight so the ledger stays balanced.
 *
 * This handles the "print failed, undo this entry" case from issue #92. The
 * refund is best-effort: if a spool has since been deleted we log the refund
 * loss but still remove the history entry.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await dbConnect();
    const { id } = await params;
    // Filter on _deletedAt: null so a retry / double-click / client-retry
    // after a timeout doesn't re-run the refund loop on an already
    // tombstoned entry. Without this, each repeat call would refund the
    // spool weight again and inflate inventory totals.
    const entry = await PrintHistory.findOne({ _id: id, _deletedAt: null });
    if (!entry) {
      return errorResponse("Not found", 404);
    }

    for (const u of entry.usage) {
      const filament = await Filament.findOne({ _id: u.filamentId, _deletedAt: null });
      if (!filament) continue;
      const spool = u.spoolId
        ? filament.spools.find((s) => String(s._id) === String(u.spoolId))
        : null;
      if (!spool) continue;
      // Refund weight. GH #228 + Codex P1 review on PR #229: clamp at
      // the spool's **gross** full-weight ceiling. `spool.totalWeight`
      // is what the user reads off the scale — filament + empty spool —
      // so the cap must be in the same unit. That's
      //   spoolWeight (empty-spool tare) + netFilamentWeight (filament).
      // The pre-Codex shape clamped at `netFilamentWeight` alone, which
      // for any filament with a non-zero spool tare would under-refund
      // the empty-spool grams (e.g. a 1200g gross / 200g-tare spool got
      // capped to 1000g, locking 200g of legitimate weight out of the
      // refund forever).
      //
      // `spoolWeight` and `netFilamentWeight` both inherit from the
      // parent on variants (see src/lib/resolveFilament.ts
      // INHERITABLE_FIELDS), so resolve them via a one-shot parent
      // lookup when either is null on the variant.
      if (typeof spool.totalWeight === "number") {
        let tareWeight: number | null = filament.spoolWeight ?? null;
        let netCapacity: number | null = filament.netFilamentWeight ?? null;
        if (filament.parentId && (tareWeight == null || netCapacity == null)) {
          const parent = await Filament.findOne({
            _id: filament.parentId,
            _deletedAt: null,
          })
            .select("spoolWeight netFilamentWeight")
            .lean();
          if (parent) {
            if (tareWeight == null) tareWeight = (parent.spoolWeight as number | null) ?? null;
            if (netCapacity == null) netCapacity = (parent.netFilamentWeight as number | null) ?? null;
          }
        }
        const refunded = spool.totalWeight + u.grams;
        // Only clamp when we have a real net-capacity ceiling. The empty-
        // spool tare alone isn't a ceiling — a value of "spoolWeight: 200,
        // netFilamentWeight: null" means we know the tare but not the
        // filament capacity, so we can't bound the refund. Leaving
        // `netCapacity` null falls through to the legacy no-clamp behaviour.
        if (typeof netCapacity === "number" && netCapacity > 0) {
          const grossCapacity = netCapacity + (tareWeight ?? 0);
          spool.totalWeight = Math.min(refunded, grossCapacity);
        } else {
          spool.totalWeight = refunded;
        }
      }
      // Remove the matching usageHistory entry by jobId. Older entries
      // written before the v1.12.x audit don't carry a jobId; for those
      // we fall back to the legacy (grams, startedAt) match — but only
      // when the entry has source "job" or "slicer", which restricts
      // the candidate set to print-history-driven rows and avoids
      // accidentally clobbering a manual usage log that happens to
      // share both fields.
      spool.usageHistory = (spool.usageHistory || []).filter(
        (h, idx, arr) => {
          // New world: jobId match is unambiguous.
          if (h.jobId && String(h.jobId) === String(entry._id)) return false;

          // Legacy fallback (entries created before jobId existed).
          if (h.jobId) return true;
          if (h.source !== "job" && h.source !== "slicer") return true;
          if (h.grams !== u.grams) return true;
          if (h.date.getTime() !== entry.startedAt.getTime()) return true;
          // Remove only the first matching legacy entry per usage row.
          const firstMatch = arr.findIndex(
            (x) =>
              !x.jobId &&
              (x.source === "job" || x.source === "slicer") &&
              x.grams === u.grams &&
              x.date.getTime() === entry.startedAt.getTime(),
          );
          return idx !== firstMatch;
        },
      );
      await filament.save();
    }

    // Soft-delete by setting _deletedAt. Hard `deleteOne` would let a peer
    // sync resurrect the row from the other DB on the next cycle —
    // syncCollection treats "missing on one side" as pull/push, not delete,
    // and only propagates deletes via the _deletedAt tombstone. Same model
    // the rest of the synced collections already use.
    await PrintHistory.updateOne(
      { _id: id },
      { $set: { _deletedAt: new Date() } },
    );
    return NextResponse.json({ message: "Deleted and refunded" });
  } catch (err) {
    return errorResponse("Failed to delete print history", 500, getErrorMessage(err));
  }
}
