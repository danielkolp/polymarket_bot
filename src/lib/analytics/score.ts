/**
 * Decision score: a normalized 0..100 quality estimate for a potential copy
 * trade, broken into eight stored components.
 *
 * IMPORTANT: This is analytics-only. NOTHING in the trading path reads this
 * score. It exists so that, after the fact, we can correlate score (and each
 * component) with realized outcomes and tune the real filters with evidence.
 */
import type { BotSettings } from "@/lib/copybot/types";
import type { DecisionScore, DecisionScoreComponents } from "./types";

const WEIGHTS: DecisionScoreComponents = {
  traderQuality: 25,
  liquidity: 15,
  spread: 15,
  freshness: 10,
  slippage: 10,
  priceQuality: 10,
  marketQuality: 10,
  correlation: 5,
};

function clamp100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

export interface ScoreInputs {
  settings: BotSettings;
  /** Composite copy score (0..100) for the trader, when known. */
  traderCopyScore: number | null;
  traderWeeklyPnlUsd: number | null;
  liquidityUsd: number | null;
  /** Fractional spread (0..1). */
  spread: number | null;
  tradeAgeSec: number | null;
  /** Slippage in cents (ourFill - leaderFill); null when unknown. */
  slippageCents: number | null;
  /** Copied outcome price (0..1). */
  price: number | null;
  volumeUsd: number | null;
  timeToResolutionMs: number | null;
  /** Open exposure (USD) already in this exact market before the trade. */
  marketExposureBeforeUsd: number | null;
  /** Total equity (USD), used to scale correlation exposure. */
  equityUsd: number | null;
}

function scoreTraderQuality(i: ScoreInputs): number {
  if (i.traderCopyScore != null) return clamp100(i.traderCopyScore);
  // Fallback: map weekly P&L through a soft curve when no copy score exists yet.
  const pnl = i.traderWeeklyPnlUsd ?? 0;
  if (pnl <= 0) return 35;
  return clamp100(50 + 25 * Math.tanh(pnl / 5000));
}

function scoreLiquidity(i: ScoreInputs): number {
  const liq = i.liquidityUsd ?? 0;
  if (liq <= 0) return 0;
  // 100 at >= $100k, ~0 near $100. Log-scaled.
  const score = ((Math.log10(liq) - 2) / 3) * 100;
  return clamp100(score);
}

function scoreSpread(i: ScoreInputs): number {
  if (i.spread == null) return 50; // unknown — neutral
  const cents = i.spread * 100;
  // 100 at 0c, 0 at >= 10c.
  return clamp100(100 - cents * 10);
}

function scoreFreshness(i: ScoreInputs): number {
  if (i.tradeAgeSec == null) return 50;
  const max = Math.max(1, i.settings.maxTradeAgeSec);
  return clamp100((1 - i.tradeAgeSec / max) * 100);
}

function scoreSlippage(i: ScoreInputs): number {
  if (i.slippageCents == null) return 60; // unknown — slightly optimistic
  // Favorable (negative) slippage is great; 0 = 100, +5c = 0.
  return clamp100(100 - Math.max(0, i.slippageCents) * 20);
}

function scorePriceQuality(i: ScoreInputs): number {
  if (i.price == null) return 50;
  const c = i.price * 100;
  // Penalize asymmetric-risk extremes; reward the informative mid-range.
  // Peak around 45-55c, taper toward the wings, hard penalty above ~88c.
  let s = 100 - Math.abs(c - 50) * 1.4;
  if (c > 85) s -= (c - 85) * 5;
  return clamp100(s);
}

function scoreMarketQuality(i: ScoreInputs): number {
  // Composite of volume depth + comfortable time-to-resolution.
  const vol = i.volumeUsd ?? 0;
  const volScore = vol > 0 ? clamp100(((Math.log10(vol) - 3) / 3) * 100) : 20;
  let ttrScore = 50;
  if (i.timeToResolutionMs != null) {
    const hours = i.timeToResolutionMs / 3_600_000;
    // Too soon (<2h) is risky; plenty of runway (>48h) is comfortable.
    ttrScore = clamp100((Math.min(hours, 48) / 48) * 100);
  }
  return clamp100(volScore * 0.6 + ttrScore * 0.4);
}

function scoreCorrelation(i: ScoreInputs): number {
  // Higher score = less correlated (little/no existing exposure in this market).
  const equity = i.equityUsd ?? 0;
  const exposure = i.marketExposureBeforeUsd ?? 0;
  if (equity <= 0) return 70;
  const frac = exposure / equity;
  return clamp100(100 - frac * 400); // 25% of equity already in this market -> 0
}

/** Compute the full decision score and its components. Pure, analytics-only. */
export function computeDecisionScore(inputs: ScoreInputs): DecisionScore {
  const components: DecisionScoreComponents = {
    traderQuality: scoreTraderQuality(inputs),
    liquidity: scoreLiquidity(inputs),
    spread: scoreSpread(inputs),
    freshness: scoreFreshness(inputs),
    slippage: scoreSlippage(inputs),
    priceQuality: scorePriceQuality(inputs),
    marketQuality: scoreMarketQuality(inputs),
    correlation: scoreCorrelation(inputs),
  };

  const weightSum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const weighted = (Object.keys(components) as Array<keyof DecisionScoreComponents>).reduce(
    (sum, key) => sum + components[key] * WEIGHTS[key],
    0,
  );

  return {
    total: clamp100(weighted / weightSum),
    components,
    weights: { ...WEIGHTS },
  };
}
