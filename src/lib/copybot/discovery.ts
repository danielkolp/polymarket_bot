import { fetchLeaders, type LeaderWindow } from "@/lib/polymarket/leaderboard";
import { fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { Leader, TraderTrade } from "@/lib/polymarket/types";
import type { BotSettings, CopyTradeRecord, DiscoverySource, FollowedTrader } from "./types";

/**
 * Trader discovery (Data API v2 leaderboards).
 *
 * Goal: follow wallets whose trades are actually worth copying with a small
 * account — consistently profitable, directional, human-paced traders — and
 * skip the wallets that top raw leaderboards but can't be copied profitably:
 *
 *  - market makers / arbitrage bots (huge volume, ~1-2% ROI, hundreds of
 *    trades a day: their edge is the spread and rebates, not direction);
 *  - whales whose own orders move the price before a copy can fill;
 *  - wallets that mostly trade long shots or near-certainties the bot's price
 *    band filters out anyway.
 *
 * Selection is deterministic (best score wins, with a little hysteresis so the
 * roster doesn't churn), unlike the previous rotating window which regularly
 * excluded the highest-ranked wallets.
 */

const WEEK_SEC = 7 * 24 * 60 * 60;
const BOARD_SIZE = 300;
/** Wallets that pass the leaderboard pre-filter and get a trade-history lookup. */
const MAX_TRADE_LOOKUPS = 110;
const RECENT_TRADES = 100;
const DISCOVERY_CONCURRENCY = 6;
/** Below this monthly ROI (P&L / volume) a wallet looks like a market maker. */
export const MIN_MONTHLY_ROI = 0.02;
/** Above this pace a wallet is a bot whose fills can't be copied in time. */
export const MAX_TRADES_PER_DAY = 150;
export const MIN_AVG_TRADE_USD = 20;
export const MAX_AVG_TRADE_USD = 5000;
/** Share of the wallet's BUYs that fall inside our price band. */
const MIN_COPYABLE_SHARE = 0.3;
/** Copy results only influence ranking after this many copied trades. */
const MIN_COPIES_FOR_FEEDBACK = 5;

const WEIGHTS = {
  monthRoi: 0.3,
  weekRoi: 0.2,
  monthPnl: 0.15,
  copyResults: 0.15,
  copyable: 0.1,
  recency: 0.1,
} as const;

interface BoardRow {
  weekPnl: number | null;
  weekVolume: number | null;
  monthPnl: number | null;
  monthVolume: number | null;
  rank: number;
  name: string;
}

export interface TraderProfile {
  tradesPerDay: number;
  avgTradeUsd: number;
  weeklyTradeCount: number;
  weeklyVolumeUsd: number;
  lastTradeAt: number | null;
  copyableShare: number;
}

interface Candidate extends BoardRow, TraderProfile {
  wallet: string;
  copiedTradeCount: number;
  copiedPnlUsd: number;
  score: number;
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

function isCopy(trade: CopyTradeRecord): boolean {
  return trade.status === "simulated" || trade.status === "copied";
}

export function copiedPnlForWallet(wallet: string, trades: CopyTradeRecord[]): number {
  return trades.filter((t) => t.traderWallet === wallet && isCopy(t)).reduce((sum, t) => sum + t.realizedPnlUsd, 0);
}

/** Copies of this wallet in either mode (previously only simulated copies counted). */
export function copiedCountForWallet(wallet: string, trades: CopyTradeRecord[]): number {
  return trades.filter((t) => t.traderWallet === wallet && isCopy(t)).length;
}

/** Rank-normalize to 0..1 (highest raw → 1); a single value maps to 0.5. */
function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n === 1) return [0.5];
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n).fill(0.5);
  for (let idx = 0; idx < order.length; idx += 1) out[order[idx].i] = idx / (n - 1);
  return out;
}

