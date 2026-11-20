/**
 * Discovery v3 — find wallets whose trades are actually worth copying.
 *
 * Why not just copy the top of the leaderboard? Checked against live data, the
 * weekly top 3 were (1) a 3-month-old wallet with one huge marked-to-market week
 * and only $16k realized all-time, (2) an automated bot with 126k markets traded,
 * and (3) a professional market maker earning ~$2.6M in rebates/rewards. None of
 * those edges survive being copied 30s later with taker orders. So discovery:
 *
 *  1. samples the 7-day AND 30-day P&L boards (the 1-day board is mostly noise;
 *     the volume board is mostly market makers);
 *  2. measures P&L efficiency (P&L ÷ volume) within ONE window — the old code
 *     divided one window's P&L by a different window's partial volume;
 *  3. rejects market makers / liquidity farmers (rebates + rewards are a big
 *     share of income), HFT bots (hundreds of trades a day), lifetime losers
 *     who had one lucky week, and wallets trading mostly 5-15 minute crypto
 *     "up or down" markets (impossible to copy with polling latency);
 *  4. scores "copyability": the share of the wallet's BUYs that fall inside the
 *     bot's own entry price band — a wallet whose trades we'd always skip just
 *     wastes a roster slot;
 *  5. blends in the bot's OWN net-of-cost copy results per wallet;
 *  6. keeps the roster stable (incumbents get a small bonus) instead of
 *     rotating wallets out before their copy results mean anything;
 *  7. never wipes the roster when Polymarket's APIs fail.
 */
