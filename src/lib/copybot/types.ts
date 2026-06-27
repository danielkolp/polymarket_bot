import type { TraderTrade } from "@/lib/polymarket/types";

export type BotMode = "simulation" | "real";
export type BotRunState = "stopped" | "running" | "paused" | "draining";
export type SellBehavior = "proportional" | "all";
export type SizingMode = "fixed" | "percentage" | "hybrid";
/**
 * How the copy amount is scaled.
 *  - "local-fixed": the bot's own fixed/percentage/hybrid sizing (default).
 *  - "leader-size-weighted": scale by the leader's trade size relative to their
 *    typical recent trade size (conviction). Never bypasses any risk cap.
 */
export type SizingSignalMode = "local-fixed" | "leader-size-weighted";
/** Whether the source leader of a copied position still appears to hold it. */
export type LeaderHoldStatus = "yes" | "no" | "unknown";
export type RiskPresetId = "conservative" | "balanced" | "aggressive-simulation" | "action" | "live-default" | "custom";

/**
 * Which Discovery v2 pool surfaced an auto-followed wallet. Manual/pinned wallets
 * the operator added directly carry their own source tags.
 */
export type DiscoverySource =
  | "profit-1d"
  | "profit-7d"
  | "volume"
  | "high-frequency"
  | "manual"
  | "pinned";
export type TradeStatus = "simulated" | "copied" | "skipped" | "failed" | "dry-run";
export type LogLevel = "info" | "warning" | "error";
export type LiveBalanceStatus = "ok" | "warning" | "error" | "unknown";

/** Lifecycle of matching a local live order against authoritative CLOB fills. */
export type ReconciliationStatus = "pending" | "matched" | "partial-match" | "unmatched" | "error";

/** How a live account position relates to the bot's local position ledger. */
export type LivePositionClassification =
  | "known-bot-position"
  | "manual-position"
  | "unknown-existing-position"
  | "stale-local-position"
  | "missing-live-position";

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
   * Adverse-entry gate (edge protection). Skip a copied BUY when the current
   * executable ask is more than this many cents above the leader's original
   * trade price — i.e. the price already ran away and we'd be buying the move
   * after the leader. 0 disables the gate (real mode forces it on). Real mode is
   * additionally clamped to a tighter ceiling than simulation.
   */
  maxAdverseEntryMoveCents: number;
  /**
   * Stricter real-mode freshness window (seconds) for copied BUYs, on top of the
   * hard 5-minute absolute cap. In real mode a BUY older than this is skipped.
   * Simulation ignores this (it uses the looser maxTradeAgeSec) for stress tests.
   */
  liveMaxCopyTradeAgeSec: number;
  /**
   * When true, a copied position whose source leader no longer appears to hold
   * the token is exited (sim: sold at mark; real: sold only if bot-opened, live
   * data is healthy, and safety gates pass). Manual/unknown positions are never
   * touched by this rule.
   */
  exitWhenLeaderNoLongerHolds: boolean;
  /** Copy-amount signal: own sizing ("local-fixed") or leader conviction. */
  sizingSignalMode: SizingSignalMode;

  /**
   * Per-copied-wallet risk controls. These stop any single followed wallet from
   * dominating the session â€” independent of the global exposure caps.
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
   * live order book with spread, slippage, partial fills, and fees â€” so the
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

/**
 * Score derived from the bot's OWN copied results for a wallet â€” not public
 * leaderboard PnL. This is what should decide which wallets survive into live
 * mode. All component metrics are computed from the local copy-trade ledger and
 * current positions, so they reflect realistic (post-fill) outcomes.
 */