/** Behaviour profile from a wallet's recent trades (pure; exported for tests). */
export function profileTrades(trades: TraderTrade[], settings: BotSettings, nowMs: number): TraderProfile {
  const nowSec = Math.floor(nowMs / 1000);
  if (trades.length === 0) {
    return { tradesPerDay: 0, avgTradeUsd: 0, weeklyTradeCount: 0, weeklyVolumeUsd: 0, lastTradeAt: null, copyableShare: 0 };
  }
  let oldest = Number.MAX_SAFE_INTEGER;
  let newest = 0;
  let notional = 0;
  let weeklyCount = 0;
  let weeklyVolume = 0;
  let buys = 0;
  let copyableBuys = 0;
  for (const t of trades) {
    oldest = Math.min(oldest, t.timestamp);
    newest = Math.max(newest, t.timestamp);
    const usd = Math.max(0, t.price * t.size);
    notional += usd;
    if (nowSec - t.timestamp <= WEEK_SEC) {
      weeklyCount += 1;
      weeklyVolume += usd;
    }
    if (t.side === "BUY") {
      buys += 1;
      if (t.price >= settings.minBuyTokenPrice && t.price <= settings.maxBuyTokenPrice) copyableBuys += 1;
    }
  }
  // Pace over the window the sample covers (at least one hour so a burst of
  // fills doesn't divide by ~0). A full page spanning <1 day is >=100/day.
  const spanDays = Math.max(1 / 24, (nowSec - oldest) / 86_400);
  return {
    tradesPerDay: trades.length / spanDays,
    avgTradeUsd: notional / trades.length,
    weeklyTradeCount: weeklyCount,
    weeklyVolumeUsd: weeklyVolume,
    lastTradeAt: newest > 0 ? newest * 1000 : null,
    copyableShare: buys > 0 ? copyableBuys / buys : 0,
  };
}

/** Why a wallet is not copyable, or null when it passes (pure; exported for tests). */
export function exclusionReason(c: Pick<Candidate, "monthPnl" | "monthVolume" | "weekPnl"> & TraderProfile, settings: BotSettings, nowMs: number): string | null {
  if (!(c.monthPnl != null && c.monthPnl > 0)) return "not profitable over 30 days";
  if (c.weekPnl != null && c.weekPnl <= 0) return "losing this week";
  const roi = c.monthVolume && c.monthVolume > 0 ? (c.monthPnl ?? 0) / c.monthVolume : 0;
  if (roi < MIN_MONTHLY_ROI) return "looks like a market maker (very low return on volume)";
  if (c.tradesPerDay > MAX_TRADES_PER_DAY) return "trades too fast to copy (bot)";
  if (c.avgTradeUsd < MIN_AVG_TRADE_USD) return "trades too small";
  if (c.avgTradeUsd > MAX_AVG_TRADE_USD) return "whale-sized trades move the price";
  if (c.copyableShare < MIN_COPYABLE_SHARE) return "mostly trades prices outside the bot's range";
  const activityMs = settings.maxTraderInactivityHours * 3600 * 1000;
  if (c.lastTradeAt == null || nowMs - c.lastTradeAt > activityMs) return "inactive";
  if (c.weeklyVolumeUsd < settings.minTraderWeeklyVolumeUsd) return "too little volume this week";
  if (c.weeklyTradeCount < settings.minTraderTradeCount) return "too few trades this week";
  return null;
}

async function fetchBoard(window: LeaderWindow): Promise<Leader[]> {
  return fetchLeaders("profit", window, BOARD_SIZE);
}

/**
 * Rebuild the followed-trader roster.
 *
 * Throws when BOTH leaderboards are unreachable so the caller keeps the current
 * roster (an upstream outage must never wipe the followed wallets).
 *
 * `heldSourceWallets`: wallets whose copied positions the bot still holds. They
 * stay on the roster as exit-only even if they no longer rank, so their SELLs
 * are still seen and mirrored.
 */
