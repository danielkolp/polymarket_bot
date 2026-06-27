/**
 * Analytics layer types.
 *
 * This layer is OBSERVATIONAL ONLY. Nothing here participates in any trading
 * decision — it records what the bot decided and the full context around each
 * decision so the data can later be analyzed (and fed into an LLM) to improve
 * the strategy. The decision score (see {@link DecisionScore}) is computed for
 * every potential trade but is deliberately NOT used to gate any trade.
 */
import type { BotMode, TradeStatus } from "@/lib/copybot/types";
import type { Market } from "@/lib/polymarket/types";

/** High-level market category used for bucketed performance analysis. */
export type MarketCategory =
  | "sports"
  | "politics"
  | "crypto"
  | "economics"
  | "pop-culture"
  | "science-tech"
  | "weather"
  | "other";

/** Normalized decision the bot reached for a single observed leader trade. */
export type DecisionAction = "BUY" | "SELL" | "SKIP" | "FAIL";

/**
 * Mutable bag the bot fills in while evaluating a trade. It is passed into the
 * decision routine and read back by the recorder. Every field is optional: an
 * early skip (e.g. a stale trade) is recorded before sizing is ever computed, so
 * those fields stay undefined. Populating this object NEVER affects any decision.
 */
export interface DecisionCapture {
  market?: Market | null;
  tradeAgeSec?: number;
  /** Total open exposure (USD) before this trade. */
  exposureBeforeUsd?: number;
  /** Open exposure (USD) in this trade's market before this trade. */
  marketExposureBeforeUsd?: number;
  /** Spendable cash (USD) considered for this trade. */
  availableCashUsd?: number;
  /** Equity (cash + exposure, USD) considered for this trade. */
  equityUsd?: number;
  /** Live wallet USDC balance when available (real mode / sim preview). */
  liveBalanceUsd?: number | null;
  /** Strategy-sized copy amount before risk-cap clamping (USD). */
  strategyAmountUsd?: number;
  /** Final requested order size after all clamps (USD). */
  requestedAmountUsd?: number;
  /** Per-market exposure cap in USD at decision time. */
  perMarketCapUsd?: number;
  /** Total exposure cap in USD at decision time. */
  totalCapUsd?: number;
  /** Bot-attributed P&L since the daily baseline (USD). */
  dailyPnlUsd?: number;
}

/** The eight normalized 0..100 quality components behind a decision score. */
export interface DecisionScoreComponents {
  traderQuality: number;
  liquidity: number;
  spread: number;
  freshness: number;
  slippage: number;
  priceQuality: number;
  correlation: number;
  marketQuality: number;
}

/**
 * Normalized 0..100 decision score plus its components and the weights used.
 * Analytics-only: the bot does not read `total` to make any decision.
 */
export interface DecisionScore {
  total: number;
  components: DecisionScoreComponents;
  weights: DecisionScoreComponents;
}

/** Trader-quality snapshot captured at decision time. */
export interface TraderQualitySnapshot {
  wallet: string;
  name: string;
  /** Public leaderboard weekly P&L (USD), if known. */
  weeklyPnlUsd: number | null;
  weeklyVolumeUsd: number | null;
  weeklyTradeCount: number | null;
  /** Trader ROI over rolling windows, when the data source exposes them. */
  roi1d: number | null;
  roi7d: number | null;
  roi30d: number | null;
  /** Our own historical copy ROI for this trader (from the copy score). */
  ourCopyRoi: number | null;
  /** Trader win rate, when derivable. */
  winRate: number | null;
  /** Average holding time in ms, when derivable. */
  avgHoldMs: number | null;
  /** Composite copy score (0..100) from the bot's own copied results. */
  copyScore: number | null;
  copiedTradeCount: number | null;
}

/** Order-book / market microstructure captured at decision time. */
export interface MarketSnapshot {
  conditionId: string;
  tokenId: string;
  title: string;
  slug: string;
  category: MarketCategory;
  outcome: string;
  liquidityUsd: number | null;
  volumeUsd: number | null;
  volume24hrUsd: number | null;
  /** Fractional spread (0..1). */
  spread: number | null;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  /** Implied probability (0..1) of the copied outcome. */
  impliedProbability: number | null;
  /** Milliseconds until resolution, when known. */
  timeToResolutionMs: number | null;
  resolvesAt: string | null;
}