export interface CopyScore {
  wallet: string;
  /** Filled BUY copies sourced from this wallet. */
  copiedBuys: number;
  /** Filled SELL copies sourced from this wallet. */
  copiedSells: number;
  /** Filled copies (buys + sells). */
  filledCopies: number;
  /** Skipped source trades from this wallet. */
  skippedCount: number;
  /** skipped / (skipped + filled). High = this wallet's trades rarely pass gates. */
  skipRatio: number;
  /** Realized P&L attributed to this wallet's copied trades. */
  realizedPnlUsd: number;
  /** Unrealized P&L of still-open positions this wallet contributed to. */
  unrealizedPnlUsd: number;
  /** Total USD put to work on this wallet's copied BUYs (cost basis). */
  investedUsd: number;
  /** (realized + unrealized) / invested. */
  copyRoi: number;
  /** Share-weighted average entry slippage vs mid, in bps, across copied BUYs. */
  avgSlippageBps: number;
  /** Copied BUY entries above 85c (asymmetric-risk entries). */
  highPriceEntryCount: number;
  /** Copied BUY entries that only partially filled (thin-book proxy). */
  lowLiquidityEntryCount: number;
  /** Open positions still attributed to this wallet (potential missed exits). */
  openPositionCount: number;
  /** Composite 0..100 score; higher is better. */
  score: number;
  /** Non-null when scoring rules recommend auto-disabling this wallet. */
  autoDisableReason: string | null;
  /** Non-null when this wallet should remain enabled but watched closely. */
  reviewReason: string | null;
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

  /** Manual override: a pinned wallet is never auto-disabled by scoring. */
  pinned?: boolean;
  /** Set true when copy-scoring rules disabled this wallet (separate from `enabled`). */
  autoDisabled?: boolean;
  autoDisableReason?: string | null;
  /** Set true when scoring found weak/early negative signals that should not disable the wallet yet. */
  underReview?: boolean;
  reviewReason?: string | null;
  /** Latest copy-performance score derived from the bot's own copied results. */
  copyScore?: CopyScore | null;

  /** Discovery v2: which candidate pool primarily surfaced this auto wallet. */
  discoverySource?: DiscoverySource;
  /** Discovery v2: composite ranking score (0..100) from the last refresh. */
  discoveryScore?: number;
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

  /**
   * Whether the source leader(s) still appear to hold this token, from the last
   * leader-holdings reconciliation. "no" means every queried source wallet has
   * exited; "unknown" means we could not fetch (or the position is manual). Only
   * "no" on a bot-opened position can trigger a leader-exit sale.
   */
  leaderHolds?: LeaderHoldStatus;
  /** When leaderHolds was last evaluated (ms epoch). */
  leaderCheckedAt?: number;
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

  // ── Edge / adverse-entry visibility (copied BUYs) ───────────────────────────
  /** The leader's original trade price (0..1) this record was sourced from. */
  leaderPrice?: number;
  /** The bot's current executable BUY price (current ask, 0..1) at copy time. */
  botExecPrice?: number;
  /** botExecPrice − leaderPrice, in cents (positive = bot paying up vs leader). */
  adverseMoveCents?: number;

  // â”€â”€ Authoritative live-fill reconciliation (real mode only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /** When this record was last reconciled against CLOB trade history (ms epoch). */
  reconciledAt?: number;
  /** Result of matching this live order to authoritative CLOB fills. */
  reconciliationStatus?: ReconciliationStatus;
  /** Real filled shares per the CLOB, once reconciled. */
  actualFilledShares?: number;
  /** Real share-weighted average fill price per the CLOB, once reconciled. */
  actualAvgPrice?: number;
  /** Real USDC spent (BUY) / received (SELL) per the CLOB, once reconciled. */
  actualNotionalUsd?: number;
  /** On-chain settlement transaction hashes for the matched fills. */
  txHashes?: string[];
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
  /** Remaining cost basis of currently open positions. */
  totalOpenCostBasisUsd: number;
  totalExposureUsd: number;
  totalExposurePercent: number;
  maxDrawdown: number;
  /** Bot-attributed P&L since the local day baseline; live wallet drift is reported separately. */
  dailyPnlUsd: number;
  /** Total spread/slippage + fees paid across simulated fills (the cost drag). */
  totalFrictionUsd: number;
  totalFeesUsd: number;

