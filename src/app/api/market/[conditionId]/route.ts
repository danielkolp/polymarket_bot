/**
 * GET /api/market/:conditionId — single normalized market by clob token id.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchMarketById } from "@/lib/polymarket/gamma";
import { PolymarketError } from "@/lib/polymarket/client";
import type { ApiEnvelope, Market } from "@/lib/polymarket/types";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ conditionId: string }> },
): Promise<NextResponse<ApiEnvelope<Market>>> {
  const { conditionId } = await params;
  try {
    const market = await fetchMarketById(conditionId);
    if (!market) {
      return NextResponse.json({ ok: false, error: "Market not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, data: market, fetchedAt: Date.now() });
  } catch (err) {
    const status = err instanceof PolymarketError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch market" },
      { status },
    );
  }
}
