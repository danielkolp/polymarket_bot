import type { TraderTrade } from "@/lib/polymarket/types";

export type BotMode = "simulation" | "real";
export type BotRunState = "stopped" | "running" | "paused" | "draining";
export type SellBehavior = "proportional" | "all";
export type SizingMode = "fixed" | "percentage" | "hybrid";
export type RiskPresetId = "conservative" | "balanced" | "aggressive-simulation" | "live-default" | "custom";
export type TradeStatus = "simulated" | "copied" | "skipped" | "failed" | "dry-run";
export type LogLevel = "info" | "warning" | "error";
export type LiveBalanceStatus = "ok" | "warning" | "error" | "unknown";

export interface BotSettings {
  mode: BotMode;
  startingBalance: number;
  pollingIntervalSec: number;
  topTradersToFollow: number;
  sizingMode: SizingMode;
  fixedCopyAmountUsd: number;
  percentageCopySize: number;
  minTradeAmountUsd: number;
  maxTradeAmountUsd: number;
  riskPreset: RiskPresetId;
  maxExposurePerMarketPercent: number;
  maxTotalExposurePercent: number;
  maxDailyLossPercent: number;
  minAvailableBalanceUsd: number;
  sellBehavior: SellBehavior;
  minTraderWeeklyVolumeUsd: number;
  minTraderTradeCount: number;
  maxTraderInactivityHours: number;
  minMarketLiquidityUsd: number;
  minBuyTokenPrice: number;
  maxBuyTokenPrice: number;
  maxMarketSpread: number;
  minTimeToResolutionMinutes: number;
  maxTradeAgeSec: number;
  traderRefreshIntervalMin: number;

  /**
   * Per-copied-wallet risk controls. These stop any single followed wallet from
   * dominating the session — independent of the global exposure caps.
   */
  /** Max BUYs copied from one wallet within a single poll cycle. 0 = unlimited. */
  maxCopiesPerWalletPerCycle: number;
  /** Max exposure (% of equity) across markets a single wallet drove us into. 0 = disabled. */
  maxExposurePerWalletPercent: number;
  /** Cooldown after copying a wallet+market BUY before copying that pair again. 0 = disabled. */
  walletTradeCooldownSec: number;

  /**
   * Session-only mode: positions opened during a run are treated as ephemeral.
   * When true, stopping the bot (or closing the dashboard window) auto-liquidates
   * everything instead of leaving open simulated positions behind.
   */
  sessionOnly: boolean;
  /** Auto-exit (drain) rules. 0 disables the individual rule. */
  autoExitTakeProfitPercent: number;
  autoExitStopLossPercent: number;
  autoExitMaxHoldMinutes: number;

  /**
   * Realistic execution-cost model. When true (default), copies fill against the
   * live order book with spread, slippage, partial fills, and fees — so the
   * equity curve reflects net-of-cost P&L rather than idealized fills.
   */
  realisticFills: boolean;
  /** Taker fee in basis points of notional. Polymarket is ~0; configurable. */
  takerFeeBps: number;
  /** Reject fills worse than this many bps from mid (thin-book / wide-spread guard). */
  maxSlippageBps: number;
  /** Assumed spread (bps of price) used only when no live book/quote is available. */
  fallbackSpreadBps: number;
}

export interface FollowedTrader {
  wallet: string;
  name: string;
  enabled: boolean;
  source: "auto" | "manual";
  rank: number | null;
  weeklyPnlUsd: number;
  weeklyVolumeUsd: number;
  weeklyTradeCount: number;
  copiedTradeCount: number;
  copiedSimPnlUsd: number;
  lastTradeAt: number | null;
  addedAt: number;
  updatedAt: number;
}

export interface BotPosition {
  tokenId: string;
  conditionId: string;
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  shares: number;
  avgPrice: number;
  markPrice: number;
  realizedPnlUsd: number;
  openedAt: number;
  updatedAt: number;
  sourceWallets: string[];
}

export interface CopyTradeRecord {
  id: string;
  sourceTradeId: string;
  status: TradeStatus;
  mode: BotMode;
  traderWallet: string;
  traderName: string;
  side: TraderTrade["side"];
  tokenId: string;
  conditionId: string;
  marketSlug: string;
  marketTitle: string;
  outcome: string;
  price: number;
  sourceSize: number;
  sourceAmountUsd: number;
  copyAmountUsd: number;
  copiedShares: number;
  realizedPnlUsd: number;
  reason: string;
  txOrOrderId: string;
  sourceTimestamp: number;
  processedAt: number;

