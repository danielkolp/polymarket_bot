"use client";

import useSWR from "swr";
import type { ApiEnvelope, OrderBook } from "@/lib/polymarket/types";

async function postBooks(tokenIds: string[]): Promise<OrderBook[]> {
  if (tokenIds.length === 0) return [];
  const res = await fetch("/api/books", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tokenIds }),
  });
  const body = (await res.json().catch(() => null)) as ApiEnvelope<OrderBook[]> | null;
  if (!res.ok || !body || body.ok === false) {
    throw new Error(body && body.ok === false ? body.error : `Books request failed (${res.status})`);
  }
  return body.data;
}

/**
 * Polls order books for the given token ids (driven by the engine's watch list).
 * Returns a map keyed by tokenId for O(1) lookup in the tick loop.
 */
export function useOrderBooks(tokenIds: string[], refreshMs = 4000) {
  const sorted = [...tokenIds].sort();
  const key = sorted.length ? `books:${sorted.join(",")}` : null;

  const { data, error, isLoading } = useSWR(key, () => postBooks(sorted), {
    refreshInterval: refreshMs,
    keepPreviousData: true,
    dedupingInterval: 1500,
    revalidateOnFocus: false,
  });

  const booksByToken: Record<string, OrderBook> = {};
  for (const b of data ?? []) booksByToken[b.tokenId] = b;

  return { booksByToken, error: error as Error | undefined, isLoading };
}
