/**
 * Pure analysis engine for portfolio recovery. No I/O, no side effects — every
 * function here is deterministic given its inputs, so the same logic can back
 * the simulated manager today and a future live manager later.
 *
 * It classifies existing positions, recommends (never executes) an action, and
 * raises safety flags. It never fabricates a cost basis and never assumes a
 * position is safe to exit.
 */
import type { PricePoint } from "@/lib/polymarket/positions";
import type {
  CostBasisSource,
  MarketStatus,
  PositionClassification,
  PriceHistoryStats,
  RecommendedAction,
  RecoveryThresholds,
  RiskFlag,
} from "./types";

/** The subset of a position the pure engine needs to reason about it. */
export interface PositionSignalInput {
  shares: number;
  costBasisSource: CostBasisSource;
  avgEntryPrice: number | null;
  midPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  liquidityUsd: number;
  estimatedValueUsd: number | null;
  unrealizedPnlPct: number | null;
  timeToResolutionMs: number | null;
  marketStatus: MarketStatus;
  redeemable: boolean;
  fromBotSession: boolean;
}

export interface PositionSignals {
  classification: PositionClassification;
  recommendedAction: RecommendedAction;
  actionRationale: string;
  riskFlags: RiskFlag[];
}

function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function humanizeMs(ms: number): string {
  if (ms <= 0) return "now";
  const h = ms / 3_600_000;
  if (h < 48) return `${Math.max(1, Math.round(h))}h`;
  return `${Math.round(h / 24)}d`;
}

function downsample(values: number[], maxPoints: number): number[] {
  if (values.length <= maxPoints) return values;
  const step = (values.length - 1) / (maxPoints - 1);
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(values[Math.round(i * step)]);
  return out;
}

/** Derive trend stats from a token's price history. Returns null if empty. */
export function summarizePriceHistory(
  points: PricePoint[],
  interval: string,
  maxSeries = 48,
): PriceHistoryStats | null {
  const prices = (points ?? []).map((pt) => pt.p).filter((p) => Number.isFinite(p));
  if (prices.length === 0) return null;

  const first = prices[0];
  const last = prices[prices.length - 1];
  const high = Math.max(...prices);
  const low = Math.min(...prices);
  const changeAbs = last - first;
  const changePct = first > 0 ? (changeAbs / first) * 100 : null;

  let volatility: number | null = null;
  if (prices.length >= 3) {
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) returns.push(prices[i] / prices[i - 1] - 1);
    }
    if (returns.length > 1) {
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
      volatility = Math.sqrt(variance);
    }
  }

  const k = Math.min(10, prices.length);
  const recent = prices.slice(-k);
  const sma = recent.reduce((a, b) => a + b, 0) / recent.length;
  const momentum = last - sma;

  return {
    series: downsample(prices, maxSeries),
    interval,
    sampleCount: prices.length,
    first,
    last,
    changeAbs,
    changePct,
    high,
    low,
    volatility,
    momentum,
  };
}

function hasUnknownBasis(p: PositionSignalInput): boolean {
  return p.costBasisSource === "unknown" || p.avgEntryPrice == null || p.unrealizedPnlPct == null;
}

function hasExitLiquidity(p: PositionSignalInput): boolean {
  return p.bestBid != null && p.bestBid > 0;
}

function isNearResolution(p: PositionSignalInput, t: RecoveryThresholds): boolean {
  return (
    p.marketStatus === "resolved" ||
    p.marketStatus === "near-resolution" ||
    p.redeemable ||
    (p.timeToResolutionMs != null && p.timeToResolutionMs <= t.nearResolutionMs)
  );
}

function exposurePct(p: PositionSignalInput, t: RecoveryThresholds): number {
  if (p.estimatedValueUsd == null || t.portfolioValueUsd <= 0) return 0;
  return (p.estimatedValueUsd / t.portfolioValueUsd) * 100;
}

/**
 * Categorize a position. Precedence is deliberate: hard safety conditions
 * (near resolution, no/low liquidity, unknown basis) come before P&L-driven
 * categories so we never recommend trading into a wall.
 */
export function classifyPosition(p: PositionSignalInput, t: RecoveryThresholds): PositionClassification {
  if (isNearResolution(p, t)) return "near-resolution";
  if (!hasExitLiquidity(p) || p.liquidityUsd < t.minLiquidityUsd) return "too-illiquid";
  if (hasUnknownBasis(p)) return "manual-review";
  if (p.unrealizedPnlPct != null && p.unrealizedPnlPct <= -t.stopLossPct) return "exit-candidate";
  if (p.unrealizedPnlPct != null && p.unrealizedPnlPct >= t.takeProfitPct) return "take-profit";
  if (exposurePct(p, t) > t.maxPerMarketPct) return "reduce-exposure";
  return "healthy-hold";
}

