import { fetchLeaders, type LeaderMetric, type LeaderWindow } from "@/lib/polymarket/leaderboard";
import { fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { Leader, TraderTrade } from "@/lib/polymarket/types";
import type { BotSettings, CopyTradeRecord, DiscoverySource, FollowedTrader } from "./types";

const WEEK_SEC = 7 * 24 * 60 * 60;
const MIN_POOL_CANDIDATES = 40;
const MAX_POOL_CANDIDATES = 120;
/** Hard cap on unique wallets we fetch trade history for per discovery pass. */
const MAX_TRADE_LOOKUPS = 150;
const DISCOVERY_CONCURRENCY = 8;
/** A candidate is "high-frequency" once its weekly trade count clears this bar. */
const HIGH_FREQUENCY_TRADE_COUNT = 20;

/** The rotating leaderboard pools Discovery v2 samples from each pass. */
const LEADERBOARD_POOLS: { source: DiscoverySource; metric: LeaderMetric; window: LeaderWindow }[] = [
  { source: "profit-1d", metric: "profit", window: "1d" },
  { source: "profit-7d", metric: "profit", window: "7d" },
  { source: "volume", metric: "volume", window: "7d" },
];

/**
 * Multi-factor ranking weights. They sum to 1; each factor is rank-normalized
 * 0..1. ROI efficiency (P&L / volume) is the dominant factor per spec — the
 * remaining factors only break ties between comparably-efficient traders.
 */
const RANK_WEIGHTS = {
  roiEfficiency: 0.6,
  copyResults: 0.15,
  recentActivity: 0.1,
  tradeFrequency: 0.05,
  volumeQuality: 0.1,
} as const;

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
  /** Pools this wallet appeared in (leaderboard pools + derived high-frequency). */
  pools: Set<DiscoverySource>;
  /** Best leaderboard rank seen across pools (lower is better). */
  bestRank: number;
  /** Composite 0..100 ranking score (filled in after normalization). */
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

function poolCandidateLimit(settings: BotSettings): number {
  return Math.min(MAX_POOL_CANDIDATES, Math.max(MIN_POOL_CANDIDATES, settings.topTradersToFollow * 3));
}

/**
 * Rank-normalize a list of raw factor values to 0..1 (highest raw → 1). Ties get
 * the same percentile; a single value maps to a neutral 0.5. Robust to outliers,
 * which matters because leaderboard PnL/volume are heavy-tailed.
 */
function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n).fill(0.5);
  for (let idx = 0; idx < order.length; idx += 1) {
    out[order[idx].i] = idx / (n - 1);
  }
  return out;
}

/**
 * A genuinely rotating window into a ranked pool: each discovery pass advances the
 * starting offset by `rotation`, so wallets just below the cut-off get cycled in
 * over time instead of the same head-of-list always winning. Wraps around.
 */
function rotatingSlice<T>(ranked: T[], quota: number, rotation: number): T[] {
  if (ranked.length === 0 || quota <= 0) return [];
  if (quota >= ranked.length) return ranked.slice();
  const start = ((rotation % ranked.length) + ranked.length) % ranked.length;
  const out: T[] = [];
  for (let i = 0; i < quota; i += 1) out.push(ranked[(start + i) % ranked.length]);
  return out;
}

/**
 * Discovery v2. Samples several rotating candidate pools (1d profit, 7d profit,
 * volume leaders, derived high-frequency/recently-active wallets, plus the
 * operator's manual/pinned wallets), ranks every candidate by a blended score
 * (ROI efficiency, recent activity, trade frequency, volume quality, and the
 * bot's own copy results), then fills the followed set with a rotating per-pool
 * quota so each pool stays represented and the roster refreshes over time.
 */
