import { NextRequest, NextResponse } from "next/server";
import dbConnect from "@/lib/mongodb";
import Filament from "@/models/Filament";
import PrintHistory from "@/models/PrintHistory";
import { getErrorMessage, errorResponse } from "@/lib/apiErrorHandler";

/**
 * GET /api/analytics?days=30 — usage analytics aggregation.
 *
 * Returns:
 *   - usageByDay:   per-day total grams (for the bar chart)
 *   - byFilament:   total grams and cost per filament, sorted desc
 *   - byVendor:     total grams per vendor
 *   - byPrinter:    total grams per printer (only printed jobs)
 *   - totals:       summary across the window
 *
 * Uses PrintHistory as the source of truth (slicer-driven) because it's
 * already aggregated per-job and timestamps; falls back to per-spool
 * usageHistory for older data points the user logged manually on a spool
 * that wasn't tied to a job.
 */
export async function GET(request: NextRequest) {
  try {
    await dbConnect();
    const rawDays = Number(request.nextUrl.searchParams.get("days") ?? "30");
    const days = Math.min(Math.max(Number.isFinite(rawDays) ? rawDays : 30, 7), 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [history, filaments] = await Promise.all([
      PrintHistory.find({ _deletedAt: null, startedAt: { $gte: since } })
        .populate("printerId", "name")
        // GH #223: include parentId + the bits we'll inherit (cost) so we
        // can resolve variant-inherited cost without a second round-trip.
        // Without this the populate returns the variant's own `cost`
        // (typically null on inheriting variants), so `totalCost` would
        // contribute 0 grams worth for every print job against a variant.
        .populate("usage.filamentId", "name vendor cost parentId")
        .lean(),
      // Include `parentId` here as well so the manual-usage loop below can
      // walk inheritance.
      Filament.find({ _deletedAt: null })
        .select("name vendor cost parentId spools")
        .lean(),
    ]);

    // GH #223: build a parent-cost lookup so cost inheritance resolves
    // without per-row queries. Collect every unique `parentId` referenced
    // by either the populated PrintHistory.usage entries or the manual
    // spool loop, batch-fetch their costs, then expose a helper that
    // returns `variantCost ?? parentCost ?? null` for any filament shape.
    const parentIdSet = new Set<string>();
    for (const f of filaments) if (f.parentId) parentIdSet.add(String(f.parentId));
    for (const entry of history) {
      for (const u of entry.usage || []) {
        const populated = u.filamentId as { parentId?: unknown } | null;
        if (populated && typeof populated === "object" && populated.parentId) {
          parentIdSet.add(String(populated.parentId));
        }
      }
    }
    const parentCostMap = new Map<string, number | null>();
    if (parentIdSet.size > 0) {
      const parents = await Filament.find({
        _id: { $in: Array.from(parentIdSet) },
        _deletedAt: null,
      })
        .select("_id cost")
        .lean();
      for (const p of parents) {
        parentCostMap.set(String(p._id), (p.cost as number | null) ?? null);
      }
    }
    function resolveCost(
      ownCost: number | null | undefined,
      parentId: unknown,
    ): number | null {
      if (ownCost != null) return ownCost;
      if (!parentId) return null;
      return parentCostMap.get(String(parentId)) ?? null;
    }

    // Build usageByDay bucket. Date key = YYYY-MM-DD in UTC for stability.
    const byDay = new Map<string, number>();
    const byFilament = new Map<
      string,
      { name: string; vendor: string; cost: number | null; grams: number }
    >();
    const byVendor = new Map<string, number>();
    const byPrinter = new Map<string, { name: string; grams: number }>();
    let totalGrams = 0;
    let totalCost = 0;
    // GH #204: per-spool `usageHistory` entries logged directly on the
    // spool UI (source: "manual") count toward grams + cost but are not
    // PrintHistory documents, so the existing `jobs` counter doesn't
    // include them. Surface a separate count so the user can attribute
    // the "Grams used" total — pre-fix the page showed `50 g · $1.10 ·
    // 0 jobs` with no hint that the 50 g came from a manual entry.
    let manualEntries = 0;

    // Seed all days in the window with 0 so the chart has no gaps.
    for (let i = 0; i <= days; i++) {
      const d = new Date(since);
      d.setUTCDate(d.getUTCDate() + i);
      byDay.set(d.toISOString().slice(0, 10), 0);
    }

    for (const entry of history) {
      // GH #269: a malformed `startedAt` already in the DB (bad import,
      // snapshot restore, or the historical print-history bug) is an
      // Invalid Date — `.toISOString()` on it throws RangeError and 500s
      // the whole endpoint. Skip the offending row instead.
      const entryDate = new Date(entry.startedAt);
      if (Number.isNaN(entryDate.getTime())) continue;
      const dayKey = entryDate.toISOString().slice(0, 10);
      byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + sumGrams(entry.usage));
      const printerId =
        entry.printerId && typeof entry.printerId === "object"
          ? String((entry.printerId as { _id?: unknown })._id ?? "")
          : entry.printerId
            ? String(entry.printerId)
            : "";
      const printerName =
        entry.printerId && typeof entry.printerId === "object"
          ? ((entry.printerId as { name?: string }).name ?? "(unknown)")
          : "(unknown)";

      for (const u of entry.usage || []) {
        const fid = u.filamentId && typeof u.filamentId === "object"
          ? String((u.filamentId as { _id?: unknown })._id ?? "")
          : String(u.filamentId);
        const fdoc = u.filamentId && typeof u.filamentId === "object"
          ? (u.filamentId as { name?: string; vendor?: string; cost?: number | null; parentId?: unknown })
          : null;
        const name = fdoc?.name ?? "(unknown)";
        const vendor = fdoc?.vendor ?? "(unknown)";
        // GH #223: was `fdoc?.cost ?? null` — read the variant's own cost
        // directly and contributed 0 to totalCost for every job against
        // an inheriting variant. resolveCost falls back to the parent.
        const cost = resolveCost(fdoc?.cost ?? null, fdoc?.parentId);
        const existing = byFilament.get(fid);
        if (existing) existing.grams += u.grams;
        else byFilament.set(fid, { name, vendor, cost, grams: u.grams });
        byVendor.set(vendor, (byVendor.get(vendor) ?? 0) + u.grams);
        totalGrams += u.grams;
        if (cost != null) totalCost += (u.grams / 1000) * cost;
      }

      if (printerId) {
        const existing = byPrinter.get(printerId);
        if (existing) existing.grams += sumGrams(entry.usage);
        else byPrinter.set(printerId, { name: printerName, grams: sumGrams(entry.usage) });
      }
    }

    // Also incorporate per-spool manual usage entries that don't have a
    // matching PrintHistory record — users who log usage directly on a
    // spool (not through /api/print-history) shouldn't disappear from
    // analytics.
    for (const f of filaments) {
      for (const s of f.spools || []) {
        for (const u of s.usageHistory || []) {
          const uDate = new Date(u.date as unknown as string | Date);
          // GH #269: skip a malformed usageHistory date — `NaN < since`
          // is false, so without this check the entry slips through to
          // `uDate.toISOString()` below and throws RangeError.
          if (Number.isNaN(uDate.getTime())) continue;
          if (uDate < since) continue;
          // Only "manual" means "logged directly on the spool UI without a
          // PrintHistory record". "job" and "slicer" entries are owned by a
          // PrintHistory row and already counted in the first loop above;
          // including them here would double-count the same grams.
          if (u.source !== "manual") continue;
          const dayKey = uDate.toISOString().slice(0, 10);
          byDay.set(dayKey, (byDay.get(dayKey) ?? 0) + u.grams);
          // GH #223: same fix as the PrintHistory loop above — fall back
          // to the parent's cost when the variant inherits.
          const fCost = resolveCost(f.cost ?? null, f.parentId);
          const existing = byFilament.get(String(f._id));
          if (existing) existing.grams += u.grams;
          else
            byFilament.set(String(f._id), {
              name: f.name,
              vendor: f.vendor,
              cost: fCost,
              grams: u.grams,
            });
          byVendor.set(f.vendor, (byVendor.get(f.vendor) ?? 0) + u.grams);
          totalGrams += u.grams;
          if (fCost != null) totalCost += (u.grams / 1000) * fCost;
          manualEntries++;
        }
      }
    }

    const usageByDay = Array.from(byDay.entries())
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, grams]) => ({ date, grams: Math.round(grams) }));

    const byFilamentArr = Array.from(byFilament.entries())
      .map(([id, v]) => ({ _id: id, ...v, grams: Math.round(v.grams) }))
      .sort((a, b) => b.grams - a.grams);

    const byVendorArr = Array.from(byVendor.entries())
      .map(([vendor, grams]) => ({ vendor, grams: Math.round(grams) }))
      .sort((a, b) => b.grams - a.grams);

    const byPrinterArr = Array.from(byPrinter.entries())
      .map(([id, v]) => ({ _id: id, name: v.name, grams: Math.round(v.grams) }))
      .sort((a, b) => b.grams - a.grams);

    return NextResponse.json({
      since: since.toISOString(),
      days,
      totals: {
        grams: Math.round(totalGrams),
        cost: Math.round(totalCost * 100) / 100,
        jobs: history.length,
        manualEntries,
      },
      usageByDay,
      byFilament: byFilamentArr,
      byVendor: byVendorArr,
      byPrinter: byPrinterArr,
    });
  } catch (err) {
    return errorResponse("Failed to build analytics", 500, getErrorMessage(err));
  }
}

function sumGrams(usage: { grams: number }[] | undefined): number {
  return (usage || []).reduce((sum, u) => sum + u.grams, 0);
}
