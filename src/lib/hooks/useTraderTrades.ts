"use client";

import useSWR from "swr";
import { jsonFetcher } from "./fetcher";
import type { TraderTrade } from "@/lib/polymarket/types";

/**
 * Polls recent trades for the followed wallets. Runs on a slower cadence than
 * the engine tick — copy-trading "runs every few minutes".
 */
export function useTraderTrades(wallets: string[], refreshMs = 60_000, enabled = true) {
  const sorted = [...wallets].sort();
  const key = enabled && sorted.length ? `/api/trader-trades?wallets=${sorted.join(",")}&perWallet=15` : null;

  const { data, error, isLoading } = useSWR<TraderTrade[]>(key, jsonFetcher, {
    refreshInterval: refreshMs,
    revalidateOnFocus: false,
    keepPreviousData: true,
    dedupingInterval: 5000,
  });

  return { trades: data ?? [], error: error as Error | undefined, isLoading };
}
