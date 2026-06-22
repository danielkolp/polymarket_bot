/**
 * GET /api/book?tokenId=... — normalized order book for a single CLOB token.
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchBook } from "@/lib/polymarket/clob";
import { PolymarketError } from "@/lib/polymarket/client";
import type { ApiEnvelope, OrderBook } from "@/lib/polymarket/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse<ApiEnvelope<OrderBook>>> {
  const tokenId = req.nextUrl.searchParams.get("tokenId");
  if (!tokenId) {
    return NextResponse.json({ ok: false, error: "tokenId is required" }, { status: 400 });
  }

  try {
    const book = await fetchBook(tokenId);
    return NextResponse.json(
      { ok: true, data: book, fetchedAt: Date.now() },
      { headers: { "Cache-Control": "public, max-age=1, stale-while-revalidate=5" } },
    );
  } catch (err) {
    const status = err instanceof PolymarketError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch book" },
      { status },
    );
  }
}
