/**
 * Polymarket leaderboard fetchers (Data API v2).
 * https://data-api.polymarket.com/v2/leaderboard?time_period=week&sort_by=PNL
 *
 * lb-api.polymarket.com was retired (HTTP 410). v2 returns BOTH pnl and volume
 * for the same window on every row, which lets discovery compute a consistent
 * P&L-per-volume efficiency instead of dividing one window's P&L by another
 * window's volume.
 */
import { dataV2List, displayName, toNum, walletOf } from "./dataApi";
import type { Leader } from "./types";

export type LeaderWindow = "1d" | "7d" | "30d" | "all";
export type LeaderMetric = "profit" | "volume";

const TIME_PERIOD: Record<LeaderWindow, string> = { "1d": "day", "7d": "week", "30d": "month", all: "all" };

interface RawLeaderV2 {
  rank?: number | string;
  user_id?: string;
  pnl?: number | string;
  volume?: number | string;
  user_name?: string;
}

export async function fetchLeaders(
  metric: LeaderMetric = "profit",
  window: LeaderWindow = "7d",
  limit = 20,
  category = "overall",
): Promise<Leader[]> {
  const pageSize = Math.min(1000, Math.max(1, limit));
  const raws = await dataV2List<RawLeaderV2>(
    "/leaderboard",
    {
      time_period: TIME_PERIOD[window] ?? "week",
      sort_by: metric === "volume" ? "VOLUME" : "PNL",
      category,
      limit: pageSize,
    },
    1,
  );
  return raws
    .slice(0, pageSize)
    .map((r, i) => {
      const wallet = walletOf(r.user_id);
      const pnlUsd = toNum(r.pnl);
      const volume = toNum(r.volume);
      return {
        wallet,
        name: displayName(wallet, null, r.user_name),
        amount: metric === "volume" ? volume : pnlUsd,
        rank: toNum(r.rank) || i + 1,
        pnlUsd,
        volume,
      };
    })
    .filter((l) => l.wallet);
}
