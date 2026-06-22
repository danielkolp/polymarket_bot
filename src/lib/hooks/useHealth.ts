"use client";

import useSWR from "swr";
import { jsonFetcher } from "./fetcher";

export interface HealthData {
  appName: string;
  realTradingEnabled: boolean;
  simulationOnly: boolean;
  upstream: { gamma: boolean; gammaError: string | null };
  time: number;
}

export function useHealth() {
  const { data, error, isLoading } = useSWR<HealthData>("/api/health", jsonFetcher, {
    refreshInterval: 20000,
    revalidateOnFocus: false,
  });
  return { health: data, error: error as Error | undefined, isLoading };
}
