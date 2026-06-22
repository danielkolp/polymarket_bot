/**
 * GET /api/leaderboard?metric=profit|volume&window=1d|7d|all&limit=
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchLeaders, type LeaderMetric, type LeaderWindow } from "@/lib/polymarket/leaderboard";
import { PolymarketError } from "@/lib/polymarket/client";
import type { ApiEnvelope, Leader } from "@/lib/polymarket/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiEnvelope<Leader[]>>> {
  const sp = req.nextUrl.searchParams;
  const metric = (sp.get("metric") === "volume" ? "volume" : "profit") as LeaderMetric;
  const w = sp.get("window");
  const window = (w === "1d" || w === "7d" || w === "all" ? w : "7d") as LeaderWindow;
  const limit = Math.min(50, Math.max(1, Number(sp.get("limit")) || 20));

  try {
    const leaders = await fetchLeaders(metric, window, limit);
    return NextResponse.json(
      { ok: true, data: leaders, fetchedAt: Date.now() },
      { headers: { "Cache-Control": "public, max-age=30, stale-while-revalidate=120" } },
    );
  } catch (err) {
    const status = err instanceof PolymarketError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch leaderboard" },
      { status },
    );
  }
}