import { fetchUserStats, type UserStats } from "@/lib/polymarket/dataApi";
import { fetchLeaders } from "@/lib/polymarket/leaderboard";
import { fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { Leader, TraderTrade } from "@/lib/polymarket/types";
import { computeCopyScore } from "./copyScore";
import type { BotSettings, CopyTradeRecord, DiscoverySource, FollowedTrader } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_SEC = 7 * 24 * 60 * 60;
/** Leaderboard rows pulled per pool. v2 serves up to 1000 per request. */
const POOL_SIZE = 200;
/** Hard cap on wallets we fetch trade history for per pass. */
const MAX_TRADE_LOOKUPS = 160;
/** Hard cap on wallets we fetch user-stats for per pass (after cheap filters). */
const MAX_STATS_LOOKUPS = 80;
const DISCOVERY_CONCURRENCY = 8;
const TRADE_SAMPLE = 100;

/**
 * Maker/taker rebates + liquidity rewards above this share of realized trading
 * P&L = the wallet's edge is fee income a copier never receives.
 */
export const MAX_REBATE_INCOME_SHARE = 0.3;
/**
 * Lifetime realized P&L must be at least this share of the 30d board P&L. Board
 * P&L is marked-to-market, so a "great month" that is mostly open marks on a
 * wallet with little realized history is one big unrealized bet, not an edge.
 */
export const MIN_REALIZED_TO_MONTH_PNL = 0.2;
/** More distinct markets per day of account age than this = automated bot. */
export const MAX_MARKETS_PER_DAY = 150;
/** A 100-trade sample spanning less than this = HFT bot. */
export const MIN_SAMPLE_SPAN_MS = 12 * 60 * 60 * 1000;
/** Share of recent trades in ultra-short "up or down" markets above which we skip. */
export const MAX_FAST_MARKET_SHARE = 0.5;
/** Minimum share of BUYs inside our entry price band to be worth following. */
export const MIN_COPYABLE_SHARE = 0.25;
/** Score bonus that keeps incumbent wallets from churning out on noise. */
const INCUMBENT_BONUS = 5;

const RANK_WEIGHTS = {
  efficiency: 0.3,
  copyResults: 0.25,
  consistency: 0.15,
  copyability: 0.15,
  lifetime: 0.1,
  recency: 0.05,
} as const;

const FAST_MARKET_RE = /(updown|up-or-down|up or down)/i;

export interface CandidateProfile {
  wallet: string;
  name: string;
  week: Leader | null;
  month: Leader | null;
  trades: TraderTrade[] | null;
  stats: UserStats | null;
}

export interface CandidateMetrics {
  weeklyPnlUsd: number;
  weeklyVolumeUsd: number;
  weeklyTradeCount: number;
  lastTradeAt: number | null;
  /** P&L ÷ volume within a single leaderboard window. */
  efficiency: number;
  /** 1 = profitable on both 7d and 30d boards; 0.5 = only one known & positive. */
  consistency: number;
  /** Share of recent BUYs inside the bot's entry price band. */
  copyableShare: number;
  fastMarketShare: number;
  sampleSpanMs: number | null;
  bestRank: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function candidateMetrics(
  profile: CandidateProfile,
  settings: Pick<BotSettings, "minBuyTokenPrice" | "maxBuyTokenPrice">,
  now: number,
): CandidateMetrics {
  const nowSec = Math.floor(now / 1000);
  const trades = profile.trades ?? [];
  const weekly = trades.filter((t) => nowSec - t.timestamp <= WEEK_SEC);
  const buys = trades.filter((t) => t.side === "BUY" && t.price > 0 && t.price < 1);
  const inBand = buys.filter((t) => t.price >= settings.minBuyTokenPrice && t.price <= settings.maxBuyTokenPrice);
  const fast = trades.filter((t) => FAST_MARKET_RE.test(t.slug ?? "") || FAST_MARKET_RE.test(t.title));
  let latest = 0;
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const t of trades) {
    if (t.timestamp > latest) latest = t.timestamp;
    if (t.timestamp < earliest) earliest = t.timestamp;
  }

  const window = profile.month ?? profile.week;
  const efficiency = window && (window.volume ?? 0) > 0 ? (window.pnlUsd ?? 0) / (window.volume ?? 1) : 0;
  const weekPos = profile.week ? (profile.week.pnlUsd ?? 0) > 0 : null;
  const monthPos = profile.month ? (profile.month.pnlUsd ?? 0) > 0 : null;
  const consistency = weekPos && monthPos ? 1 : weekPos || monthPos ? 0.5 : 0;

  return {
    weeklyPnlUsd: profile.week?.pnlUsd ?? 0,
    weeklyVolumeUsd: weekly.reduce((sum, t) => sum + Math.max(0, t.price * t.size), 0),
    weeklyTradeCount: weekly.length,
    lastTradeAt: latest > 0 ? latest * 1000 : null,
    efficiency: Number.isFinite(efficiency) ? efficiency : 0,
    consistency,
    copyableShare: buys.length > 0 ? inBand.length / buys.length : 0,
    fastMarketShare: trades.length > 0 ? fast.length / trades.length : 0,
    sampleSpanMs: trades.length >= TRADE_SAMPLE && latest > 0 ? (latest - earliest) * 1000 : null,
    bestRank: Math.min(profile.week?.rank ?? 9999, profile.month?.rank ?? 9999),
  };
}

/**
 * Cheap gates that only need leaderboard rows + trade history. Returns a reason
 * string when the wallet should NOT be followed, else null.
 */
export function cheapRejectReason(
  profile: CandidateProfile,
  m: CandidateMetrics,
  settings: Pick<BotSettings, "minTraderWeeklyVolumeUsd" | "minTraderTradeCount" | "maxTraderInactivityHours">,
  now: number,
): string | null {
  if (profile.week && (profile.week.pnlUsd ?? 0) <= 0) return "negative 7d P&L";
  if (profile.month && (profile.month.pnlUsd ?? 0) <= 0) return "negative 30d P&L";
  if (!profile.trades) return "trade history unavailable";
  if (m.lastTradeAt == null || now - m.lastTradeAt > settings.maxTraderInactivityHours * 60 * 60 * 1000) return "inactive";
  if (m.weeklyVolumeUsd < settings.minTraderWeeklyVolumeUsd) return "weekly volume too low";
  if (m.weeklyTradeCount < settings.minTraderTradeCount) return "too few trades";
  if (m.sampleSpanMs != null && m.sampleSpanMs < MIN_SAMPLE_SPAN_MS) return "HFT bot (100 trades in <12h)";
  if (m.fastMarketShare > MAX_FAST_MARKET_SHARE) return "trades mostly 5-15 min crypto markets";
  if (m.copyableShare < MIN_COPYABLE_SHARE) return "most BUYs outside our entry price band";
  return null;
}

/** Gates that need /user-stats. Returns a reason string, or null to keep. */
export function statsRejectReason(stats: UserStats | null, now: number, monthPnlUsd: number | null = null): string | null {
  if (!stats) return null; // unknown: don't punish an API blip
  const realized = stats.realizedPnlUsd;
  if (realized <= 0) return "lifetime realized P&L is not positive";
  const feeIncome =
    Math.max(0, stats.makerRebateUsd) + Math.max(0, stats.takerRebateUsd) + Math.max(0, stats.rewardIncomeUsd);
  if (feeIncome / Math.max(1, realized) > MAX_REBATE_INCOME_SHARE) return "market maker (income mostly rebates/rewards)";
  if (monthPnlUsd != null && monthPnlUsd > 0 && realized < monthPnlUsd * MIN_REALIZED_TO_MONTH_PNL) {
    return "P&L mostly unrealized marks (little realized history)";
  }
  if (stats.joinDate) {
    const ageDays = Math.max(1, (now - stats.joinDate * 1000) / DAY_MS);
    if (stats.trades / ageDays > MAX_MARKETS_PER_DAY) return "automated bot (too many markets per day)";
  }
  return null;
}

/**
 * Rank-normalize to 0..1 (highest raw → 1). Robust to the heavy tails of
 * leaderboard P&L/volume. A single value maps to a neutral 0.5.
 */
function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n).fill(0.5);
  for (let idx = 0; idx < order.length; idx += 1) out[order[idx].i] = idx / (n - 1);
  return out;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.allSettled(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

export interface DiscoveryReport {
  candidates: number;
  eligible: number;
  rejected: Record<string, number>;
  /** True when upstream failures meant we kept the previous roster. */
  keptPrevious: boolean;
}

export async function discoverTraders(
  settings: BotSettings,
  existing: FollowedTrader[],
  copiedTrades: CopyTradeRecord[],
  now = Date.now(),
  report?: DiscoveryReport,
): Promise<FollowedTrader[]> {
  const rep: DiscoveryReport = report ?? { candidates: 0, eligible: 0, rejected: {}, keptPrevious: false };
  const reject = (reason: string) => {
    rep.rejected[reason] = (rep.rejected[reason] ?? 0) + 1;
  };
  const existingByWallet = new Map(existing.map((t) => [t.wallet.toLowerCase(), t]));

  // 1) Leaderboard pools (7d + 30d P&L).
  const [weekRes, monthRes] = await Promise.allSettled([
    fetchLeaders("profit", "7d", POOL_SIZE),
    fetchLeaders("profit", "30d", POOL_SIZE),
  ]);
  if (weekRes.status === "rejected" && monthRes.status === "rejected") {
    // Polymarket unavailable: keep the current roster untouched.
    rep.keptPrevious = true;
    const reason = weekRes.reason instanceof Error ? weekRes.reason.message : String(weekRes.reason);
    throw new Error(`Leaderboards unavailable; keeping current roster (${reason})`);
  }
  const weekBy = new Map((weekRes.status === "fulfilled" ? weekRes.value : []).map((l) => [l.wallet, l]));
  const monthBy = new Map((monthRes.status === "fulfilled" ? monthRes.value : []).map((l) => [l.wallet, l]));

  const wallets = new Set<string>([...weekBy.keys(), ...monthBy.keys()]);
  // Always re-evaluate incumbent auto wallets, even if they slipped off a board.
  for (const t of existing) if (t.source !== "manual") wallets.add(t.wallet.toLowerCase());
  // Prefer wallets present on both boards, then by best rank, for the lookup cap.
  const ordered = [...wallets]
    .map((w) => ({
      w,
      both: weekBy.has(w) && monthBy.has(w) ? 0 : 1,
      incumbent: existingByWallet.has(w) ? 0 : 1,
      rank: Math.min(weekBy.get(w)?.rank ?? 9999, monthBy.get(w)?.rank ?? 9999),
    }))
    .sort((a, b) => a.incumbent - b.incumbent || a.both - b.both || a.rank - b.rank)
    .slice(0, MAX_TRADE_LOOKUPS)
    .map((x) => x.w);

  // 2) Trade history (cheap filters).
  const tradeResults = await mapLimited(ordered, DISCOVERY_CONCURRENCY, (w) => fetchUserTrades(w, TRADE_SAMPLE));
  const profiles: CandidateProfile[] = ordered.map((wallet, i) => {
    const r = tradeResults[i];
    const week = weekBy.get(wallet) ?? null;
    const month = monthBy.get(wallet) ?? null;
    const trades = r.status === "fulfilled" ? r.value : null;
    return {
      wallet,
      name: week?.name || month?.name || trades?.[0]?.traderName || existingByWallet.get(wallet)?.name || shortWallet(wallet),
      week,
      month,
      trades,
      stats: null,
    };
  });
  rep.candidates = profiles.length;
  const lookupFailures = profiles.filter((p) => p.trades == null).length;

  const passedCheap: { profile: CandidateProfile; m: CandidateMetrics }[] = [];
  for (const profile of profiles) {
    const m = candidateMetrics(profile, settings, now);
    const why = cheapRejectReason(profile, m, settings, now);
    if (why) reject(why);
    else passedCheap.push({ profile, m });
  }

  // 3) Market-maker / bot filter via /user-stats (bounded).
  passedCheap.sort((a, b) => b.m.consistency - a.m.consistency || b.m.efficiency - a.m.efficiency);
  const statsTargets = passedCheap.slice(0, MAX_STATS_LOOKUPS);
  const statsResults = await mapLimited(statsTargets, DISCOVERY_CONCURRENCY, (c) => fetchUserStats(c.profile.wallet));
  const eligible: { profile: CandidateProfile; m: CandidateMetrics }[] = [];
  statsTargets.forEach((c, i) => {
    const r = statsResults[i];
    c.profile.stats = r.status === "fulfilled" ? r.value : null;
    const why = statsRejectReason(c.profile.stats, now, c.profile.month?.pnlUsd ?? null);
    if (why) reject(why);
    else eligible.push(c);
  });
  rep.eligible = eligible.length;

  // 4) Rank.
  const copyRoi = eligible.map((c) => {
    const score = computeCopyScore(c.profile.wallet, copiedTrades, []);
    return score.copiedBuys > 0 ? score.copyRoi : null;
  });
  const effR = percentileRanks(eligible.map((c) => c.m.efficiency));
  const copyR = percentileRanks(copyRoi.map((v) => v ?? 0));
  const lifeR = percentileRanks(eligible.map((c) => Math.log10(1 + Math.max(0, c.profile.stats?.realizedPnlUsd ?? 0))));
  const recentR = percentileRanks(eligible.map((c) => c.m.lastTradeAt ?? 0));
  const scored = eligible.map((c, i) => {
    const blended =
      RANK_WEIGHTS.efficiency * effR[i] +
      RANK_WEIGHTS.copyResults * (copyRoi[i] == null ? 0.5 : copyR[i]) + // unproven = neutral
      RANK_WEIGHTS.consistency * c.m.consistency +
      RANK_WEIGHTS.copyability * c.m.copyableShare +
      RANK_WEIGHTS.lifetime * (c.profile.stats ? lifeR[i] : 0.5) +
      RANK_WEIGHTS.recency * recentR[i];
    const prior = existingByWallet.get(c.profile.wallet);
    const incumbentBonus = prior && prior.source !== "manual" && (copyRoi[i] ?? 0) >= 0 ? INCUMBENT_BONUS : 0;
    return { ...c, score: Math.round(blended * 1000) / 10, rankScore: blended * 100 + incumbentBonus };
  });
  scored.sort((a, b) => b.rankScore - a.rankScore || a.m.bestRank - b.m.bestRank);
  const selected = scored.slice(0, settings.topTradersToFollow);

  // 5) Merge. Manual wallets always stay. If upstream failures left us with too
  //    few eligible wallets, carry incumbents whose lookups failed rather than
  //    dropping them on an API blip.
  const next = new Map<string, FollowedTrader>();
  for (const trader of existing) {
    if (trader.source !== "manual") continue;
    const wallet = trader.wallet.toLowerCase();
    const cs = computeCopyScore(wallet, copiedTrades, []);
    next.set(wallet, {
      ...trader,
      wallet,
      copiedTradeCount: cs.copiedBuys,
      copiedSimPnlUsd: cs.realizedPnlUsd,
      discoverySource: trader.pinned ? "pinned" : "manual",
    });
  }

  for (const c of selected) {
    const previous = existingByWallet.get(c.profile.wallet);
    const cs = computeCopyScore(c.profile.wallet, copiedTrades, []);
    next.set(c.profile.wallet, {
      wallet: c.profile.wallet,
      name: c.profile.name,
      enabled: previous?.enabled ?? true,
      source: previous?.source ?? "auto",
      rank: c.m.bestRank === 9999 ? null : c.m.bestRank,
      weeklyPnlUsd: c.m.weeklyPnlUsd,
      weeklyVolumeUsd: c.m.weeklyVolumeUsd,
      weeklyTradeCount: c.m.weeklyTradeCount,
      copiedTradeCount: cs.copiedBuys,
      copiedSimPnlUsd: cs.realizedPnlUsd,
      lastTradeAt: c.m.lastTradeAt,
      addedAt: previous?.addedAt ?? now,
      updatedAt: now,
      pinned: previous?.pinned,
      autoDisabled: previous?.autoDisabled,
      autoDisableReason: previous?.autoDisableReason,
      copyScore: previous?.copyScore,
      discoverySource: previous?.pinned ? "pinned" : c.profile.month ? "profit-30d" : "profit-7d",
      discoveryScore: c.score,
    });
  }

  // Only an upstream outage justifies keeping wallets we couldn't evaluate; a
  // wallet that was evaluated and failed the filters is dropped on purpose.
  const upstreamDegraded = lookupFailures > profiles.length / 2;
  if (upstreamDegraded) {
    for (const trader of existing) {
      const wallet = trader.wallet.toLowerCase();
      if (trader.source === "manual" || next.has(wallet)) continue;
      const failed = profiles.find((p) => p.wallet === wallet)?.trades == null;
      if (failed || selected.length === 0) {
        next.set(wallet, trader);
        rep.keptPrevious = true;
      }
    }
  }

  return [...next.values()].sort(
    (a, b) =>
      Number(b.enabled) - Number(a.enabled) ||
      (b.discoveryScore ?? -1) - (a.discoveryScore ?? -1) ||
      (a.rank ?? 9999) - (b.rank ?? 9999),
  );
}
