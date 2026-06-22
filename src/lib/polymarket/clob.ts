/**
 * CLOB API fetchers: order books, prices, midpoints, spreads. Read-only.
 * https://clob.polymarket.com
 */
import { clobRequest } from "./client";
import { normalizeBook } from "./normalize";
import type { OrderBook, RawClobBook } from "./types";

export async function fetchBook(tokenId: string): Promise<OrderBook> {
  const raw = await clobRequest<RawClobBook>("/book", { query: { token_id: tokenId } });
  return normalizeBook(raw ?? {}, tokenId);
}

/** Batch fetch multiple books in one upstream call. */
export async function fetchBooks(tokenIds: string[]): Promise<OrderBook[]> {
  if (tokenIds.length === 0) return [];
  const raws = await clobRequest<RawClobBook[]>("/books", {
    method: "POST",
    body: tokenIds.map((token_id) => ({ token_id })),
  });
  const list = Array.isArray(raws) ? raws : [];
  // Map results back to the requested order where possible.
  const byToken = new Map<string, RawClobBook>();
  for (const r of list) if (r.asset_id) byToken.set(r.asset_id, r);
  return tokenIds.map((id) => normalizeBook(byToken.get(id) ?? {}, id));
}

export async function fetchMidpoint(tokenId: string): Promise<number | null> {
  const res = await clobRequest<{ mid?: string }>("/midpoint", { query: { token_id: tokenId } });
  const n = Number(res?.mid);
  return Number.isFinite(n) ? n : null;
}

export async function fetchSpread(tokenId: string): Promise<number | null> {
  const res = await clobRequest<{ spread?: string }>("/spread", { query: { token_id: tokenId } });
  const n = Number(res?.spread);
  return Number.isFinite(n) ? n : null;
}