/** Map a classification to a concrete recommended action plus a plain rationale. */
export function recommendAction(
  classification: PositionClassification,
  p: PositionSignalInput,
  t: RecoveryThresholds,
): { action: RecommendedAction; rationale: string } {
  switch (classification) {
    case "near-resolution":
      if (p.redeemable) {
        return { action: "manual-review", rationale: "Market has resolved — redeem manually rather than trading it." };
      }
      return {
        action: "manual-review",
        rationale: `Resolves in ~${p.timeToResolutionMs != null ? humanizeMs(p.timeToResolutionMs) : "soon"}; avoid automated exits this close to resolution.`,
      };
    case "too-illiquid":
      if (!hasExitLiquidity(p)) {
        return { action: "manual-review", rationale: "No resting bids to sell into — manual review before any exit." };
      }
      return {
        action: "wait-for-liquidity",
        rationale: `Liquidity ($${Math.round(p.liquidityUsd)}) is below the safe threshold ($${Math.round(t.minLiquidityUsd)}); wait for depth before exiting.`,
      };
    case "manual-review":
      return { action: "manual-review", rationale: "Cost basis is unknown, so P&L can't be assessed — review manually." };
    case "exit-candidate":
      return {
        action: "sell-all",
        rationale: `Down ${pct(p.unrealizedPnlPct ?? 0)} (past the ${t.stopLossPct}% stop) and liquid enough to exit.`,
      };
    case "take-profit":
      return {
        action: "sell-partial",
        rationale: `Up ${pct(p.unrealizedPnlPct ?? 0)} (past the ${t.takeProfitPct}% target); scale out partially and let the rest run.`,
      };
    case "reduce-exposure":
      return {
        action: "reduce-risk",
        rationale: `~${exposurePct(p, t).toFixed(1)}% of portfolio is in this market, over the ${t.maxPerMarketPct}% per-market cap; trim it.`,
      };
    case "healthy-hold":
    default:
      return { action: "hold", rationale: "Within liquidity, exposure, and P&L limits — hold." };
  }
}

/** Independent safety flags. These are warnings, not gates — nothing executes. */
export function evaluateRiskFlags(p: PositionSignalInput, t: RecoveryThresholds): RiskFlag[] {
  const flags: RiskFlag[] = [];

  if (hasUnknownBasis(p)) {
    flags.push({
      code: "unknown-cost-basis",
      severity: "warning",
      message: "Cost basis is unknown — P&L is not assumed and no precision is faked.",
    });
  }

  if (!hasExitLiquidity(p)) {
    flags.push({
      code: "no-exit-liquidity",
      severity: "critical",
      message: "No resting bids right now — this position cannot be sold without manual handling.",
    });
  } else if (p.liquidityUsd < t.minLiquidityUsd) {
    flags.push({
      code: "illiquid",
      severity: "warning",
      message: `Liquidity ($${Math.round(p.liquidityUsd)}) is below the safe threshold ($${Math.round(t.minLiquidityUsd)}). Never auto-sell illiquid positions without review.`,
    });
  }

  if (p.spread != null && p.spread >= t.wideSpreadAbs) {
    flags.push({
      code: "wide-spread",
      severity: "warning",
      message: `Spread is ${(p.spread * 100).toFixed(1)}c wide — exiting now would pay the spread.`,
    });
  }

  if (p.redeemable || p.marketStatus === "resolved") {
    flags.push({
      code: "resolved-redeemable",
      severity: "warning",
      message: "Market has resolved; redeem the position manually rather than trading it.",
    });
  } else if (isNearResolution(p, t)) {
    flags.push({
      code: "near-resolution",
      severity: "warning",
      message: `Market resolves in ~${p.timeToResolutionMs != null ? humanizeMs(p.timeToResolutionMs) : "soon"} — avoid automated trades near resolution.`,
    });
  }

  if (p.fromBotSession) {
    flags.push({
      code: "from-bot-session",
      severity: "warning",
      message: "This token also appears in a previous bot session — confirm before the bot manages it again.",
    });
  }

  return flags;
}

/** Compose classification + recommendation + flags for one position. */
export function analyzePositionSignals(p: PositionSignalInput, t: RecoveryThresholds): PositionSignals {
  const classification = classifyPosition(p, t);
  const { action, rationale } = recommendAction(classification, p, t);
  return {
    classification,
    recommendedAction: action,
    actionRationale: rationale,
    riskFlags: evaluateRiskFlags(p, t),
  };
}
