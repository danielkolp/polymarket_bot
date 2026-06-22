/**
 * Polymarket leaderboard fetchers.
 * https://lb-api.polymarket.com/profit  and  /volume
 */
import { lbRequest } from "./client";
import type { Leader } from "./types";

export type LeaderWindow = "1d" | "7d" | "all";
export type LeaderMetric = "profit" | "volume";

interface RawLeader {
  proxyWallet?: string;
  wallet?: string;
  amount?: number | string;
  name?: string;
  pseudonym?: string;
}

export async function fetchLeaders(
  metric: LeaderMetric = "profit",
  window: LeaderWindow = "7d",
  limit = 20,
): Promise<Leader[]> {
  const raws = await lbRequest<RawLeader[]>(`/${metric}`, { query: { window, limit } });
  const list = Array.isArray(raws) ? raws : [];
  return list
    .map((r, i) => {
      const wallet = (r.proxyWallet ?? r.wallet ?? "").toLowerCase();
      const amount = Number(r.amount);
      return {
        wallet,
        name: r.pseudonym || r.name || (wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "anon"),
        amount: Number.isFinite(amount) ? amount : 0,
        rank: i + 1,
      };
    })
    .filter((l) => l.wallet);
}
