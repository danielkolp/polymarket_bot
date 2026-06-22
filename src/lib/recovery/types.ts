/**
 * Types for the Live Mode Portfolio Recovery system.
 *
 * This module makes a future live session portfolio-aware: before the bot does
 * anything, it reads the connected account's existing positions, analyzes them,
 * and recommends (but never executes) actions. Real execution stays disabled
 * behind `config.enableRealTrading`; see liveExecutionEnabled below.
 */

/** Where a position's cost basis came from. We never fabricate precision. */
export type CostBasisSource = "api" | "reconstructed" | "unknown";

/** How a single existing position is categorized after analysis. */
export type PositionClassification =
  | "healthy-hold"
  | "take-profit"
  | "reduce-exposure"
  | "exit-candidate"
  | "too-illiquid"
  | "near-resolution"
  | "manual-review";

/** A recommended action. Recommendations only — nothing here is executed yet. */
export type RecommendedAction =
  | "hold"
  | "sell-all"
  | "sell-partial"
  | "reduce-risk"
  | "wait-for-liquidity"
  | "manual-review";

export type RiskFlagCode =
  | "unknown-cost-basis"
  | "illiquid"
  | "no-exit-liquidity"
  | "wide-spread"
  | "near-resolution"
  | "resolved-redeemable"
  | "from-bot-session"
  | "real-trading-disabled";

export type RiskSeverity = "info" | "warning" | "critical";

export interface RiskFlag {
  code: RiskFlagCode;
  severity: RiskSeverity;
  message: string;
}

export type MarketStatus = "open" | "near-resolution" | "resolved" | "unknown";

/** Trend stats derived from a token's recent price history. */
export interface PriceHistoryStats {
  /** Downsampled series used for the sparkline (oldest -> newest). */
  series: number[];
  interval: string;
  sampleCount: number;
  first: number | null;
  last: number | null;
  changeAbs: number | null;
  changePct: number | null;
  high: number | null;
  low: number | null;
  /** Stdev of period-over-period returns. */
  volatility: number | null;
  /** last price minus a short moving average; sign indicates momentum. */
  momentum: number | null;
}

export interface RecoveredPosition {
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  slug: string;
  outcome: string;

  shares: number;

  costBasisSource: CostBasisSource;
  /** null when unknown — callers must not assume a value. */
  avgEntryPrice: number | null;
  costBasisUsd: number | null;

  bestBid: number | null;
  bestAsk: number | null;
  midPrice: number | null;
  /** Absolute spread in price units (0..1). */
  spread: number | null;
  liquidityUsd: number;
  volume24hrUsd: number;

  estimatedValueUsd: number | null;
  unrealizedPnlUsd: number | null;
  unrealizedPnlPct: number | null;

  endDate: string | null;
  timeToResolutionMs: number | null;
  marketStatus: MarketStatus;
  redeemable: boolean;

  priceHistory: PriceHistoryStats | null;

  /** True if this token also appears in the local bot's positions/trade log. */
  fromBotSession: boolean;

  classification: PositionClassification;
  recommendedAction: RecommendedAction;
  actionRationale: string;
  riskFlags: RiskFlag[];
}

export interface PortfolioTotals {
  positionCount: number;
  estimatedValueUsd: number;
  knownCostBasisUsd: number;
  unrealizedPnlUsd: number;
  unknownCostBasisCount: number;
  illiquidCount: number;
  nearResolutionCount: number;
  fromBotSessionCount: number;
  /** Positions whose recommended action is not hold/manual-review. */
  actionableCount: number;
}

export interface PortfolioSnapshot {
  wallet: string;
  fetchedAt: number;
  positions: RecoveredPosition[];
  totals: PortfolioTotals;
  /** Mirror of config.enableRealTrading so the client can gate the live option. */
  realTradingEnabled: boolean;
  /** Always false in this phase: this module never places live orders. */
  liveExecutionEnabled: boolean;
  /** Human-readable notes about degraded data, truncation, etc. */
  notes: string[];
}

/** How the user wants to resume after reviewing recovery. */
export type ResumeChoice = "simulate" | "manual" | "live";

/** Tunable thresholds the pure analysis engine reads (decoupled from BotSettings). */
export interface RecoveryThresholds {
  takeProfitPct: number;
  stopLossPct: number;
  maxPerMarketPct: number;
  minLiquidityUsd: number;
  /** Spread (price units) at/above which we warn it's too wide to exit cleanly. */
  wideSpreadAbs: number;
  /** Time-to-resolution (ms) at/below which a market counts as near resolution. */
  nearResolutionMs: number;
  /** Denominator for per-market exposure %; total portfolio value. */
  portfolioValueUsd: number;
}
