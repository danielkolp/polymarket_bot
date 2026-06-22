"use client";

import useSWR from "swr";
import { jsonFetcher } from "./fetcher";
import type { Market } from "@/lib/polymarket/types";

export interface MarketFilters {
  status: "active" | "closed" | "all";
  minLiquidity?: number;
  minVolume?: number;
  minSpread?: number;
  maxSpread?: number;
  category?: string;
  maxDaysToResolution?: number;
  search?: string;
  limit?: number;
}

export function buildMarketsUrl(f: MarketFilters): string {
  const p = new URLSearchParams();
  p.set("status", f.status);
  p.set("limit", String(f.limit ?? 120));
  if (f.minLiquidity != null) p.set("minLiquidity", String(f.minLiquidity));
  if (f.minVolume != null) p.set("minVolume", String(f.minVolume));
  if (f.minSpread != null) p.set("minSpread", String(f.minSpread));
  if (f.maxSpread != null) p.set("maxSpread", String(f.maxSpread));
  if (f.category && f.category !== "all") p.set("category", f.category);
  if (f.maxDaysToResolution != null) p.set("maxDaysToResolution", String(f.maxDaysToResolution));
  if (f.search) p.set("search", f.search);
  return `/api/markets?${p.toString()}`;
}

export function useMarkets(filters: MarketFilters, refreshMs = 5000) {
  const url = buildMarketsUrl(filters);
  const { data, error, isLoading, mutate } = useSWR<Market[]>(url, jsonFetcher, {
    refreshInterval: refreshMs,
    keepPreviousData: true,
    dedupingInterval: 2000,
    revalidateOnFocus: false,
  });

  return {
    markets: data ?? [],
    error: error as Error | undefined,
    isLoading,
    mutate,
  };
}
