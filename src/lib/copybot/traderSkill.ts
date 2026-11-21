/**
 * Trader skill: how the price moves in the 6 hours after a trader buys.
 *
 * Why this and not profit: whether one bet wins is mostly luck, so a trader's
 * recent profit (what leaderboards rank by) barely predicts their next weeks.
 * A walk-forward test on ~700 active Polymarket wallets (Nov 2026) found the
 * bot's old leaderboard-based picks did no better than average traders, and
 * copying average traders loses ~2.6% per dollar after fees and spread.
 *
 * The price move a few hours after each buy is a far less noisy read of
 * whether a trader knows something: informed buyers are followed by the
 * market. Ranking ~200 wallets by their 6-hour move on older buys, the top
 * fifth kept a positive move on later buys (+2.9c) and copying them returned
 * +6.3% per dollar held to resolution, versus -6.2% for the bottom third.
 * (5-minute and 1-hour moves did not persist.) The edge is not yet
 * statistically proven, so it is validated in paper trading before real money.
 *
 * Pure helpers + one async measurer that takes its price fetcher and cache
 * as arguments (testable, no I/O of its own).
 */
import type { TraderTrade } from "@/lib/polymarket/types";

export const SKILL_LAG_SEC = 6 * 3600;
/** Newest buys measured per trader. */
export const SKILL_MAX_SAMPLES = 30;
/** Fewer measured buys than this and the trader is not ranked on skill. */
export const SKILL_MIN_SAMPLES = 8;
const SKILL_MAX_AGE_SEC = 30 * 86_400;
/** Assumed copy slippage over the trader's fill (real-time chain feed). */
const ENTRY_SLIP = 0.005;
/** Shrinks small samples toward zero: score = mean * n / (n + SHRINK_N). */
const SHRINK_N = 10;
const MIN_BUY_USD = 2;

export interface PricePoint {
  t: number;
  p: number;
}

export type PriceWindowFetcher = (tokenId: string, startTs: number, endTs: number) => Promise<PricePoint[] | null>;

export interface SkillSample {
  t: number;
  /** Price move at +6h relative to a copy entry (price units, 0.01 = 1c); null = no price data. */
  m6: number | null;
}

export type SkillCache = Record<string, { samples: Record<string, SkillSample>; updatedAt: number }>;

export interface TraderSkill {
  /** Buys with a measured 6-hour move. */
  n: number;
  /** Mean 6-hour move (price units). */
  mean: number;
  /** Ranking score: mean shrunk toward 0 for small samples. */
  score: number;
}

/** Last price at or before `t` (history sorted by time); null if none. */
export function priceAt(history: PricePoint[], t: number): number | null {
  let best: number | null = null;
  for (const point of history) {
    if (point.t <= t) best = point.p;
    else break;
  }
  return best;
}

function sampleKey(trade: TraderTrade): string {
  return `${trade.tokenId}|${Math.floor(trade.timestamp / 600)}`;
}

/** BUYs in the copyable price band, old enough to have a 6-hour move, newest first, one per token per 10 min. */
export function selectSkillBuys(
  trades: TraderTrade[],
  band: { min: number; max: number },
  nowSec: number,
  limit = SKILL_MAX_SAMPLES,
): TraderTrade[] {
  const out: TraderTrade[] = [];
  const seen = new Set<string>();
  for (const t of [...trades].sort((a, b) => b.timestamp - a.timestamp)) {
    if (t.side !== "BUY") continue;
    if (t.price < band.min || t.price > band.max) continue;
    if (t.price * t.size < MIN_BUY_USD) continue;
    const age = nowSec - t.timestamp;
    if (age < SKILL_LAG_SEC + 600 || age > SKILL_MAX_AGE_SEC) continue;
    const key = sampleKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

export function skillScore(moves: number[]): TraderSkill {
  const n = moves.length;
  if (n === 0) return { n: 0, mean: 0, score: 0 };
  const mean = moves.reduce((s, m) => s + m, 0) / n;
  return { n, mean, score: (mean * n) / (n + SHRINK_N) };
}

/**
 * Measure one trader. Uses cached samples where present and fetches price
 * history only for new buys; mutates `cache` (caller persists it).
 */
export async function measureSkill(
  wallet: string,
  trades: TraderTrade[],
  band: { min: number; max: number },
  cache: SkillCache,
  fetchWindow: PriceWindowFetcher,
  nowSec: number,
): Promise<TraderSkill> {
  const key = wallet.toLowerCase();
  const entry = cache[key] ?? { samples: {}, updatedAt: 0 };
  const moves: number[] = [];
  for (const buy of selectSkillBuys(trades, band, nowSec)) {
    const k = sampleKey(buy);
    let sample = entry.samples[k];
    if (!sample) {
      const history = await fetchWindow(buy.tokenId, buy.timestamp - 120, buy.timestamp + SKILL_LAG_SEC + 900);
      if (history == null) continue; // fetch failed: try again next refresh, don't cache
      const p = priceAt(history, buy.timestamp + SKILL_LAG_SEC);
      sample = { t: buy.timestamp, m6: p == null ? null : p - Math.min(0.999, buy.price + ENTRY_SLIP) };
      entry.samples[k] = sample;
    }
    if (sample.m6 != null) moves.push(sample.m6);
  }
  // Drop samples too old to matter so the cache stays small.
  for (const [k, s] of Object.entries(entry.samples)) {
    if (nowSec - s.t > SKILL_MAX_AGE_SEC) delete entry.samples[k];
  }
  entry.updatedAt = nowSec;
  cache[key] = entry;
  return skillScore(moves);
}

/** Forget traders not measured for two weeks. */
export function pruneSkillCache(cache: SkillCache, nowSec: number): SkillCache {
  for (const [wallet, entry] of Object.entries(cache)) {
    if (nowSec - entry.updatedAt > 14 * 86_400) delete cache[wallet];
  }
  return cache;
}