  /** Hard daily-loss lockout: when true, no new BUY may be opened until the next day. */
  dailyLossLockout: boolean;
  dailyLossLockoutReason: string | null;
  /** Panic stop engaged: all new BUYs are blocked until panic is cleared. */
  panic: boolean;
  panicReason: string | null;
  /** Count of live orders not yet reconciled against authoritative CLOB fills. */
  unreconciledLiveOrders: number;

  // â”€â”€ Authoritative-vs-mirror accounting (real mode) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  /** Cash computed purely from local mirror estimates (copyAmountUsd). */
  cashUsdLocalMirror: number;
  /** Cash used by dashboard accounting after applying authoritative fills and open cost basis. */
  cashUsdAuthoritative: number;
  /** Mirror cash reserved against live BUYs that are not yet reconciled. */
  pendingReservedUsd: number;
  /** Total mirror notional of real orders not yet authoritatively reconciled. */
  unreconciledNotionalUsd: number;
  /**
   * Confidence in the money ledger:
   *  - "high": no unsafe real orders (or simulation).
   *  - "degraded": some real orders are pending reconciliation.
   *  - "blocked": some real orders are unmatched/errored â€” new BUYs are blocked.
   */
  accountingConfidence: "high" | "degraded" | "blocked";
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
  /** Whole-wallet equity at the local day baseline; used as the bankroll denominator for caps. */
  dailyStartEquityUsd: number;
  /** Bot-attributed cumulative P&L at the local day baseline. */
  dailyStartBotPnlUsd: number;
  peakEquityUsd: number;
  firstRunBootstrappedAt: number | null;
  /** Cumulative wallet checks since the current session was started (reset on Start). */
  sessionWalletsChecked: number;
  /** Cumulative trader trades scanned since the current session was started. */
  sessionTradesScanned: number;