/** One fully-contextualized BUY / SELL / SKIP / FAIL decision record. */
export interface DecisionRecord {
  id: string;
  ts: number;
  mode: BotMode;
  action: DecisionAction;
  status: TradeStatus;
  /** Links back to the persisted CopyTradeRecord. */
  copyRecordId: string;
  sourceTradeId: string;

  side: "BUY" | "SELL";
  /** Convenience copy of market.tokenId for grouping. */
  tokenId: string;
  copiedWallet: string;
  trader: TraderQualitySnapshot;
  market: MarketSnapshot;

  /** Leader's original fill price (0..1). */
  leaderFillPrice: number | null;
  /** The bot's fill / would-be fill price (0..1). */
  ourFillPrice: number | null;
  /** ourFillPrice - leaderFillPrice in cents (positive = we paid up). */
  slippageCents: number | null;
  /** Effective per-share price after fees, when filled. */
  effectivePrice: number | null;
  feeUsd: number | null;
  frictionUsd: number | null;
  /** Fill quality when the realistic fill model ran ("partial" = thin book). */
  fillStatus: "filled" | "partial" | "rejected" | null;

  sourceSizeShares: number;
  sourceAmountUsd: number;
  copyAmountUsd: number;
  copiedShares: number;
  realizedPnlUsd: number;

  tradeAgeSec: number | null;

  // Portfolio context.
  exposureBeforeUsd: number | null;
  exposureAfterUsd: number | null;
  marketExposureBeforeUsd: number | null;
  availableCashUsd: number | null;
  equityUsd: number | null;
  liveBalanceUsd: number | null;
  requestedAmountUsd: number | null;
  perMarketCapUsd: number | null;
  totalCapUsd: number | null;
  dailyPnlUsd: number | null;

  /** Normalized skip/fail reason bucket, for grouping. */
  reasonCode: string;
  /** Full human-readable reason text. */
  reason: string;

  /**
   * For SELL rows: how the exit was initiated. "leader-copy" = mirrored a leader
   * SELL through the normal decision path; the rest are bot-autonomous exits
   * recorded from their own code paths (auto-exit, leader-exit, flatten/panic,
   * redemption, settlement). Undefined for BUY rows.
   */
  exitSource?:
    | "leader-copy"
    | "auto-exit"
    | "leader-exit"
    | "session-close"
    | "panic-flatten"
    | "manual-flatten"
    | "redeem"
    | "settlement";

  score: DecisionScore;
}

/** Periodic snapshot of one open position, for reconstructing a trade's life. */
export interface PositionSnapshot {
  id: string;
  ts: number;
  mode: BotMode;
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  category: MarketCategory;
  outcome: string;
  shares: number;
  avgPrice: number;
  markPrice: number;
  exposureUsd: number;
  costBasisUsd: number;
  unrealizedPnlUsd: number;
  roi: number;
  /** "yes" | "no" | "unknown" — does the source leader still hold? */
  leaderHolds: string | null;
  liquidityUsd: number | null;
  spread: number | null;
  sourceWallets: string[];
}

/** A completed (round-trip) copied trade, derived from decisions + snapshots. */
export interface CompletedTrade {
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  category: MarketCategory;
  outcome: string;
  copiedWallet: string;
  entryTs: number;
  exitTs: number;
  holdMs: number;
  entryPrice: number;
  exitPrice: number;
  shares: number;
  costBasisUsd: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  roi: number;
  maxUnrealizedGainUsd: number | null;
  maxUnrealizedLossUsd: number | null;
  ourRoi: number;
  entrySlippageCents: number | null;
  exitReason: string;
  leaderExitedFirst: boolean | null;
  marketOutcome: "won" | "lost" | "open" | "unknown";
}

/** Resolution of a skipped BUY: would copying it have paid off? */
export interface MissedOpportunity {
  decisionId: string;
  resolvedAt: number;
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  category: MarketCategory;
  outcome: string;
  copiedWallet: string;
  skipReasonCode: string;
  skipReason: string;
  /** Price we would have entered at (leader/our fill price at skip time). */
  entryPrice: number;
  /** Price observed at resolution time (mark or settlement). */
  laterPrice: number;
  /** Final market outcome once resolved. */
  finalOutcome: "won" | "lost" | "open" | "unknown";
  /** ROI had we copied: (laterPrice - entryPrice) / entryPrice. */
  roiIfCopied: number;
  wouldHaveBeenProfitable: boolean;
  maxUnrealizedProfit: number | null;
  maxUnrealizedLoss: number | null;
  /** Was the market resolved at evaluation time, or just time-elapsed? */
  basis: "resolved" | "elapsed";
}
