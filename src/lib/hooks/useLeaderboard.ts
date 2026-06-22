"use client";

import useSWR from "swr";
import { jsonFetcher } from "./fetcher";
import type { Leader } from "@/lib/polymarket/types";
import type { LeaderMetric, LeaderWindow } from "@/lib/polymarket/leaderboard";

export function useLeaderboard(
  metric: LeaderMetric,
  window: LeaderWindow,
  limit = 20,
  enabled = true,
) {
  const url = enabled
    ? `/api/leaderboard?metric=${metric}&window=${window}&limit=${limit}`
    : null;
  const { data, error, isLoading } = useSWR<Leader[]>(url, jsonFetcher, {
    refreshInterval: 5 * 60 * 1000, // leaderboard moves slowly
    revalidateOnFocus: false,
    keepPreviousData: true,
  });
  return { leaders: data ?? [], error: error as Error | undefined, isLoading };
}
