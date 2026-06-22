/**
 * POST /api/books — batch fetch normalized order books.
 * Body: { tokenIds: string[] }
 */
import { NextRequest, NextResponse } from "next/server";
import { fetchBooks } from "@/lib/polymarket/clob";
import { PolymarketError } from "@/lib/polymarket/client";
import type { ApiEnvelope, OrderBook } from "@/lib/polymarket/types";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse<ApiEnvelope<OrderBook[]>>> {
  let tokenIds: string[] = [];
  try {
    const body = await req.json();
    tokenIds = Array.isArray(body?.tokenIds) ? body.tokenIds.map(String) : [];
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // Guard against accidental huge fan-out.
  tokenIds = tokenIds.filter(Boolean).slice(0, 50);

  try {
    const books = await fetchBooks(tokenIds);
    return NextResponse.json({ ok: true, data: books, fetchedAt: Date.now() });
  } catch (err) {
    const status = err instanceof PolymarketError ? err.status : 500;
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to fetch books" },
      { status },
    );
  }
}