  // Execution-cost detail (present when the realistic fill model is used).
  /** Effective per-share fill price after fees. */
  effectivePrice?: number;
  /** Mid price used as the slippage benchmark. */
  referencePrice?: number;
  feeUsd?: number;
  /** Spread/slippage vs mid + fees, in USD. */
  frictionUsd?: number;
  fillStatus?: "filled" | "partial" | "rejected";
  costSource?: "book" | "quote" | "assumed";
}

export interface BotLogEntry {
  id: string;
  ts: number;
  level: LogLevel;
  message: string;
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
  cashUsd: number;
  exposureUsd: number;
}

export interface BotMetrics {
  cashUsd: number;
  availableBalanceUsd: number;
  equityUsd: number;
  liveUsdcBalance: number | null;
  localTrackedEquity: number;
  balanceDifference: number | null;
  lastLiveBalanceCheck: string | null;
  liveBalanceStatus: LiveBalanceStatus;
  liveBalanceError: string | null;
  buyExposurePaused: boolean;
  buyExposurePauseReason: string | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  roi: number;
  winRate: number;
  winners: number;
  losers: number;
  nextTradeSizeUsd: number;
  totalTrades: number;
  failedTrades: number;
  skippedTrades: number;
  openPositions: number;
  totalExposureUsd: number;
  totalExposurePercent: number;
  maxDrawdown: number;
  dailyPnlUsd: number;
  /** Total spread/slippage + fees paid across simulated fills (the cost drag). */
  totalFrictionUsd: number;
  totalFeesUsd: number;
}

export interface BotState {
  runState: BotRunState;
  startedAt: number | null;
  stoppedAt: number | null;
  pausedAt: number | null;
  lastPollAt: number | null;
  nextPollAt: number | null;
  lastDiscoveryAt: number | null;
  lastError: string | null;
  dailyDate: string;
  dailyStartEquityUsd: number;
  peakEquityUsd: number;
  firstRunBootstrappedAt: number | null;
  /** Cumulative wallet checks since the current session was started (reset on Start). */
  sessionWalletsChecked: number;
  /** Cumulative trader trades scanned since the current session was started. */
  sessionTradesScanned: number;
}

export interface SeenTradeBook {
  ids: string[];
}

export interface BullpenStatus {
  available: boolean;
  checkedAt: number | null;
  helpText: string | null;
  error: string | null;
}

export interface WalletPnl {
  wallet: string;
  name: string;
  realizedPnlUsd: number;
}

export interface SkipReasonCount {
  /** A representative (templated) skip message for this reason bucket. */
  reason: string;
  count: number;
}

/** Per-wallet copy activity + current exposure attributed to that wallet. */
export interface WalletCopyStat {
  wallet: string;
  name: string;
  /** Filled BUY + SELL copies sourced from this wallet. */
  copiedTrades: number;
  buys: number;
  sells: number;
  /** Current open exposure (USD) in markets this wallet contributed to. */
  exposureUsd: number;
  /** Exposure as a fraction of current equity. */
  exposurePercent: number;
  realizedPnlUsd: number;
}

/**
 * Aggregated, session-oriented snapshot rendered in the scoreboard panel.
 * Derived on demand from settings, state, metrics, the full trade ledger, and
 * the followed-trader list — it holds no independent persisted state.
 */
export interface SessionScoreboard {
  activePreset: RiskPresetId;
  presetLabel: string;
  startedAt: number | null;
  runtimeMs: number;
  walletsChecked: number;
  tradesScanned: number;
  copiedBuys: number;
  copiedSells: number;
  openPositions: number;
  totalExposurePercent: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  currentEquityUsd: number;
  roi: number;
  maxDrawdown: number;
  /** Share-weighted average BUY fill price across copied/simulated entries. */
  averageEntryPrice: number;
  /** Share-weighted average SELL fill price across copied/simulated exits. */
  averageExitPrice: number;
  bestWallet: WalletPnl | null;
  worstWallet: WalletPnl | null;
  /** Per-wallet copy counts + exposure, sorted by exposure then copy count. */
  copiedTradesByWallet: WalletCopyStat[];
  skipsByReason: SkipReasonCount[];
}

export interface BotStatus {
  state: BotState;
  settings: BotSettings;
  metrics: BotMetrics;
  scoreboard: SessionScoreboard;
  realTradingEnabled: boolean;
  simulationOnly: boolean;
  bullpen: BullpenStatus;
  traders: FollowedTrader[];
  positions: BotPosition[];
  recentTrades: CopyTradeRecord[];
  equityCurve: EquityPoint[];
  logs: BotLogEntry[];
}
