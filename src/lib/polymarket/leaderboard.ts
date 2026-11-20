/**
 * Polymarket leaderboard fetchers (Data API v2).
 * https://data-api.polymarket.com/v2/leaderboard?time_period=week&sort_by=PNL
 *
 * The old lb-api.polymarket.com host was retired; v2 serves both the P&L and
 * volume boards and returns pnl AND volume on every row.
 */
import { dataRequest } from "./client";
import type { Leader } from "./types";

export type LeaderWindow = "1d" | "7d" | "30d" | "all";
export type LeaderMetric = "profit" | "volume";

interface RawLeaderV2 {
  rank?: number;
  user_id?: string;
  proxy_wallet?: string;
  pnl?: number | string;
  volume?: number | string;
  user_name?: string;
  x_username?: string;
}

const PERIOD: Record<LeaderWindow, string> = { "1d": "day", "7d": "week", "30d": "month", all: "all" };

function displayName(raw: RawLeaderV2, wallet: string): string {
  const name = (raw.user_name ?? "").trim();
  // v2 returns "<address>-<timestamp>" for users without a chosen name.
  if (!name || /^0x[0-9a-fA-F]{40}(-\d+)?$/.test(name)) return `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
  return name;
}

export async function fetchLeaders(
  metric: LeaderMetric = "profit",
  window: LeaderWindow = "7d",
  limit = 20,
): Promise<Leader[]> {
  const res = await dataRequest<{ data?: RawLeaderV2[] | null }>("/v2/leaderboard", {
    query: { time_period: PERIOD[window], sort_by: metric === "volume" ? "VOLUME" : "PNL", limit: Math.min(500, Math.max(1, limit)) },
  });
  const list = Array.isArray(res?.data) ? res.data : [];
  return list
    .map((r, i) => {
      const wallet = (r.user_id ?? r.proxy_wallet ?? "").toLowerCase();
      const pnl = Number(r.pnl);
      const volume = Number(r.volume);
      return {
        wallet,
        name: displayName(r, wallet),
        amount: metric === "volume" ? (Number.isFinite(volume) ? volume : 0) : Number.isFinite(pnl) ? pnl : 0,
        rank: Number(r.rank) || i + 1,
        pnlUsd: Number.isFinite(pnl) ? pnl : null,
        volumeUsd: Number.isFinite(volume) ? volume : null,
      };
    })
    .filter((l) => /^0x[0-9a-f]{40}$/.test(l.wallet));
}