export async function discoverTraders(
  settings: BotSettings,
  existing: FollowedTrader[],
  copiedTrades: CopyTradeRecord[],
  now = Date.now(),
  heldSourceWallets: Set<string> = new Set(),
): Promise<FollowedTrader[]> {
  const existingByWallet = new Map(existing.map((t) => [t.wallet.toLowerCase(), t]));

  const [weekRes, monthRes] = await Promise.allSettled([fetchBoard("7d"), fetchBoard("30d")]);
  if (weekRes.status === "rejected" && monthRes.status === "rejected") {
    throw new Error("Polymarket leaderboards are unreachable; keeping the current roster.");
  }
  const rows = new Map<string, BoardRow>();
  const upsert = (leader: Leader, kind: "week" | "month") => {
    const row = rows.get(leader.wallet) ?? {
      weekPnl: null, weekVolume: null, monthPnl: null, monthVolume: null, rank: 9999, name: leader.name,
    };
    if (kind === "week") {
      row.weekPnl = leader.pnlUsd ?? leader.amount;
      row.weekVolume = leader.volumeUsd ?? null;
    } else {
      row.monthPnl = leader.pnlUsd ?? leader.amount;
      row.monthVolume = leader.volumeUsd ?? null;
    }
    row.rank = Math.min(row.rank, leader.rank);
    rows.set(leader.wallet, row);
  };
  if (weekRes.status === "fulfilled") for (const l of weekRes.value) upsert(l, "week");
  if (monthRes.status === "fulfilled") for (const l of monthRes.value) upsert(l, "month");

  // Leaderboard-only pre-filter, then the most efficient wallets get a
  // trade-history lookup. Currently followed auto wallets are always re-checked.
  const roiOf = (r: BoardRow) => (r.monthVolume && r.monthVolume > 0 ? (r.monthPnl ?? 0) / r.monthVolume : 0);
  const pre = [...rows.entries()]
    .filter(([, r]) => (r.monthPnl ?? 0) > 0 && (r.weekPnl == null || r.weekPnl > 0) && roiOf(r) >= MIN_MONTHLY_ROI)
    .sort((a, b) => roiOf(b[1]) * Math.log10(10 + (b[1].monthPnl ?? 0)) - roiOf(a[1]) * Math.log10(10 + (a[1].monthPnl ?? 0)))
    .slice(0, MAX_TRADE_LOOKUPS)
    .map(([wallet]) => wallet);
  const lookups = new Set(pre);
  for (const t of existing) if (t.source !== "manual") lookups.add(t.wallet.toLowerCase());

  const wallets = [...lookups];
  const candidates: Candidate[] = [];
  for (let i = 0; i < wallets.length; i += DISCOVERY_CONCURRENCY) {
    const batch = wallets.slice(i, i + DISCOVERY_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (wallet): Promise<Candidate> => {
        const trades = await fetchUserTrades(wallet, RECENT_TRADES);
        const row = rows.get(wallet) ?? {
          weekPnl: existingByWallet.get(wallet)?.weeklyPnlUsd ?? null,
          weekVolume: null,
          monthPnl: existingByWallet.get(wallet)?.monthlyPnlUsd ?? null,
          monthVolume: null,
          rank: 9999,
          name: existingByWallet.get(wallet)?.name ?? shortWallet(wallet),
        };
        return {
          wallet,
          ...row,
          ...profileTrades(trades, settings, now),
          copiedTradeCount: copiedCountForWallet(wallet, copiedTrades),
          copiedPnlUsd: copiedPnlForWallet(wallet, copiedTrades),
          score: 0,
        };
      }),
    );
    for (const r of results) if (r.status === "fulfilled") candidates.push(r.value);
  }

  const eligible = candidates.filter((c) => exclusionReason(c, settings, now) == null);

  // Score: efficiency and consistency first, then the bot's own copy results
  // (shrunk toward neutral until there is enough history), copyability, recency.
  const monthRoi = percentileRanks(eligible.map((c) => roiOf(c)));
  const weekRoi = percentileRanks(eligible.map((c) => (c.weekVolume && c.weekVolume > 0 ? (c.weekPnl ?? 0) / c.weekVolume : roiOf(c))));
  const monthPnl = percentileRanks(eligible.map((c) => Math.log10(1 + Math.max(0, c.monthPnl ?? 0))));
  const copyable = percentileRanks(eligible.map((c) => c.copyableShare));
  const recency = percentileRanks(eligible.map((c) => c.lastTradeAt ?? 0));
  const withCopies = eligible.filter((c) => c.copiedTradeCount >= MIN_COPIES_FOR_FEEDBACK);
  const copyPct = new Map(withCopies.map((c, i) => [c.wallet, percentileRanks(withCopies.map((x) => x.copiedPnlUsd))[i]]));
  eligible.forEach((c, i) => {
    const raw = copyPct.get(c.wallet);
    const shrink = Math.min(1, c.copiedTradeCount / 20);
    const copyComponent = raw == null ? 0.5 : 0.5 + (raw - 0.5) * shrink;
    const blended =
      WEIGHTS.monthRoi * monthRoi[i] +
      WEIGHTS.weekRoi * weekRoi[i] +
      WEIGHTS.monthPnl * monthPnl[i] +
      WEIGHTS.copyResults * copyComponent +
      WEIGHTS.copyable * copyable[i] +
      WEIGHTS.recency * recency[i];
    c.score = Math.round(blended * 1000) / 10;
  });

  const target = Math.max(1, settings.topTradersToFollow);
  const ranked = [...eligible].sort((a, b) => b.score - a.score || a.rank - b.rank);
  // Hysteresis: a currently followed wallet keeps its slot while it stays in the
  // top 2N, so the roster (and leader-exit tracking) doesn't churn every pass.
  const selected = new Map<string, Candidate>();
  const followedAuto = new Set(existing.filter((t) => t.source !== "manual" && t.enabled && !t.exitOnly).map((t) => t.wallet.toLowerCase()));
  for (const c of ranked.slice(0, target * 2)) {
    if (selected.size >= target) break;
    if (followedAuto.has(c.wallet)) selected.set(c.wallet, c);
  }
  for (const c of ranked) {
    if (selected.size >= target) break;
    if (!selected.has(c.wallet)) selected.set(c.wallet, c);
  }

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

  const candidateByWallet = new Map(candidates.map((c) => [c.wallet, c]));
  const toTrader = (c: Candidate, exitOnly: boolean): FollowedTrader => {
    const previous = existingByWallet.get(c.wallet);
    const source: DiscoverySource = c.monthPnl != null && c.weekPnl != null ? "profit-7d" : "profit-30d";
    return {
      wallet: c.wallet,
      name: c.name || previous?.name || shortWallet(c.wallet),
      enabled: exitOnly ? true : previous?.enabled ?? true,
      source: previous?.source ?? "auto",
      rank: c.rank === 9999 ? null : c.rank,
      weeklyPnlUsd: c.weekPnl ?? 0,
      weeklyVolumeUsd: c.weeklyVolumeUsd,
      weeklyTradeCount: c.weeklyTradeCount,
      copiedTradeCount: c.copiedTradeCount,
      copiedSimPnlUsd: c.copiedPnlUsd,
      lastTradeAt: c.lastTradeAt,
      addedAt: previous?.addedAt ?? now,
      updatedAt: now,
      pinned: previous?.pinned,
      autoDisabled: previous?.autoDisabled,
      autoDisableReason: previous?.autoDisableReason,
      copyScore: previous?.copyScore,
      discoverySource: previous?.pinned ? "pinned" : source,
      discoveryScore: c.score,
      exitOnly,
      tradesPerDay: Math.round(c.tradesPerDay * 10) / 10,
      avgTradeUsd: Math.round(c.avgTradeUsd),
      monthlyPnlUsd: c.monthPnl ?? undefined,
      monthlyRoi: roiOf(c),
    };
  };
  for (const c of selected.values()) if (!next.has(c.wallet)) next.set(c.wallet, toTrader(c, false));

  // Keep wallets we still hold copied positions from, exit-only.
  for (const wallet of heldSourceWallets) {
    const w = wallet.toLowerCase();
    if (next.has(w)) continue;
    const c = candidateByWallet.get(w);
    const prev = existingByWallet.get(w);
    if (c) next.set(w, toTrader(c, true));
    else if (prev) next.set(w, { ...prev, enabled: true, exitOnly: true, updatedAt: now });
  }

  return [...next.values()].sort(
    (a, b) =>
      Number(Boolean(a.exitOnly)) - Number(Boolean(b.exitOnly)) ||
      Number(b.enabled) - Number(a.enabled) ||
      (b.discoveryScore ?? -1) - (a.discoveryScore ?? -1) ||
      (a.rank ?? 9999) - (b.rank ?? 9999),
  );
}
