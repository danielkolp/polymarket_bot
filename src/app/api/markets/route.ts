/**
 * GET /api/markets — scan + normalize Polymarket markets with filters.
 *
 * Query params (all optional):
 *   limit, offset            pagination
 *   order, ascending         sort
 *   status                   "active" | "closed" | "all"  (default active)
 *   minLiquidity             number
 *   minVolume                number
 *   minSpread, maxSpread     fractional spread bounds (client-side refine)
 *   category                 case-insensitive substring match (client-side)
 *   maxDaysToResolution      filter by time-to-resolution (client-side)
 *   search                   substring match on question (client-side)
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchMarkets, type MarketQuery } from "@/lib/polymarket/gamma";
import { PolymarketError } from "@/lib/polymarket/client";
import type { ApiEnvelope, Market } from "@/lib/polymarket/types";

export const dynamic = "force-dynamic";

function numParam(v: string | null): number | undefined {
  if (v == null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export async function GET(req: NextRequest): Promise<NextResponse<ApiEnvelope<Market[]>>> {
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") ?? "active";

  const query: MarketQuery = {
    limit: numParam(sp.get("limit")) ?? 120,
    offset: numParam(sp.get("offset")) ?? 0,
    order: sp.get("order") ?? "volume24hr",
    ascending: sp.get("ascending") === "true",
    liquidityNumMin: numParam(sp.get("minLiquidity")),
    volumeNumMin: numParam(sp.get("minVolume")),
  };

  if (status === "active") {
    query.active = true;
    query.closed = false;
  } else if (status === "closed") {
    query.closed = true;
  }

  // Category is a Polymarket tag slug, filtered at the Gamma layer.
  const category = sp.get("category");
  if (category && category !== "all") query.tagSlug = category;

  try {
    let markets = await fetchMarkets(query);

    // Gamma markets don't carry a category label; apply the selected one for display.
    if (category && category !== "all") {
      const label = titleCase(category);
      markets = markets.map((m) => ({ ...m, category: label }));
    }

    // Client-side refinements Gamma can't express directly.
    const minSpread = numParam(sp.get("minSpread"));
    const maxSpread = numParam(sp.get("maxSpread"));
    const search = sp.get("search")?.toLowerCase();
    const maxDays = numParam(sp.get("maxDaysToResolution"));

    markets = markets.filter((m) => {
      if (minSpread != null && m.spread < minSpread) return false;
      if (maxSpread != null && m.spread > maxSpread) return false;
      if (search && !m.question.toLowerCase().includes(search)) return false;
      if (maxDays != null && m.timeToResolutionMs != null) {
        const days = m.timeToResolutionMs / 86_400_000;
        if (days > maxDays) return false;
      }
      return true;
    });

    return NextResponse.json(
      { ok: true, data: markets, fetchedAt: Date.now() },
      { headers: { "Cache-Control": "public, max-age=3, stale-while-revalidate=10" } },
    );
  } catch (err) {
    const status = err instanceof PolymarketError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch markets" },
      { status },
    );
  }
}
