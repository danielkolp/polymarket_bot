import { fetchLeaders } from "@/lib/polymarket/leaderboard";
import { fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { TraderTrade } from "@/lib/polymarket/types";
import type { BotSettings, CopyTradeRecord, FollowedTrader } from "./types";

const WEEK_SEC = 7 * 24 * 60 * 60;
const MIN_LEADERBOARD_CANDIDATES = 50;
const MAX_LEADERBOARD_CANDIDATES = 250;
const DISCOVERY_CONCURRENCY = 8;

interface DiscoveryCandidate {
  wallet: string;
  name: string;
  rank: number;
  weeklyPnlUsd: number;
  weeklyVolumeUsd: number;
  weeklyTradeCount: number;
  copiedTradeCount: number;
  copiedSimPnlUsd: number;
  lastTradeAt: number | null;
  score: number;
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function weeklyTrades(trades: TraderTrade[], nowSec: number): TraderTrade[] {
  return trades.filter((trade) => nowSec - trade.timestamp <= WEEK_SEC);
}

/** Most recent trade timestamp in ms, independent of API ordering. */
function latestTradeAtMs(trades: TraderTrade[]): number | null {
  let maxSec = 0;
  for (const trade of trades) if (trade.timestamp > maxSec) maxSec = trade.timestamp;
  return maxSec > 0 ? maxSec * 1000 : null;
}

function weeklyVolume(trades: TraderTrade[]): number {
  return trades.reduce((sum, trade) => sum + Math.max(0, trade.price * trade.size), 0);
}

function copiedPnlForWallet(wallet: string, trades: CopyTradeRecord[]): number {
  return trades
    .filter((trade) => trade.traderWallet === wallet && (trade.status === "simulated" || trade.status === "copied"))
    .reduce((sum, trade) => sum + trade.realizedPnlUsd, 0);
}

function copiedCountForWallet(wallet: string, trades: CopyTradeRecord[]): number {
  return trades.filter((trade) => trade.traderWallet === wallet && trade.status === "simulated").length;
}

function leaderboardCandidateLimit(settings: BotSettings): number {
  return Math.min(
    MAX_LEADERBOARD_CANDIDATES,
    Math.max(MIN_LEADERBOARD_CANDIDATES, settings.topTradersToFollow * 4),
  );
}

export async function discoverTraders(
  settings: BotSettings,
  existing: FollowedTrader[],
  copiedTrades: CopyTradeRecord[],
  now = Date.now(),
): Promise<FollowedTrader[]> {
  const nowSec = Math.floor(now / 1000);
  const existingByWallet = new Map(existing.map((trader) => [trader.wallet.toLowerCase(), trader]));
  const leaders = await fetchLeaders("profit", "7d", leaderboardCandidateLimit(settings));

  const candidates: PromiseSettledResult<DiscoveryCandidate>[] = [];
  for (let i = 0; i < leaders.length; i += DISCOVERY_CONCURRENCY) {
    const batch = leaders.slice(i, i + DISCOVERY_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (leader): Promise<DiscoveryCandidate> => {
        const wallet = leader.wallet.toLowerCase();
        const trades = weeklyTrades(await fetchUserTrades(wallet, 30), nowSec);
        const volume = weeklyVolume(trades);
        const copiedPnl = copiedPnlForWallet(wallet, copiedTrades);
        const score = leader.amount + volume * 0.01 + trades.length * 5 + copiedPnl * 2;
        return {
          wallet,
          name: leader.name || shortWallet(wallet),
          rank: leader.rank,
          weeklyPnlUsd: leader.amount,
          weeklyVolumeUsd: volume,
          weeklyTradeCount: trades.length,
          copiedTradeCount: copiedCountForWallet(wallet, copiedTrades),
          copiedSimPnlUsd: copiedPnl,
          lastTradeAt: latestTradeAtMs(trades),
          score,
        };
      }),
    );
    candidates.push(...results);
  }

  const activityWindowMs = settings.maxTraderInactivityHours * 60 * 60 * 1000;
  const ranked = candidates
    .flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
    .filter((candidate) => candidate.weeklyVolumeUsd >= settings.minTraderWeeklyVolumeUsd)
    .filter((candidate) => candidate.weeklyTradeCount >= settings.minTraderTradeCount)
    .filter((candidate) => candidate.lastTradeAt != null && now - candidate.lastTradeAt <= activityWindowMs)
    .sort((a, b) => b.score - a.score)
    .slice(0, settings.topTradersToFollow);

  const next = new Map<string, FollowedTrader>();

  for (const trader of existing) {
    if (trader.source === "manual") {
      const wallet = trader.wallet.toLowerCase();
      next.set(wallet, {
        ...trader,
        wallet,
        copiedTradeCount: copiedCountForWallet(wallet, copiedTrades),
        copiedSimPnlUsd: copiedPnlForWallet(wallet, copiedTrades),
      });
    }
  }

  for (const candidate of ranked) {
    const previous = existingByWallet.get(candidate.wallet);
    next.set(candidate.wallet, {
      wallet: candidate.wallet,
      name: candidate.name,
      enabled: previous?.enabled ?? true,
      source: previous?.source ?? "auto",
      rank: candidate.rank,
      weeklyPnlUsd: candidate.weeklyPnlUsd,
      weeklyVolumeUsd: candidate.weeklyVolumeUsd,
      weeklyTradeCount: candidate.weeklyTradeCount,
      copiedTradeCount: candidate.copiedTradeCount,
      copiedSimPnlUsd: candidate.copiedSimPnlUsd,
      lastTradeAt: candidate.lastTradeAt,
      addedAt: previous?.addedAt ?? now,
      updatedAt: now,
    });
  }

  return [...next.values()].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      (a.rank ?? 9999) - (b.rank ?? 9999) ||
      b.weeklyPnlUsd - a.weeklyPnlUsd,
  );
}