  /**
   * Latched daily-loss lockout. Set true once the daily-loss cap is breached;
   * cleared only at the local day boundary (or on reset). While true, no new BUY
   * is opened in any mode â€” sells/flattening stay allowed.
   */
  dailyLossLockout: boolean;
  /**
   * Emergency panic stop. Persisted so a server restart never silently resumes
   * trading. While true, all new BUYs are refused; reads, sells, and flattening
   * still work. Cleared explicitly via the resume endpoint.
   */
  panic: boolean;
  panicAt: number | null;
  panicReason: string | null;
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
 * the followed-trader list â€” it holds no independent persisted state.
 */
export interface SessionScoreboard {
  activePreset: RiskPresetId;
  presetLabel: string;
  /** The actual numeric thresholds in force right now (preset- or custom-driven). */
  activeRiskValues: {
    maxTotalExposurePercent: number;
    maxExposurePerMarketPercent: number;
    minTimeToResolutionMinutes: number;
    minBuyTokenPrice: number;
    maxBuyTokenPrice: number;
  };
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

/** One live account position cross-referenced against the local ledger. */
export interface LivePositionEntry {
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  outcome: string;
  /** Shares per the authoritative account (0 when only a stale local position exists). */
  liveShares: number;
  /** Shares per the local ledger (0 when the bot never tracked it). */
  localShares: number;
  /** Current mark/exit price for valuing live exposure, 0..1. */
  markPrice: number;
  /** liveShares * markPrice. */
  exposureUsd: number;
  classification: LivePositionClassification;
  /** True when the source wallet of this token is a known copied wallet. */
  attributionKnown: boolean;
  redeemable: boolean;
  /** Neg-risk (multi-outcome) market â€” redeemed via the NegRiskAdapter, not the CTF. */
  negativeRisk: boolean;
}

/**
 * A resolved position eligible for on-chain redemption, enriched with the
 * expected USDC payout and whether it is safe to auto-redeem. Derived from the
 * live-position snapshot; never includes positions already redeemed.
 */
export interface RedeemableItem {
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  outcome: string;
  shares: number;
  /** Expected USDC payout if this is a winning position (winner pays $1/share). */
  expectedPayoutUsd: number;
  /** True when the position is attributable to a known copied wallet. */
  attributionKnown: boolean;
  classification: LivePositionClassification;
  negativeRisk: boolean;
  /**
   * Why this item cannot be auto-redeemed by the bot (proxy/safe wallet, neg-risk,
   * unknown attribution, â€¦). null = the bot can redeem it directly. Such items are
   * still surfaced so the operator can redeem them manually on Polymarket.
   */
  blockedReason: string | null;
}

/** Plan summarizing what is redeemable right now (for the dashboard + API GET). */
export interface RedeemablePlan {
  fetchedAt: number;
  mode: BotMode;
  items: RedeemableItem[];
  /** Items the bot can redeem itself (blockedReason == null). */
  redeemableCount: number;
  /** Items that need manual redemption (blockedReason != null). */
  manualCount: number;
  totalExpectedPayoutUsd: number;
  /** Non-null when the plan could not be built (e.g. live data unavailable). */
  error: string | null;
}

/** Outcome of a single on-chain redeem attempt. */
export interface RedeemAttemptResult {
  tokenId: string;
  conditionId: string;
  success: boolean;
  txHash: string | null;
  payoutUsd: number;
  error: string | null;
}

/** Summary returned after running a redeem pass (manual or automatic). */
export interface RedeemRunResult {
  ran: boolean;
  attempted: number;
  redeemed: number;
  failed: number;
  skipped: number;
  totalPayoutUsd: number;
  attempts: RedeemAttemptResult[];
  error: string | null;
}

/** One persisted record of a position that has already been redeemed (de-dupe). */
export interface RedeemedEntry {
  tokenId: string;
  conditionId: string;
  txHash: string | null;
  payoutUsd: number;
  redeemedAt: number;
  mode: BotMode;
}

/** Persisted ledger of redeemed positions â€” the double-redeem guard. */
export interface RedeemBook {
  entries: RedeemedEntry[];
}

/**
 * Snapshot of authoritative live positions reconciled against the local ledger.
 * Built on real-mode start (and refreshed on demand); read-only â€” never trades.
 */
export interface LivePositionReconciliation {
  fetchedAt: number;
  ok: boolean;
  error: string | null;
  entries: LivePositionEntry[];
  /** Total live exposure (USD) across all account positions. */
  totalLiveExposureUsd: number;
  /** Live exposure (USD) the bot cannot attribute to a known copied wallet. */
  unattributedExposureUsd: number;
  /** Positions present live but unknown to the bot (manual / pre-existing). */
  unknownPositionCount: number;
  /** Positions the local ledger thinks exist but the account does not (stale). */
  stalePositionCount: number;
  redeemableCount: number;
}

/** One readiness gate evaluated when deciding whether new BUYs may proceed. */
export interface ReadinessGate {
  code: string;
  label: string;
  ok: boolean;
  /** "block" gates stop new BUYs; "warn" gates are advisory only. */
  severity: "block" | "warn";
  detail: string;
}

/**
 * Structured answer to "can the bot open a new BUY right now?". Sells, flatten,
 * and read-only actions are intentionally NOT gated by this.
 */
export interface BuyReadiness {
  mode: BotMode;
  buysAllowed: boolean;
  evaluatedAt: number;
  gates: ReadinessGate[];
  blockers: ReadinessGate[];
  warnings: ReadinessGate[];
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
  /** Authoritative live-position reconciliation (real mode); null in simulation. */
  livePositions: LivePositionReconciliation | null;
  /** Resolved positions eligible for redemption (real mode); empty in simulation. */
  redeemables: RedeemablePlan;
  /** Structured "can the bot BUY right now?" readiness checklist. */
  buyReadiness: BuyReadiness;
}
