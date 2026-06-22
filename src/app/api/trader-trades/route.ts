/**
 * GET /api/trader-trades?wallets=0xabc,0xdef&perWallet=15
 * Returns recent trades for the given wallets, newest first.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchTradesForWallets } from "@/lib/polymarket/traderTrades";
import { PolymarketError } from "@/lib/polymarket/client";
import type { ApiEnvelope, TraderTrade } from "@/lib/polymarket/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiEnvelope<TraderTrade[]>>> {
  const sp = req.nextUrl.searchParams;
  const wallets = (sp.get("wallets") ?? "")
    .split(",")
    .map((w) => w.trim())
    .filter(Boolean);
  const perWallet = Math.min(50, Math.max(1, Number(sp.get("perWallet")) || 15));

  if (wallets.length === 0) {
    return NextResponse.json({ ok: true, data: [], fetchedAt: Date.now() });
  }

  try {
    const trades = await fetchTradesForWallets(wallets, perWallet);
    return NextResponse.json(
      { ok: true, data: trades, fetchedAt: Date.now() },
      { headers: { "Cache-Control": "public, max-age=10, stale-while-revalidate=30" } },
    );
  } catch (err) {
    const status = err instanceof PolymarketError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch trader trades" },
      { status },
    );
  }
}