export async function discoverTraders(
  settings: BotSettings,
  existing: FollowedTrader[],
  copiedTrades: CopyTradeRecord[],
  now = Date.now(),
): Promise<FollowedTrader[]> {
  const nowSec = Math.floor(now / 1000);
  const existingByWallet = new Map(existing.map((trader) => [trader.wallet.toLowerCase(), trader]));
  const limit = poolCandidateLimit(settings);

  // 1) Pull the leaderboard pools concurrently and union their wallets, tracking
  //    which pool(s) surfaced each wallet and its best rank.
  const leaderboards = await Promise.allSettled(
    LEADERBOARD_POOLS.map((pool) => fetchLeaders(pool.metric, pool.window, limit)),
  );

  const poolOf = new Map<string, Set<DiscoverySource>>();
  const bestRankOf = new Map<string, number>();
  const leaderInfo = new Map<string, Leader>();
  // Profit board `amount` is P&L; volume board `amount` is volume. Track P&L
  // ONLY from profit boards so a volume-board-only wallet never has its volume
  // mistaken for profit (which would wreck its ROI-efficiency factor).
  const profitOf = new Map<string, number>();
  leaderboards.forEach((result, poolIdx) => {
    if (result.status !== "fulfilled") return;
    const { source, metric } = LEADERBOARD_POOLS[poolIdx];
    for (const leader of result.value) {
      const wallet = leader.wallet.toLowerCase();
      if (!wallet) continue;
      (poolOf.get(wallet) ?? poolOf.set(wallet, new Set()).get(wallet)!).add(source);
      bestRankOf.set(wallet, Math.min(bestRankOf.get(wallet) ?? Number.MAX_SAFE_INTEGER, leader.rank));
      if (!leaderInfo.has(wallet)) leaderInfo.set(wallet, { ...leader, wallet });
      // Prefer the first profit board seen (1d before 7d) for the P&L figure.
      if (metric === "profit" && !profitOf.has(wallet)) profitOf.set(wallet, leader.amount);
    }
  });

  // Always re-evaluate currently-followed auto wallets so an active wallet that
  // dropped off the leaderboard this pass isn't lost purely to leaderboard churn.
  for (const trader of existing) {
    if (trader.source !== "manual") {
      const wallet = trader.wallet.toLowerCase();
      if (!poolOf.has(wallet)) poolOf.set(wallet, new Set());
    }
  }

  const uniqueWallets = [...poolOf.keys()].slice(0, MAX_TRADE_LOOKUPS);

  // 2) Fetch recent trade history for every unique candidate (batched) and build
  //    the candidate records with their activity-derived factors.
  const candidates: DiscoveryCandidate[] = [];
  for (let i = 0; i < uniqueWallets.length; i += DISCOVERY_CONCURRENCY) {
    const batch = uniqueWallets.slice(i, i + DISCOVERY_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (wallet): Promise<DiscoveryCandidate> => {
        const trades = weeklyTrades(await fetchUserTrades(wallet, 40), nowSec);
        const volume = weeklyVolume(trades);
        const leader = leaderInfo.get(wallet);
        const prior = existingByWallet.get(wallet);
        const pools = new Set(poolOf.get(wallet) ?? []);
        const lastTradeAt = latestTradeAtMs(trades);

        // Derived high-frequency / recently-active pool membership.
        const activeWithinWindow =
          lastTradeAt != null && now - lastTradeAt <= settings.maxTraderInactivityHours * 60 * 60 * 1000;
        if (trades.length >= HIGH_FREQUENCY_TRADE_COUNT && activeWithinWindow) pools.add("high-frequency");

        return {
          wallet,
          name: leader?.name || prior?.name || shortWallet(wallet),
          rank: bestRankOf.get(wallet) ?? prior?.rank ?? 9999,
          // P&L strictly from a profit board (never a volume board's `amount`).
          weeklyPnlUsd: profitOf.get(wallet) ?? prior?.weeklyPnlUsd ?? 0,
          weeklyVolumeUsd: volume,
          weeklyTradeCount: trades.length,
          copiedTradeCount: copiedCountForWallet(wallet, copiedTrades),
          copiedSimPnlUsd: copiedPnlForWallet(wallet, copiedTrades),
          lastTradeAt,
          pools,
          bestRank: bestRankOf.get(wallet) ?? 9999,
          score: 0,
        };
      }),
    );
    for (const r of results) if (r.status === "fulfilled") candidates.push(r.value);
  }

  // 3) Apply the configured eligibility gates (these tighten/loosen with the risk
  //    preset — e.g. Action Mode lowers conviction thresholds for more candidates).
  const activityWindowMs = settings.maxTraderInactivityHours * 60 * 60 * 1000;
  const eligible = candidates.filter(
    (c) =>
      c.weeklyVolumeUsd >= settings.minTraderWeeklyVolumeUsd &&
      c.weeklyTradeCount >= settings.minTraderTradeCount &&
      c.lastTradeAt != null &&
      now - c.lastTradeAt <= activityWindowMs,
  );

  // 4) Multi-factor ranking. Each factor is rank-normalized across the eligible
  //    set so heavy-tailed leaderboard figures don't dominate the blend.
  const roiEfficiency = eligible.map((c) => (c.weeklyVolumeUsd > 0 ? c.weeklyPnlUsd / c.weeklyVolumeUsd : 0));
  const copyResults = eligible.map((c) => (c.copiedTradeCount > 0 ? c.copiedSimPnlUsd : 0));
  const recentActivity = eligible.map((c) => c.lastTradeAt ?? 0);
  const tradeFrequency = eligible.map((c) => c.weeklyTradeCount);
  // "Quality" volume: log-damped so a wash-trading whale can't buy its way to #1.
  const volumeQuality = eligible.map((c) => Math.log10(1 + Math.max(0, c.weeklyVolumeUsd)));

  const roiR = percentileRanks(roiEfficiency);
  const copyR = percentileRanks(copyResults);
  const recentR = percentileRanks(recentActivity);
  const freqR = percentileRanks(tradeFrequency);
  const volR = percentileRanks(volumeQuality);

  eligible.forEach((c, i) => {
    // Unproven wallets (no copy history yet) stay neutral on the copy-results axis
    // instead of being punished as if they were proven losers.
    const copyComponent = c.copiedTradeCount > 0 ? copyR[i] : 0.5;
    const blended =
      RANK_WEIGHTS.roiEfficiency * roiR[i] +
      RANK_WEIGHTS.copyResults * copyComponent +
      RANK_WEIGHTS.recentActivity * recentR[i] +
      RANK_WEIGHTS.tradeFrequency * freqR[i] +
      RANK_WEIGHTS.volumeQuality * volR[i];
    c.score = Math.round(blended * 1000) / 10; // 0..100, one decimal
  });

  // 5) Rotating per-pool selection. Give each pool an even share of the target
  //    roster, take a rotating window of its top-ranked eligible members, then
  //    backfill any shortfall from the global ranked list.
  const target = settings.topTradersToFollow;
  const rotation = Math.floor(now / Math.max(1, settings.traderRefreshIntervalMin * 60 * 1000));
  const allPools: DiscoverySource[] = ["profit-1d", "profit-7d", "volume", "high-frequency"];
  const quota = Math.max(1, Math.ceil(target / allPools.length));

  const byScore = (a: DiscoveryCandidate, b: DiscoveryCandidate) => b.score - a.score || a.bestRank - b.bestRank;
  const globalRanked = [...eligible].sort(byScore);

  const selected = new Map<string, DiscoveryCandidate>();
  // Primary pool tag per wallet: prefer high-frequency, else best leaderboard rank.
  const primarySource = (c: DiscoveryCandidate): DiscoverySource => {
    if (c.pools.has("high-frequency")) return "high-frequency";
    for (const p of allPools) if (c.pools.has(p)) return p;
    return "profit-7d";
  };

  for (const pool of allPools) {
    const members = globalRanked.filter((c) => c.pools.has(pool));
    for (const c of rotatingSlice(members, quota, rotation)) {
      if (selected.size >= target) break;
      if (!selected.has(c.wallet)) selected.set(c.wallet, c);
    }
  }
  // Backfill to the target from the global ranking if pools under-delivered.
  for (const c of globalRanked) {
    if (selected.size >= target) break;
    if (!selected.has(c.wallet)) selected.set(c.wallet, c);
  }

  // 6) Merge into FollowedTrader records: manual wallets are always retained;
  //    selected auto wallets carry their pool tag + composite score.
  const next = new Map<string, FollowedTrader>();

  for (const trader of existing) {
    if (trader.source === "manual") {
      const wallet = trader.wallet.toLowerCase();
      next.set(wallet, {
        ...trader,
        wallet,
        copiedTradeCount: copiedCountForWallet(wallet, copiedTrades),
        copiedSimPnlUsd: copiedPnlForWallet(wallet, copiedTrades),
        discoverySource: trader.pinned ? "pinned" : "manual",
      });
    }
  }

  for (const candidate of selected.values()) {
    const previous = existingByWallet.get(candidate.wallet);
    next.set(candidate.wallet, {
      wallet: candidate.wallet,
      name: candidate.name,
      enabled: previous?.enabled ?? true,
      source: previous?.source ?? "auto",
      rank: candidate.bestRank === 9999 ? null : candidate.bestRank,
      weeklyPnlUsd: candidate.weeklyPnlUsd,
      weeklyVolumeUsd: candidate.weeklyVolumeUsd,
      weeklyTradeCount: candidate.weeklyTradeCount,
      copiedTradeCount: candidate.copiedTradeCount,
      copiedSimPnlUsd: candidate.copiedSimPnlUsd,
      lastTradeAt: candidate.lastTradeAt,
      addedAt: previous?.addedAt ?? now,
      updatedAt: now,
      // Preserve operator/scoring state across discovery refreshes.
      pinned: previous?.pinned,
      autoDisabled: previous?.autoDisabled,
      autoDisableReason: previous?.autoDisableReason,
      copyScore: previous?.copyScore,
      discoverySource: previous?.pinned ? "pinned" : primarySource(candidate),
      discoveryScore: candidate.score,
    });
  }

  return [...next.values()].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      (b.discoveryScore ?? -1) - (a.discoveryScore ?? -1) ||
      (a.rank ?? 9999) - (b.rank ?? 9999) ||
      b.weeklyPnlUsd - a.weeklyPnlUsd,
  );
}
