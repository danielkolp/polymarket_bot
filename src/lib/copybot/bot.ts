import { createHash } from "crypto";
import { config } from "@/lib/config";
import { fetchBook } from "@/lib/polymarket/clob";
import { fetchMarketById } from "@/lib/polymarket/gamma";
import { fetchTradesForWallets, fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { Market, OrderBook, TraderTrade } from "@/lib/polymarket/types";
import { simulateFill, type FillCostSettings, type FillResult } from "./fillModel";
import {
  applyConvictionSizing,
  buildMetrics,
  cumulativeBotPnlUsd,
  calculateAvailableBalance,
  calculateNextTradeSize,
  clampPrice,
  dollarCapFromPercent,
  isBelowTradeMinimum,
  positionExposure,
  totalExposure,
  walletExposure,
} from "./accounting";
import { effectiveMaxCopyAgeSec, evaluateAdverseEntry, type AdverseEntry } from "./entryGuards";
import { planEntry, proportionalSellShares, type EntryPlan } from "./entryPlan";
import { getTokenMarketMeta, roundToTick, takerFeeFraction, tryGetOutcomeBook, type TokenMarketMeta } from "@/lib/polymarket/clobMeta";
import {
  buildLeaderHoldings,
  reconcileLeaderHoldings,
  selectLeaderExitedPositions,
  sourceWalletsOf,
} from "./leaderPositions";
import { fetchUserPositions } from "@/lib/polymarket/positions";
import {
  applyRiskPreset,
  isRiskPresetId,
  presetControlledKeys,
  presetControlledValues,
  RISK_PRESETS,
} from "./riskPresets";
import { assertLiveTradingAllowed, placeLiveMarketOrder, PusdBalanceUnavailableError, type LiveUsdcBalance } from "@/lib/execution/liveClob";
import { clearLiveBalanceCache, getLiveUsdcBalance } from "@/lib/execution/liveBalance";
import { createInitialBotState, todayKey } from "./defaults";
import { recordId } from "./ids";
import { buildRedeemablePlan, makeRedeemRecord } from "./redeemables";
import { assertLiveRedeemAllowed, redeemConditionOnChain } from "@/lib/execution/liveRedeem";
import { buildScoreboard, normalizeSkipReason } from "./scoreboard";
import { reconcileLiveTrades } from "./reconciliation";
import { emptyLiveReconciliation, reconcileLivePositions } from "./livePositions";
import { evaluateBuyReadiness } from "./liveReadiness";
import { LIVE_SELL_DUST, formatLiveSellShares, resolveLiveSellSize } from "./liveSellSizing";
import { applyCopyScores } from "./copyScore";
import { discoverTraders } from "./discovery";
import { analytics, type DecisionCapture } from "@/lib/analytics";
import {
  appendLog,
  clearLogs,
  ensureDataFiles,
  loadBotState,
  loadLogs,
  loadLivePositions,
  loadPositions,
  loadRecentDecisions,
  loadRedeemBook,
  loadSeenTrades,
  clearSkips,
  loadSettings,
  loadTraders,
  loadTrades,
  prependTrade,
  recordRedeemed,
  saveBotState,
  saveLivePositions,
  savePositions,
  saveSeenTrades,
  saveSettings,
  saveTraders,
  saveTrades,
} from "./store";
import { appendEquityPoint, loadEquityCurve, saveEquityCurve } from "./store";
import type {
  BotMetrics,
  BotMode,
  BotPosition,
  BotSettings,
  BotState,
  BotStatus,
  CopyTradeRecord,
  FollowedTrader,
  LivePositionReconciliation,
  LogLevel,
  RedeemablePlan,
  RedeemAttemptResult,
  RedeemRunResult,
  SeenTradeBook,
} from "./types";

const MAX_TRADERS_TO_FOLLOW = 100;
const MAX_WALLETS_PER_POLL = 100;
/** Cap on how many leader wallets we fetch positions for per leader-holdings pass. */
const MAX_LEADER_HOLDINGS_WALLETS = 40;
// The hard 5-minute absolute copy-age ceiling lives in entryGuards
// (MAX_COPY_TRADE_AGE_SEC) and is enforced via effectiveMaxCopyAgeSec().

/**
 * A market we positively know is resolved/closed (or no longer accepting orders)
 * must never be copied into - the leader's trade is on a market that's already
 * settling. Unknown (null) markets are NOT treated as resolved here; other gates
 * (liquidity/spread/time-to-resolution) handle the can't-verify case.
 */
function isMarketResolved(market: Market | null): boolean {
  if (!market) return false;
  return market.closed === true || market.active === false || market.acceptingOrders === false;
}

/**
 * Settlement payout per share (1 = won, 0 = lost) for the outcome `tokenId` in a
 * market that has DEFINITIVELY resolved, or null if it cannot be determined yet.
 *
 * Deliberately stricter than {@link isMarketResolved}: it requires `closed` (a
 * paused or not-accepting market is not necessarily resolved) AND an unambiguous
 * near-binary outcome price. This avoids ever crystallizing a loss against a
 * position whose market is merely halted - when in doubt we return null and the
 * position is retried on a later poll.
 */
export function marketSettlementValue(market: Market | null, tokenId: string): number | null {
  if (!market || market.closed !== true) return null;
  const outcome = market.outcomes.find((o) => o.tokenId === tokenId);
  if (!outcome || outcome.price == null || !Number.isFinite(outcome.price)) return null;
  if (outcome.price >= 0.9) return 1;
  if (outcome.price <= 0.1) return 0;
  return null;
}

function sourceTradeId(trade: TraderTrade): string {
  return [
    trade.txHash || "no-tx",
    trade.wallet,
    trade.tokenId,
    trade.side,
    trade.timestamp,
    trade.price,
    trade.size,
  ].join(":");
}

/** Compact key for the seen-trade book (16 hex chars instead of ~200). */
function seenKey(trade: TraderTrade): string {
  return createHash("sha1").update(sourceTradeId(trade)).digest("hex").slice(0, 16);
}

function normalizeWallet(wallet: string): string {
  return wallet.trim().toLowerCase();
}

function validWallet(wallet: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(wallet);
}

function marketSlug(market: Market | null, trade: TraderTrade): string {
  return market?.slug || trade.conditionId || trade.tokenId;
}

function marketTitle(market: Market | null, trade: TraderTrade): string {
  return market?.question || trade.title || "(market)";
}

function marketLiquidity(market: Market | null): number {
  return market?.liquidity ?? 0;
}

function enabledWallets(traders: FollowedTrader[], limit: number): string[] {
  return traders
    .filter((trader) => trader.enabled && !trader.autoDisabled)
    .map((trader) => trader.wallet)
    .slice(0, limit);
}

function sanitizeNumber(value: number, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function sanitizeSettings(current: BotSettings, patch: Partial<BotSettings>): BotSettings {
  if (patch.mode === "real" && !config.enableRealTrading) {
    throw new Error("ENABLE_REAL_TRADING is false. Refusing to enable real mode.");
  }

  // Risk presets are server-authoritative. Selecting a non-custom preset applies
  // that preset's pinned values; manually editing any field that preset pins
  // (without re-selecting a preset) drops the preset to "custom".
  const selectsPreset = isRiskPresetId(patch.riskPreset) && patch.riskPreset !== "custom";
  const currentPreset = isRiskPresetId(current.riskPreset) ? RISK_PRESETS[current.riskPreset] : RISK_PRESETS.custom;
  const editsPresetField = presetControlledKeys(currentPreset).some(
    (key) => patch[key] !== undefined && patch[key] !== current[key],
  );

  let resolvedPreset: BotSettings["riskPreset"];
  let presetValues: Partial<BotSettings> = {};
  if (selectsPreset) {
    resolvedPreset = patch.riskPreset as BotSettings["riskPreset"];
    presetValues = presetControlledValues(RISK_PRESETS[resolvedPreset]);
  } else if (editsPresetField) {
    resolvedPreset = "custom";
  } else {
    resolvedPreset = isRiskPresetId(patch.riskPreset) ? patch.riskPreset : current.riskPreset;
  }

  const next: BotSettings = {
    ...current,
    ...patch,
    ...presetValues,
    mode: patch.mode === "real" ? "real" : patch.mode === "simulation" ? "simulation" : current.mode,
    sizingMode:
      patch.sizingMode === "fixed" || patch.sizingMode === "percentage" || patch.sizingMode === "hybrid"
        ? patch.sizingMode
        : current.sizingMode,
    riskPreset: resolvedPreset,
    sellBehavior: patch.sellBehavior === "all" ? "all" : patch.sellBehavior === "proportional" ? "proportional" : current.sellBehavior,
    sizingSignalMode:
      patch.sizingSignalMode === "leader-size-weighted" || patch.sizingSignalMode === "local-fixed"
        ? patch.sizingSignalMode
        : current.sizingSignalMode,
  };

  // Re-pin preset-controlled fields after numeric sanitation so a non-custom
  // preset is always authoritative (idempotent; a no-op for custom).
  return applyRiskPreset({
    ...next,
    riskPreset: next.riskPreset,
    startingBalance: sanitizeNumber(next.startingBalance, current.startingBalance, 1),
    pollingIntervalSec: sanitizeNumber(next.pollingIntervalSec, current.pollingIntervalSec, 5, 3600),
    topTradersToFollow: Math.round(
      sanitizeNumber(next.topTradersToFollow, current.topTradersToFollow, 1, MAX_TRADERS_TO_FOLLOW),
    ),
    fixedCopyAmountUsd: sanitizeNumber(next.fixedCopyAmountUsd, current.fixedCopyAmountUsd, 0.01),
    percentageCopySize: sanitizeNumber(next.percentageCopySize, current.percentageCopySize, 0.01, 100),
    minTradeAmountUsd: sanitizeNumber(next.minTradeAmountUsd, current.minTradeAmountUsd, 0),
    maxTradeAmountUsd: sanitizeNumber(next.maxTradeAmountUsd, current.maxTradeAmountUsd, 0.01),
    maxExposurePerMarketPercent: sanitizeNumber(
      next.maxExposurePerMarketPercent,
      current.maxExposurePerMarketPercent,
      0.01,
      100,
    ),
    maxTotalExposurePercent: sanitizeNumber(next.maxTotalExposurePercent, current.maxTotalExposurePercent, 0.01, 100),
    maxDailyLossPercent: sanitizeNumber(next.maxDailyLossPercent, current.maxDailyLossPercent, 0.01, 100),
    minAvailableBalanceUsd: sanitizeNumber(next.minAvailableBalanceUsd, current.minAvailableBalanceUsd, 0),
    minTraderWeeklyVolumeUsd: sanitizeNumber(next.minTraderWeeklyVolumeUsd, current.minTraderWeeklyVolumeUsd, 0),
    minTraderTradeCount: Math.round(sanitizeNumber(next.minTraderTradeCount, current.minTraderTradeCount, 0, 1000)),
    maxTraderInactivityHours: sanitizeNumber(next.maxTraderInactivityHours, current.maxTraderInactivityHours, 0.25, 168),
    minMarketLiquidityUsd: sanitizeNumber(next.minMarketLiquidityUsd, current.minMarketLiquidityUsd, 0),
    minBuyTokenPrice: sanitizeNumber(next.minBuyTokenPrice, current.minBuyTokenPrice, 0, 1),
    maxBuyTokenPrice: sanitizeNumber(next.maxBuyTokenPrice, current.maxBuyTokenPrice, 0, 1),
    maxMarketSpread: sanitizeNumber(next.maxMarketSpread, current.maxMarketSpread, 0, 1),
    minTimeToResolutionMinutes: sanitizeNumber(next.minTimeToResolutionMinutes, current.minTimeToResolutionMinutes, 0, 525600),
    maxTradeAgeSec: sanitizeNumber(next.maxTradeAgeSec, current.maxTradeAgeSec, 5, 86400),
    maxAdverseEntryMoveCents: sanitizeNumber(next.maxAdverseEntryMoveCents, current.maxAdverseEntryMoveCents, 0, 100),
    liveMaxCopyTradeAgeSec: sanitizeNumber(next.liveMaxCopyTradeAgeSec, current.liveMaxCopyTradeAgeSec, 5, 900),
    exitWhenLeaderNoLongerHolds:
      typeof next.exitWhenLeaderNoLongerHolds === "boolean" ? next.exitWhenLeaderNoLongerHolds : current.exitWhenLeaderNoLongerHolds,
    traderRefreshIntervalMin: sanitizeNumber(next.traderRefreshIntervalMin, current.traderRefreshIntervalMin, 1, 1440),
    maxCopiesPerWalletPerCycle: Math.round(sanitizeNumber(next.maxCopiesPerWalletPerCycle, current.maxCopiesPerWalletPerCycle, 0, 1000)),
    maxExposurePerWalletPercent: sanitizeNumber(next.maxExposurePerWalletPercent, current.maxExposurePerWalletPercent, 0, 100),
    walletTradeCooldownSec: sanitizeNumber(next.walletTradeCooldownSec, current.walletTradeCooldownSec, 0, 86400),
    sessionOnly: typeof next.sessionOnly === "boolean" ? next.sessionOnly : current.sessionOnly,
    autoExitTakeProfitPercent: sanitizeNumber(next.autoExitTakeProfitPercent, current.autoExitTakeProfitPercent, 0, 10000),
    autoExitStopLossPercent: sanitizeNumber(next.autoExitStopLossPercent, current.autoExitStopLossPercent, 0, 100),
    autoExitMaxHoldMinutes: sanitizeNumber(next.autoExitMaxHoldMinutes, current.autoExitMaxHoldMinutes, 0, 100000),
    realisticFills: typeof next.realisticFills === "boolean" ? next.realisticFills : current.realisticFills,
    takerFeeBps: sanitizeNumber(next.takerFeeBps, current.takerFeeBps, 0, 10000),
    maxSlippageBps: sanitizeNumber(next.maxSlippageBps, current.maxSlippageBps, 1, 10000),
    fallbackSpreadBps: sanitizeNumber(next.fallbackSpreadBps, current.fallbackSpreadBps, 0, 10000),
    sizingBase: next.sizingBase === "equity" ? "equity" : next.sizingBase === "cash" ? "cash" : current.sizingBase ?? "cash",
    maxOpenPositions: Math.round(sanitizeNumber(next.maxOpenPositions, current.maxOpenPositions ?? 0, 0, 200)),
    cashReservePercent: sanitizeNumber(next.cashReservePercent, current.cashReservePercent ?? 0, 0, 90),
    maxEntryCostPercent: sanitizeNumber(next.maxEntryCostPercent, current.maxEntryCostPercent ?? 0, 0, 50),
    maxDrawdownPausePercent: sanitizeNumber(next.maxDrawdownPausePercent, current.maxDrawdownPausePercent ?? 0, 0, 95),
    maxHoursToResolution: sanitizeNumber(next.maxHoursToResolution, current.maxHoursToResolution ?? 0, 0, 24 * 365),
    consensusBoost: typeof next.consensusBoost === "boolean" ? next.consensusBoost : current.consensusBoost ?? false,
    depositBaselineUsd: sanitizeNumber(next.depositBaselineUsd, current.depositBaselineUsd ?? 0, 0, 10_000_000),
  });
}

/**
 * Overlay the traded OUTCOME's own book on the Gamma market. Gamma's
 * bestBid/bestAsk describe the market's first outcome only, so using them for a
 * "No" token mis-prices every check downstream (spread, adverse move, refs).
 */
function withOutcomeQuotes(market: Market | null, book: OrderBook | null): Market | null {
  if (!market || !book) return market;
  if (book.bestBid == null && book.bestAsk == null) return market;
  return {
    ...market,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    midpoint: book.midpoint,
    spread: book.spread ?? market.spread,
  };
}

const CONSENSUS_WINDOW_MS = 60 * 60 * 1000;
const CONSENSUS_SIZE_MULTIPLIER = 1.5;

function marketSpreadForFilter(market: Market | null): number | null {
  if (!market) return null;
  if (market.bestBid != null && market.bestAsk != null) return Math.max(0, market.bestAsk - market.bestBid);
  return market.spread > 0 ? market.spread : null;
}

function buyMarketFilterReason(settings: BotSettings, trade: TraderTrade, market: Market | null): string | null {
  if (trade.side !== "BUY") return null;
  if (trade.price < settings.minBuyTokenPrice) {
    return "Skipped BUY: token price " + (trade.price * 100).toFixed(1) + "c is below the minimum " + (settings.minBuyTokenPrice * 100).toFixed(1) + "c.";
  }
  if (trade.price > settings.maxBuyTokenPrice) {
    return "Skipped BUY: token price " + (trade.price * 100).toFixed(1) + "c is above the maximum " + (settings.maxBuyTokenPrice * 100).toFixed(1) + "c.";
  }

  const spread = marketSpreadForFilter(market);
  if (settings.maxMarketSpread > 0 && spread != null && spread > settings.maxMarketSpread) {
    return "Skipped BUY: market spread " + (spread * 100).toFixed(1) + "c exceeds the maximum " + (settings.maxMarketSpread * 100).toFixed(1) + "c.";
  }

  if (
    settings.minTimeToResolutionMinutes > 0 &&
    market?.timeToResolutionMs != null &&
    market.timeToResolutionMs <= settings.minTimeToResolutionMinutes * 60 * 1000
  ) {
    return "Skipped BUY: market resolves within " + settings.minTimeToResolutionMinutes.toFixed(0) + " minute(s).";
  }

  return null;
}

type CostExtra = Pick<
  CopyTradeRecord,
  "effectivePrice" | "referencePrice" | "feeUsd" | "frictionUsd" | "fillStatus" | "costSource"
>;

/** Source of a non-copy exit (session liquidation, auto-exit rule, leader-exit, or panic). */
type ExitSource = "session-close" | "auto-exit" | "panic-flatten" | "manual-flatten" | "leader-exit";

/**
 * Outcome of a flatten / sell-all pass.
 *  - `closed`: positions fully (or partially) sold this pass;
 *  - `failed`: positions whose live SELL was rejected/errored and were kept;
 *  - `skipped`: positions intentionally left (manual/unknown or resolved/auto-redeeming).
 */
interface FlattenResult {
  closed: number;
  proceedsUsd: number;
  realizedPnlUsd: number;
  failed: number;
  skipped: number;
}

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Live-data integrity gate for a leader-exit SELL. Selling is allowed during
 * panic / daily-loss lockout (those block BUYs, not exits), but NOT while live
 * data is untrustworthy: no/failed live-position snapshot, a stale snapshot, or
 * any unmatched/errored live order. Returns ok:false with a reason otherwise.
 */
function liveExitHealth(
  snapshot: LivePositionReconciliation | null,
  trades: CopyTradeRecord[],
  now: number,
): { ok: boolean; reason: string } {
  if (!snapshot || !snapshot.ok) return { ok: false, reason: "live positions not reconciled" };
  if (now - snapshot.fetchedAt > config.livePositionsStaleSeconds * 1000) {
    return { ok: false, reason: "live position snapshot is stale" };
  }
  const blocked = trades.some(
    (t) =>
      t.mode === "real" &&
      t.status === "copied" &&
      (t.reconciliationStatus === "unmatched" || t.reconciliationStatus === "error"),
  );
  if (blocked) return { ok: false, reason: "unmatched/errored live orders present" };
  return { ok: true, reason: "" };
}

function reconcileLiveBalanceMetrics(settings: BotSettings, metrics: BotMetrics, liveBalance: LiveUsdcBalance): BotMetrics {
  const liveCashUsd = liveBalance.usdcBalance;
  const liveEquityUsd = liveCashUsd + metrics.totalExposureUsd;
  const balanceDifference = liveEquityUsd - metrics.localTrackedEquity;
  const liveStrategySize = calculateNextTradeSize(settings, liveCashUsd);
  const liveNextTradeSizeUsd = Math.min(liveStrategySize, config.liveMaxOrderUsd, Math.max(0, liveCashUsd));

  return {
    ...metrics,
    cashUsd: liveCashUsd,
    availableBalanceUsd: Math.max(0, liveCashUsd),
    equityUsd: liveEquityUsd,
    cashUsdAuthoritative: liveCashUsd,
    nextTradeSizeUsd: liveNextTradeSizeUsd,
    liveUsdcBalance: liveCashUsd,
    balanceDifference,
    lastLiveBalanceCheck: liveBalance.updatedAt,
    liveBalanceStatus: Math.abs(balanceDifference) > config.liveBalanceWarningThresholdUsd ? "warning" : "ok",
    liveBalanceError: null,
  };
}

async function buildStatusMetrics(settings: BotSettings, metrics: BotMetrics, knownBalance?: LiveUsdcBalance | null): Promise<BotMetrics> {
  // Show live balance info in both real and simulation mode so sim acts as a
  // live-mode preview. A funder address is enough for read-only pUSD balance.
  if (!config.livePrivateKey.trim() && !config.liveFunderAddress.trim()) {
    return settings.mode === "real"
      ? {
          ...metrics,
          liveBalanceStatus: "error",
          liveBalanceError: "Live balance unavailable: set POLYMARKET_PRIVATE_KEY or POLYMARKET_FUNDER_ADDRESS.",
        }
      : metrics;
  }

  if (settings.mode === "real" && !config.enableRealTrading) {
    return {
      ...metrics,
      liveBalanceStatus: "error",
      liveBalanceError: "Live balance unavailable: real trading is not fully configured.",
    };
  }

  try {
    const lb = knownBalance ?? await getLiveUsdcBalance();
    return reconcileLiveBalanceMetrics(settings, metrics, lb);
  } catch (err) {
    if (err instanceof PusdBalanceUnavailableError) {
      return {
        ...metrics,
        liveBalanceStatus: settings.mode === "real" ? "error" : "unknown",
        liveBalanceError:
          settings.mode === "real"
            ? "Live pUSD balance is unreadable; real trading is blocked until cash balance can be fetched."
            : "pUSD live balance unavailable; simulation is using paper/local accounting.",
      };
    }
    return {
      ...metrics,
      liveBalanceStatus: "error",
      liveBalanceError: "Live balance unavailable: " + messageFromUnknown(err),
    };
  }
}
function fillToExtra(fill: FillResult): CostExtra {
  return {
    effectivePrice: fill.filledShares > 0 ? (fill.notionalUsd + fill.feeUsd) / fill.filledShares : undefined,
    referencePrice: fill.referenceMid,
    feeUsd: fill.feeUsd,
    frictionUsd: fill.frictionUsd,
    fillStatus: fill.status,
    costSource: fill.costSource,
  };
}

function makeRecord(
  trade: TraderTrade,
  status: CopyTradeRecord["status"],
  mode: BotMode,
  copyAmountUsd: number,
  copiedShares: number,
  realizedPnlUsd: number,
  reason: string,
  market: Market | null,
  now: number,
  extra?: Partial<CopyTradeRecord>,
): CopyTradeRecord {
  return {
    id: recordId(now),
    sourceTradeId: sourceTradeId(trade),
    status,
    mode,
    traderWallet: trade.wallet,
    traderName: trade.traderName,
    side: trade.side,
    tokenId: trade.tokenId,
    conditionId: trade.conditionId,
    marketSlug: marketSlug(market, trade),
    marketTitle: marketTitle(market, trade),
    outcome: trade.outcome,
    price: clampPrice(trade.price),
    sourceSize: trade.size,
    sourceAmountUsd: Math.max(0, trade.price * trade.size),
    copyAmountUsd,
    copiedShares,
    realizedPnlUsd,
    reason,
    txOrOrderId: trade.txHash,
    sourceTimestamp: trade.timestamp * 1000,
    processedAt: now,
    ...extra,
  };
}

/**
 * Build a simulated SELL record for an exit that is not driven by a followed
 * trader's trade - i.e. a session-close liquidation or an auto-exit rule firing.
 */
function makeExitRecord(
  position: BotPosition,
  price: number,
  shares: number,
  copyAmountUsd: number,
  realizedPnlUsd: number,
  reason: string,
  source: ExitSource,
  now: number,
): CopyTradeRecord {
  return {
    id: recordId(now),
    sourceTradeId: `${source}:${position.tokenId}:${now}`,
    status: "simulated",
    mode: "simulation",
    traderWallet: position.sourceWallets[0] ?? "",
    traderName: source,
    side: "SELL",
    tokenId: position.tokenId,
    conditionId: position.conditionId,
    marketSlug: position.marketSlug,
    marketTitle: position.marketTitle,
    outcome: position.outcome,
    price: clampPrice(price),
    sourceSize: shares,
    sourceAmountUsd: copyAmountUsd,
    copyAmountUsd,
    copiedShares: shares,
    realizedPnlUsd,
    reason,
    txOrOrderId: "",
    sourceTimestamp: now,
    processedAt: now,
  };
}

/**
 * Build a simulated SELL record that realizes a position at market resolution -
 * the winning outcome pays $1/share and the loser $0. Unlike a mark-priced exit
 * the settlement price is exact (not clamped to the 0.01–0.99 trading band), so
 * cash credited and realized P&L reflect the true payout.
 */
function makeSettlementRecord(
  position: BotPosition,
  settlementValue: number,
  realizedPnlUsd: number,
  now: number,
): CopyTradeRecord {
  const proceedsUsd = position.shares * settlementValue;
  const won = settlementValue >= 0.5;
  return {
    id: recordId(now),
    sourceTradeId: `resolution-settlement:${position.tokenId}:${now}`,
    status: "simulated",
    mode: "simulation",
    traderWallet: position.sourceWallets[0] ?? "",
    traderName: "settlement",
    side: "SELL",
    tokenId: position.tokenId,
    conditionId: position.conditionId,
    marketSlug: position.marketSlug,
    marketTitle: position.marketTitle,
    outcome: position.outcome,
    price: settlementValue,
    sourceSize: position.shares,
    sourceAmountUsd: proceedsUsd,
    copyAmountUsd: proceedsUsd,
    copiedShares: position.shares,
    realizedPnlUsd,
    reason:
      `Market resolved ${won ? "in favor of" : "against"} ${position.outcome}: settled ` +
      `${position.shares.toFixed(2)} share(s) @ $${settlementValue.toFixed(2)} ` +
      `(realized ${realizedPnlUsd >= 0 ? "+" : ""}${realizedPnlUsd.toFixed(2)}).`,
    txOrOrderId: "",
    sourceTimestamp: now,
    processedAt: now,
  };
}

/** Add `shares` at effective `avgPrice` (fee-folded), marking at the current mid. */
function applyBuy(
  positions: BotPosition[],
  trade: TraderTrade,
  market: Market | null,
  shares: number,
  avgPrice: number,
  markPrice: number,
  now: number,
): BotPosition[] {
  const existing = positions.find((position) => position.tokenId === trade.tokenId);
  if (!existing) {
    return [
      ...positions,
      {
        tokenId: trade.tokenId,
        conditionId: trade.conditionId,
        marketSlug: marketSlug(market, trade),
        marketTitle: marketTitle(market, trade),
        outcome: trade.outcome,
        shares,
        avgPrice,
        markPrice,
        realizedPnlUsd: 0,
        openedAt: now,
        updatedAt: now,
        sourceWallets: [trade.wallet],
      },
    ];
  }

  const totalCost = existing.avgPrice * existing.shares + avgPrice * shares;
  const totalShares = existing.shares + shares;
  return positions.map((position) =>
    position.tokenId === trade.tokenId
      ? {
          ...position,
          shares: totalShares,
          avgPrice: totalShares > 0 ? totalCost / totalShares : avgPrice,
          markPrice,
          updatedAt: now,
          sourceWallets: [...new Set([...position.sourceWallets, trade.wallet])],
        }
      : position,
  );
}

/** Reduce a position by `sharesToSell`, realizing P&L net of the sell fee. */
function applySell(
  positions: BotPosition[],
  trade: TraderTrade,
  sharesToSell: number,
  fillPrice: number,
  feeUsd: number,
  markPrice: number,
  now: number,
): { positions: BotPosition[]; copiedShares: number; copyAmountUsd: number; realizedPnlUsd: number } {
  const existing = positions.find((position) => position.tokenId === trade.tokenId);
  if (!existing || existing.shares <= 0) {
    return { positions, copiedShares: 0, copyAmountUsd: 0, realizedPnlUsd: 0 };
  }

  const shares = Math.min(existing.shares, sharesToSell);
  const copyAmountUsd = Math.max(0, shares * fillPrice - feeUsd); // net cash received
  const realizedPnlUsd = copyAmountUsd - existing.avgPrice * shares;
  const remainingShares = existing.shares - shares;
  const nextPositions =
    remainingShares <= 0.000001
      ? positions.filter((position) => position.tokenId !== trade.tokenId)
      : positions.map((position) =>
          position.tokenId === trade.tokenId
            ? {
                ...position,
                shares: remainingShares,
                markPrice,
                realizedPnlUsd: position.realizedPnlUsd + realizedPnlUsd,
                updatedAt: now,
              }
            : position,
        );

  return { positions: nextPositions, copiedShares: shares, copyAmountUsd, realizedPnlUsd };
}

/**
 * Fresh outcome-book pricing for a live exit SELL: reference = best bid, worst
 * acceptable price = 3 ticks under it. Falls back to the mark when no book.
 */
async function liveExitPricing(
  tokenId: string,
  conditionId: string,
  fallbackPrice: number,
): Promise<{ referencePrice: number; limitPrice: number }> {
  const [book, meta] = await Promise.all([
    tryGetOutcomeBook(tokenId, 2_000),
    getTokenMarketMeta(tokenId, conditionId).catch(() => null),
  ]);
  const tick = meta?.tickSize ?? 0.01;
  const ref = book?.bestBid != null && book.bestBid > 0 ? book.bestBid : fallbackPrice;
  return { referencePrice: ref, limitPrice: roundToTick(ref - 3 * tick, tick, "up") };
}

/** A poll running longer than this is considered hung and is abandoned. */
const MIN_STUCK_TICK_MS = 120_000;
const WATCHDOG_INTERVAL_MS = 30_000;
/** Minimum pause between the end of one poll and the start of the next. */
const MIN_POLL_GAP_MS = 1_000;
const RESUME_RETRY_MS = 60_000;

/** Fields only the operator controls; a running poll must never overwrite them. */
function withControlFields(next: BotState, fresh: BotState): BotState {
  return {
    ...next,
    runState: fresh.runState,
    startedAt: fresh.startedAt,
    stoppedAt: fresh.stoppedAt,
    pausedAt: fresh.pausedAt,
    panic: fresh.panic,
    panicAt: fresh.panicAt,
    panicReason: fresh.panicReason,
    desiredRunState: fresh.desiredRunState,
    nextPollAt: fresh.runState === "running" || fresh.runState === "draining" ? next.nextPollAt : null,
  };
}

export class CopyBotEngine {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  /** When the in-flight poll started (ms epoch). */
  private tickStartedAt = 0;
  /** Incremented per poll; an abandoned (hung) poll sees a newer value and stops writing. */
  private tickGeneration = 0;
  private watchdog: NodeJS.Timeout | null = null;
  /** In-memory mirror of what the operator asked for (authoritative for scheduling). */
  private desired: BotState["runState"] | null = null;
  private pollIntervalMs = 30_000;
  private resumePromise: Promise<void> | null = null;
  private resumeChecked = false;
  /** tokenId -> (wallet -> last BUY seen ms) for the consensus sizing boost. */
  private recentLeaderBuys = new Map<string, Map<string, number>>();
  private lastHeartbeatLogAt = 0;
  private buyExposurePaused = false;
  // Analytics-only cadence guards (observational; never gate trading).
  private lastAnalyticsSnapshotAt = 0;
  private lastAnalyticsMaintenanceAt = 0;

  async status(): Promise<BotStatus> {
    await ensureDataFiles();
    const settings = await loadSettings();
    const [state, traders, positions, trades, recentDecisions, equityCurve, logs, bullpen, livePositions, redeemBook] = await Promise.all([
      loadBotState(settings),
      loadTraders(),
      loadPositions(),
      loadTrades(),
      loadRecentDecisions(300),
      loadEquityCurve(settings),
      loadLogs(),
      // Legacy Bullpen CLI probe removed (it spawned a child process every few
      // minutes); kept in the payload shape for older dashboards.
      Promise.resolve({ available: false, checkedAt: null, helpText: null, error: null }),
      loadLivePositions(),
      loadRedeemBook(),
    ]);
    // Fetch live balance so buildMetrics anchors equity to the real wallet in
    // both real and sim mode (sim acts as a live-mode preview when key is set).
    let statusLiveBalance: LiveUsdcBalance | null = null;
    if (config.livePrivateKey.trim() || config.liveFunderAddress.trim()) {
      try { statusLiveBalance = await getLiveUsdcBalance(); } catch (err) {
        if (!(err instanceof PusdBalanceUnavailableError)) {
          await appendLog("error", "Live balance fetch failed: " + messageFromUnknown(err));
        }
      }
    }
    const built = buildMetrics(settings, state, positions, trades, Date.now(), statusLiveBalance?.usdcBalance);
    const statusMetrics = await buildStatusMetrics(settings, built.metrics, statusLiveBalance);
    // Display-only: daily/peak roll-overs are persisted by the poll loop, never
    // here (a status read racing a poll must not write stale state).
    const statusState = built.state;

    // The process restarted while the operator wanted the bot running: bring it
    // back (normally done at boot by instrumentation.ts; this is the fallback).
    if ((statusState.runState === "running" || statusState.runState === "draining") && !this.timer && !this.inFlight) {
      void this.resumeIfDesired();
    }

    const scoreboard = buildScoreboard(settings, statusState, statusMetrics, positions, recentDecisions);
    const buyReadiness = evaluateBuyReadiness({
      settings,
      state: statusState,
      trades,
      livePositions: settings.mode === "real" ? livePositions : null,
    });

    return {
      state: statusState,
      settings,
      metrics: statusMetrics,
      scoreboard,
      buyReadiness,
      realTradingEnabled: config.enableRealTrading,
      simulationOnly: !config.enableRealTrading || settings.mode === "simulation",
      bullpen,
      traders,
      positions,
      recentTrades: recentDecisions.slice(0, 100),
      equityCurve,
      logs,
      livePositions: settings.mode === "real" ? livePositions : null,
      redeemables: buildRedeemablePlan(settings.mode === "real" ? livePositions : null, redeemBook, settings.mode),
    };
  }

  async start(opts: { resumed?: boolean } = {}): Promise<BotStatus> {
    await this.startEngine(opts);
    return this.status();
  }

  /**
   * Start (or, after a restart, resume) the poll loop. Throws when start is not
   * allowed (panic latched, live trading misconfigured, balance unreadable).
   */
  private async startEngine(opts: { resumed?: boolean } = {}): Promise<void> {
    let settings = await loadSettings();

    // Refuse to start while a panic stop is latched. By default the operator must
    // explicitly clear it (manual resume); only when that guard is disabled do we
    // auto-clear panic on an explicit Start.
    const panicState = await loadBotState(settings);
    if (panicState.panic) {
      if (config.liveRequireManualResumeAfterPanic) {
        const reason = "Start blocked: panic stop is engaged. Clear panic (resume) before starting.";
        await appendLog("error", reason);
        throw new Error(reason);
      }
      await saveBotState({ ...panicState, panic: false, panicAt: null, panicReason: null });
      await appendLog("warning", "Panic stop auto-cleared on Start (LIVE_REQUIRE_MANUAL_RESUME_AFTER_PANIC=false).");
    }

    let startupLiveBalance: LiveUsdcBalance | null = null;
    if (settings.mode === "real") {
      try {
        assertLiveTradingAllowed();
        startupLiveBalance = await getLiveUsdcBalance({ forceRefresh: true });
      } catch (err) {
        const reason = "Real trading start blocked: " + messageFromUnknown(err);
        await appendLog("error", reason);
        throw new Error(reason);
      }
      // Real mode must never start blind: reconcile prior-session live fills and
      // load authoritative account positions before any new copy trade.
      await this.reconcileLiveOrders("startup");
      await this.reconcileLivePositionsState("startup");
    }

    let state = await loadBotState(settings);
    const now = Date.now();
    if (settings.mode === "real" && startupLiveBalance) {
      const [positions, trades] = await Promise.all([loadPositions(), loadTrades()]);
      const liveEquityUsd = startupLiveBalance.usdcBalance + totalExposure(positions);
      const dailyStartBotPnlUsd = cumulativeBotPnlUsd(positions, trades);
      // Tie the local startingBalance baseline to the live wallet so the operator
      // never has to hand-edit it. Trade sizing is already driven off live cash;
      // startingBalance only feeds the real-mode reserve floor (25% of it) and the
      // ROI denominator, both of which are wrong if the seed default lingers while
      // real cash differs. Resync here, consistent with the equity baselines below.
      if (Math.abs(settings.startingBalance - liveEquityUsd) > 0.01) {
        const prev = settings.startingBalance;
        settings = sanitizeSettings(settings, { startingBalance: liveEquityUsd });
        await saveSettings(settings);
        await appendLog(
          "info",
          `Starting balance auto-synced to live wallet: $${prev.toFixed(2)} → $${settings.startingBalance.toFixed(2)}.`,
        );
      }
      // A restart (or Stop/Start) on the same UTC day must NOT clear the daily
      // loss lockout or move the day's baseline — only a new day does.
      const sameDay = state.dailyDate === todayKey(now);
      state = {
        ...state,
        dailyDate: todayKey(now),
        dailyStartEquityUsd: sameDay && state.dailyStartEquityUsd > 0 ? state.dailyStartEquityUsd : liveEquityUsd,
        dailyStartBotPnlUsd: sameDay ? state.dailyStartBotPnlUsd : dailyStartBotPnlUsd,
        peakEquityUsd: opts.resumed ? Math.max(state.peakEquityUsd || 0, liveEquityUsd) : liveEquityUsd,
        dailyLossLockout: sameDay ? state.dailyLossLockout : false,
      };
      await appendLog(
        "info",
        `Real bankroll synced from live balance: cash $${startupLiveBalance.usdcBalance.toFixed(2)}, equity $${liveEquityUsd.toFixed(2)}.`,
      );
    }
    // Refresh the followed-trader roster before going live. A discovery failure
    // (upstream outage) keeps the previous roster instead of blocking the start.
    try {
      await this.discover(true);
    } catch (err) {
      await appendLog("warning", `Trader discovery failed on start (${messageFromUnknown(err)}); keeping the previous roster.`);
    }
    try {
      await this.bootstrapSeenTrades();
    } catch (err) {
      await appendLog("warning", `Could not pre-mark recent trades as seen: ${messageFromUnknown(err)}.`);
    }

    state = {
      ...(await loadBotState(settings)),
      dailyDate: state.dailyDate,
      dailyStartEquityUsd: state.dailyStartEquityUsd,
      dailyStartBotPnlUsd: state.dailyStartBotPnlUsd,
      peakEquityUsd: state.peakEquityUsd,
      dailyLossLockout: state.dailyLossLockout,
      runState: "running",
      desiredRunState: "running",
      startedAt: opts.resumed && state.startedAt ? state.startedAt : now,
      stoppedAt: null,
      pausedAt: null,
      nextPollAt: now + settings.pollingIntervalSec * 1000,
      lastError: null,
      sessionWalletsChecked: opts.resumed ? state.sessionWalletsChecked : 0,
      sessionTradesScanned: opts.resumed ? state.sessionTradesScanned : 0,
    };
    await saveBotState(state);
    this.desired = "running";
    this.pollIntervalMs = settings.pollingIntervalSec * 1000;
    await appendLog("info", opts.resumed ? `Bot resumed automatically in ${settings.mode} mode.` : `Bot started in ${settings.mode} mode.`);
    this.ensureWatchdog();
    this.schedule(0);
  }

  /**
   * Bring the loop back after a process restart if the operator last asked for
   * it to run. Never overrides a panic stop. Retries every minute on failure
   * (e.g. Polymarket briefly unreachable at boot).
   */
  async resumeIfDesired(): Promise<void> {
    if (this.resumePromise) return this.resumePromise;
    if (this.resumeChecked && (this.timer || this.inFlight || this.desired)) return;
    this.resumePromise = (async () => {
      try {
        await ensureDataFiles();
        const settings = await loadSettings();
        const state = await loadBotState(settings);
        const desired =
          state.desiredRunState ??
          (state.runState === "running" || state.runState === "draining" ? state.runState : "stopped");
        this.resumeChecked = true;
        if (this.timer || this.inFlight) return;
        if (desired !== "running" && desired !== "draining") return;
        if (state.panic) {
          await appendLog("warning", "Not auto-resuming after restart: panic stop is engaged.");
          await saveBotState({ ...state, runState: "stopped", desiredRunState: "stopped", nextPollAt: null });
          return;
        }
        if (desired === "draining") {
          this.desired = "draining";
          this.pollIntervalMs = settings.pollingIntervalSec * 1000;
          await saveBotState({ ...state, runState: "draining", desiredRunState: "draining" });
          await appendLog("info", "Server restarted: resuming exit-only (draining) mode.");
          this.ensureWatchdog();
          this.schedule(0);
          return;
        }
        await appendLog("info", "Server restarted: resuming the bot automatically.");
        await this.startEngine({ resumed: true });
      } catch (err) {
        await appendLog("error", `Auto-resume failed (${messageFromUnknown(err)}); retrying in 60s.`).catch(() => undefined);
        this.resumeChecked = false;
        setTimeout(() => void this.resumeIfDesired(), RESUME_RETRY_MS).unref?.();
      } finally {
        this.resumePromise = null;
      }
    })();
    return this.resumePromise;
  }

  /** Lightweight liveness info for /api/health and the systemd watchdog. */
  health(): { desired: string | null; timerArmed: boolean; inFlight: boolean; tickAgeMs: number | null; pollIntervalMs: number } {
    return {
      desired: this.desired,
      timerArmed: this.timer != null,
      inFlight: this.inFlight,
      tickAgeMs: this.inFlight ? Date.now() - this.tickStartedAt : null,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  async forceDiscover(): Promise<BotStatus> {
    await this.discover(true);
    return this.status();
  }

  async pause(): Promise<BotStatus> {
    this.desired = "paused";
    this.clearTimer();
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    await saveBotState({ ...state, runState: "paused", desiredRunState: "paused", pausedAt: Date.now(), nextPollAt: null });
    await appendLog("info", "Bot paused.");
    return this.status();
  }

  async stop(opts: { liquidate?: boolean; source?: ExitSource } = {}): Promise<BotStatus> {
    this.desired = "stopped";
    this.clearTimer();
    const settings = await loadSettings();
    let liq: FlattenResult | null = null;
    if (opts.liquidate) {
      liq = await this.flatten(opts.source ?? "session-close");
    }
    const state = await loadBotState(settings);
    await saveBotState({ ...state, runState: "stopped", desiredRunState: "stopped", stoppedAt: Date.now(), pausedAt: null, nextPollAt: null });
    await appendLog(
      "info",
      liq
        ? `Bot stopped. Sell-all: ${liq.closed} closed` +
            (liq.failed ? `, ${liq.failed} failed (kept for retry)` : "") +
            (liq.skipped ? `, ${liq.skipped} left (manual/resolved)` : "") +
            "."
        : "Bot stopped.",
    );
    return this.status();
  }

  /**
   * Emergency kill switch. Immediately halts the poll loop, latches a persisted
   * `panic` state (so a restart never silently resumes trading), and refuses all
   * new BUYs until explicitly cleared. Reads, SELLs, and flattening still work.
   * Flattening open positions requires the confirmation text "FLATTEN".
   */
  async panic(opts: { flatten?: boolean; confirmFlatten?: string; reason?: string } = {}): Promise<BotStatus> {
    this.desired = "stopped";
    this.clearTimer();
    const settings = await loadSettings();
    let state = await loadBotState(settings);
    const now = Date.now();
    const reason = opts.reason?.trim() || "Panic stop engaged by operator.";

    state = {
      ...state,
      runState: "stopped",
      desiredRunState: "stopped",
      stoppedAt: now,
      pausedAt: null,
      nextPollAt: null,
      panic: true,
      panicAt: now,
      panicReason: reason,
      lastError: null,
    };
    await saveBotState(state);
    await appendLog("error", `PANIC STOP: ${reason} All new BUYs are disabled until panic is cleared.`);

    if (opts.flatten) {
      if (opts.confirmFlatten !== "FLATTEN") {
        await appendLog(
          "warning",
          'Panic flatten requested without the confirmation text "FLATTEN"; positions were NOT liquidated.',
        );
      } else {
        await this.flatten("panic-flatten");
      }
    }

    return this.status();
  }

  /**
   * Clear a latched panic stop. Leaves the bot stopped - the operator must Start
   * again deliberately. Does not place any order.
   */
  async resumeFromPanic(): Promise<BotStatus> {
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    if (!state.panic) {
      await appendLog("info", "Resume requested but no panic stop was active.");
      return this.status();
    }
    await saveBotState({ ...state, panic: false, panicAt: null, panicReason: null });
    await appendLog("info", "Panic stop cleared. Bot remains stopped; click Start to resume.");
    return this.status();
  }

  /**
   * Pull live Polymarket marks for every open position on demand and recompute
   * equity. Works in any run state, so the user can see current P&L even while
   * the bot is stopped or paused.
   */
  async refreshMarks(): Promise<BotStatus> {
    const settings = await loadSettings();

    // Real mode: re-sync against the authoritative live account FIRST, so any
    // position closed manually on Polymarket (or settled / redeemed) is dropped
    // from the local ledger and exposure reflects reality. This is the on-demand
    // counterpart of the per-poll reconciliation, so the book stays correct even
    // while the bot is stopped. Read-only - it never places an order, and it logs
    // (rather than throws) on a live-data error so stale positions aren't wiped on
    // a transient blip.
    if (settings.mode === "real") {
      await this.reconcileLivePositionsState("refresh-marks");
    }

    let positions = await loadPositions();
    if (positions.length > 0) {
      positions = await this.refreshMarkPrices(positions);
      // Settle any market that resolved since the last refresh (simulation only).
      if (settings.mode === "simulation") {
        positions = (await this.settleResolvedPositions(positions)).positions;
      }
      await savePositions(positions);
    }

    // Recompute equity/metrics - also when reconciliation just emptied the book -
    // so a flat account shows zero exposure and the freed cash immediately.
    if (settings.mode === "real" || positions.length > 0) {
      const state = await loadBotState(settings);
      const trades = await loadTrades();
      let liveBalance: LiveUsdcBalance | null = null;
      if (settings.mode === "real") {
        try {
          liveBalance = await getLiveUsdcBalance({ forceRefresh: true });
        } catch (err) {
          const reason = "Refresh marks blocked: could not fetch live balance: " + messageFromUnknown(err);
          await appendLog("error", reason);
          throw new Error(reason);
        }
      }
      const metrics = buildMetrics(settings, state, positions, trades, Date.now(), liveBalance?.usdcBalance);
      await saveBotState({ ...metrics.state, lastError: null });
      await appendEquityPoint({
        ts: Date.now(),
        equityUsd: metrics.metrics.equityUsd,
        cashUsd: metrics.metrics.cashUsd,
        exposureUsd: metrics.metrics.totalExposureUsd,
      });
      await appendLog("info", `Refreshed live marks for ${positions.length} open position(s).`);
    }
    return this.status();
  }

  /**
   * Wipe simulation results back to a clean slate: clears positions, trade
   * history, logs, the seen-trade ledger, and the equity curve, and resets
   * bankroll to the configured starting balance. Followed traders and settings
   * are kept.
   */
  async reset(): Promise<BotStatus> {
    this.desired = "stopped";
    this.clearTimer();
    this.lastHeartbeatLogAt = 0;
    const settings = await loadSettings();
    const now = Date.now();
    let resetCashUsd = settings.startingBalance;
    let resetMessage = `Simulation reset: bankroll back to $${settings.startingBalance.toFixed(2)}; positions, trades, and equity curve cleared.`;
    if (settings.mode === "real") {
      try {
        const liveBalance = await getLiveUsdcBalance({ forceRefresh: true });
        resetCashUsd = liveBalance.usdcBalance;
        resetMessage = `Real-mode local ledger reset: bankroll synced to live cash $${resetCashUsd.toFixed(2)}; local positions, trades, and equity curve cleared.`;
      } catch (err) {
        const reason = "Real-mode reset blocked: could not fetch live balance: " + messageFromUnknown(err);
        await appendLog("error", reason);
        throw new Error(reason);
      }
    }
    await savePositions([]);
    await saveTrades([]);
    await clearSkips();
    await saveSeenTrades({ ids: [] });
    await saveLivePositions(null);
    await saveEquityCurve([
      { ts: now, equityUsd: resetCashUsd, cashUsd: resetCashUsd, exposureUsd: 0 },
    ]);
    await saveBotState(createInitialBotState(resetCashUsd, now));
    await clearLogs();
    await appendLog("info", resetMessage);
    return this.status();
  }

  /**
   * Sell every open position. Used by session-only liquidation, the Stop modal,
   * panic-flatten, and the "Sell all now" option. Does not change runState.
   *
   * Real mode places live CLOB market SELL orders and only drops positions that
   * actually fill (see {@link flattenLive}); simulation books a mark-priced SELL
   * per position and clears the book ({@link flattenSimulated}).
   */
  async flatten(source: ExitSource = "session-close"): Promise<FlattenResult> {
    const settings = await loadSettings();
    return settings.mode === "real" ? this.flattenLive(source) : this.flattenSimulated(source);
  }

  /** Paper liquidation: mark-priced simulated SELL per position, then clear the book. */
  private async flattenSimulated(source: ExitSource): Promise<FlattenResult> {
    let positions = await loadPositions();
    if (positions.length === 0) return { closed: 0, proceedsUsd: 0, realizedPnlUsd: 0, failed: 0, skipped: 0 };

    positions = await this.refreshMarkPrices(positions);
    const now = Date.now();
    let proceedsUsd = 0;
    let realizedPnlUsd = 0;
    let closed = 0;

    for (const position of positions) {
      if (position.shares <= 0) continue;
      const price = clampPrice(position.markPrice);
      const shares = position.shares;
      const copyAmountUsd = shares * price;
      const pnl = (price - position.avgPrice) * shares;
      proceedsUsd += copyAmountUsd;
      realizedPnlUsd += pnl;
      closed += 1;
      const exitRecord = makeExitRecord(
        position,
        price,
        shares,
        copyAmountUsd,
        pnl,
        `Liquidated ${shares.toFixed(2)} ${position.outcome} @ ${(price * 100).toFixed(1)}c (${source}).`,
        source,
        now,
      );
      await prependTrade(exitRecord);
      await analytics.recordExit(exitRecord, source, position.sourceWallets);
    }

    await savePositions([]);

    const settings = await loadSettings();
    const state = await loadBotState(settings);
    const trades = await loadTrades();
    const metrics = buildMetrics(settings, state, [], trades);
    await saveBotState({ ...metrics.state, lastError: null });
    await appendEquityPoint({
      ts: Date.now(),
      equityUsd: metrics.metrics.equityUsd,
      cashUsd: metrics.metrics.cashUsd,
      exposureUsd: metrics.metrics.totalExposureUsd,
    });
    await appendLog(
      "info",
      `Liquidated ${closed} position(s) for ${proceedsUsd.toFixed(2)} USD (realized ${realizedPnlUsd >= 0 ? "+" : ""}${realizedPnlUsd.toFixed(2)}).`,
    );
    return { closed, proceedsUsd, realizedPnlUsd, failed: 0, skipped: 0 };
  }

  /**
   * Real-money liquidation. Places live CLOB market SELL orders for every
   * bot-opened, still-tradeable position and only removes the ones that actually
   * fill. A position is LEFT in the book (and logged) when:
   *   - it is a manual/unknown live position (no source attribution) - not the
   *     bot's to close;
   *   - its market has already resolved - resolved positions have no order book
   *     and Polymarket auto-redeems them to cash on settlement, so we never fake
   *     a CLOB sale for them;
   *   - the live SELL fails or only partially fills - the remainder is kept so the
   *     next start/poll retries it instead of being silently dropped.
   *
   * Crucially, this never clears the book blindly: only confirmed fills reduce a
   * position, so a failed sell can never make an open on-chain position vanish
   * from local tracking.
   */
  private async flattenLive(source: ExitSource): Promise<FlattenResult> {
    const empty: FlattenResult = { closed: 0, proceedsUsd: 0, realizedPnlUsd: 0, failed: 0, skipped: 0 };
    try {
      assertLiveTradingAllowed();
    } catch (err) {
      await appendLog("error", `Sell-all blocked: live trading is not allowed: ${messageFromUnknown(err)}. Positions left untouched.`);
      return empty;
    }

    // Reconcile against authoritative on-chain positions so we sell what is really
    // held (not a stale local book), then snapshot which positions are resolved /
    // redeemable (no order book - they auto-redeem and must not be CLOB-sold).
    await this.reconcileLivePositionsState("flatten");
    let positions = await loadPositions();
    if (positions.length === 0) return empty;

    const snapshot = await loadLivePositions();
    const redeemableTokens = new Set((snapshot?.entries ?? []).filter((e) => e.redeemable).map((e) => e.tokenId));

    positions = await this.refreshMarkPrices(positions);
    const now = Date.now();
    const DUST = 1e-6;
    const survivors: BotPosition[] = [];
    let proceedsUsd = 0;
    let realizedPnlUsd = 0;
    let closed = 0;
    let failed = 0;
    let skipped = 0;

    for (const position of positions) {
      if (position.shares <= DUST) continue;

      // Only the bot closes positions it opened. Manual / pre-existing live
      // positions (no source wallet) are left for the operator to manage.
      if (position.sourceWallets.length === 0) {
        survivors.push(position);
        skipped += 1;
        continue;
      }
      // Resolved markets auto-redeem to cash - don't try (and fail) to sell them.
      if (redeemableTokens.has(position.tokenId)) {
        survivors.push(position);
        skipped += 1;
        await appendLog(
          "info",
          `Sell-all: ${position.outcome} (${position.marketTitle}) is resolved; leaving it to auto-redeem to cash.`,
        );
        continue;
      }

      const price = clampPrice(position.markPrice);
      const sellSize = resolveLiveSellSize({
        position,
        requestedShares: position.shares,
        snapshot,
        now,
        maxSnapshotAgeMs: config.livePositionsStaleSeconds * 1000,
      });
      if (!sellSize.ok) {
        failed += 1;
        survivors.push(position);
        await appendLog(
          "error",
          `Sell-all SELL blocked for ${position.outcome} (${position.marketTitle}): ${sellSize.reason}. Position kept for retry.`,
        );
        continue;
      }
      if (sellSize.note) {
        await appendLog("warning", `Sell-all adjusted ${position.outcome}: ${sellSize.note}.`);
      }
      const bookPosition = { ...position, shares: sellSize.bookSharesBeforeSell };
      try {
        const res = await placeLiveMarketOrder({
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          side: "SELL",
          shares: sellSize.shares,
          ...(await liveExitPricing(position.tokenId, position.conditionId, price)),
        });
        clearLiveBalanceCache();
        if (!res.success || res.filledShares <= 0) {
          failed += 1;
          survivors.push(bookPosition);
          await appendLog(
            "error",
            `Sell-all SELL rejected for ${position.outcome} (${position.marketTitle}): ${res.error ?? "unknown error"}. Position kept for retry.`,
          );
          continue;
        }
        const realized = (res.effectivePrice - bookPosition.avgPrice) * res.filledShares;
        proceedsUsd += res.notionalUsd;
        realizedPnlUsd += realized;
        closed += 1;
        const record = makeExitRecord(
          bookPosition,
          res.effectivePrice,
          res.filledShares,
          res.notionalUsd,
          realized,
          `LIVE sell-all: ${res.filledShares.toFixed(2)} ${position.outcome} @ ${(res.effectivePrice * 100).toFixed(1)}c (${source}) - order ${res.orderId ?? "?"}.`,
          source,
          now,
        );
        record.mode = "real";
        record.status = "copied";
        record.txOrOrderId = res.orderId ?? "";
        record.reconciliationStatus = "pending";
        await prependTrade(record);
        await analytics.recordExit(record, source, position.sourceWallets);

        // Keep any real unfilled remainder so the next session retries it.
        const remainder = Math.max(0, sellSize.bookSharesBeforeSell - res.filledShares);
        if (remainder > LIVE_SELL_DUST) {
          survivors.push({ ...bookPosition, shares: remainder, markPrice: clampPrice(res.effectivePrice), updatedAt: now });
          await appendLog(
            "warning",
            `Sell-all only partially filled ${position.outcome}: sold ${formatLiveSellShares(res.filledShares)} of ${formatLiveSellShares(sellSize.bookSharesBeforeSell)}; ${formatLiveSellShares(remainder)} kept.`,
          );
        }
      } catch (err) {
        clearLiveBalanceCache();
        failed += 1;
        survivors.push(bookPosition);
        await appendLog(
          "error",
          `Sell-all SELL failed for ${position.outcome} (${position.marketTitle}): ${messageFromUnknown(err)}. Position kept for retry.`,
        );
      }
    }

    await savePositions(survivors);

    // Recompute equity/cash from the authoritative live balance after selling.
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    const trades = await loadTrades();
    let liveBalance: LiveUsdcBalance | null = null;
    try {
      liveBalance = await getLiveUsdcBalance({ forceRefresh: true });
    } catch (err) {
      await appendLog("warning", `Sell-all completed but live balance refresh failed: ${messageFromUnknown(err)}.`);
    }
    const metrics = buildMetrics(settings, state, survivors, trades, Date.now(), liveBalance?.usdcBalance);
    await saveBotState({ ...metrics.state, lastError: null });
    await appendEquityPoint({
      ts: Date.now(),
      equityUsd: metrics.metrics.equityUsd,
      cashUsd: metrics.metrics.cashUsd,
      exposureUsd: metrics.metrics.totalExposureUsd,
    });
    await appendLog(
      failed > 0 ? "warning" : "info",
      `LIVE sell-all (${source}): sold ${closed} position(s) for $${proceedsUsd.toFixed(2)} ` +
        `(realized ${realizedPnlUsd >= 0 ? "+" : ""}${realizedPnlUsd.toFixed(2)}); ${failed} failed (kept), ${skipped} left (manual/resolved).`,
    );
    return { closed, proceedsUsd, realizedPnlUsd, failed, skipped };
  }

  /**
   * Enter exit-only ("drain") mode: stop opening new copy positions, but keep
   * polling to auto-sell open positions as they hit the configured take-profit,
   * stop-loss, or max-hold rules. Transitions to "stopped" once flat.
   */
  async drain(rules?: Partial<BotSettings>): Promise<BotStatus> {
    let settings = await loadSettings();
    if (rules) {
      settings = sanitizeSettings(settings, {
        autoExitTakeProfitPercent: rules.autoExitTakeProfitPercent,
        autoExitStopLossPercent: rules.autoExitStopLossPercent,
        autoExitMaxHoldMinutes: rules.autoExitMaxHoldMinutes,
      });
      await saveSettings(settings);
    }

    const positions = await loadPositions();
    if (positions.length === 0) {
      await appendLog("info", "Auto-exit requested with no open positions; stopping.");
      return this.stop();
    }

    const anyRule =
      settings.autoExitTakeProfitPercent > 0 ||
      settings.autoExitStopLossPercent > 0 ||
      settings.autoExitMaxHoldMinutes > 0;
    if (!anyRule) {
      await appendLog("warning", "Auto-exit requested without any exit rule set; liquidating immediately instead.");
      return this.stop({ liquidate: true, source: "auto-exit" });
    }

    const state = await loadBotState(settings);
    const now = Date.now();
    await saveBotState({
      ...state,
      runState: "draining",
      desiredRunState: "draining",
      pausedAt: null,
      nextPollAt: now + settings.pollingIntervalSec * 1000,
      lastError: null,
    });
    this.desired = "draining";
    this.pollIntervalMs = settings.pollingIntervalSec * 1000;
    this.ensureWatchdog();
    await appendLog(
      "info",
      `Auto-exit (drain) mode: monitoring ${positions.length} open position(s); no new entries. ` +
        `TP ${settings.autoExitTakeProfitPercent || "off"}% / SL ${settings.autoExitStopLossPercent || "off"}% / max-hold ${settings.autoExitMaxHoldMinutes || "off"}m.`,
    );
    this.schedule(0);
    return this.status();
  }

  /** Best-effort refresh of mark prices from Gamma; keeps prior mark on failure. */
  private async refreshMarkPrices(positions: BotPosition[]): Promise<BotPosition[]> {
    const now = Date.now();
    return Promise.all(
      positions.map(async (position) => {
        try {
          const market = await fetchMarketById(position.tokenId);
          const outcome = market?.outcomes.find((o) => o.tokenId === position.tokenId);
          const price = outcome?.price;
          if (price != null && Number.isFinite(price) && price > 0) {
            return { ...position, markPrice: clampPrice(price), updatedAt: now };
          }
        } catch {
          // Keep the existing mark price if the lookup fails.
        }
        return position;
      }),
    );
  }

  /**
   * Simulation settlement: realize any open position whose market has resolved.
   * The winning outcome pays $1/share and the loser $0 - we book a settlement
   * SELL (crediting cash with the payout and realizing P&L against cost basis)
   * and drop the position from the book. Positions whose markets are not yet
   * resolved, or whose payout can't be determined this poll, are left untouched
   * and retried next poll. Returns the surviving positions.
   *
   * Real mode is intentionally excluded: a resolved live position must be
   * redeemed on-chain (which moves funds), so the live-position reconciler
   * surfaces it as "redeemable" for manual action rather than settling it here.
   */
  private async settleResolvedPositions(positions: BotPosition[]): Promise<{ positions: BotPosition[]; settled: number }> {
    if (positions.length === 0) return { positions, settled: 0 };
    const now = Date.now();
    const remaining: BotPosition[] = [];
    let settled = 0;
    for (const position of positions) {
      if (position.shares <= 0) continue;
      let settlementValue: number | null = null;
      try {
        const market = await fetchMarketById(position.tokenId);
        settlementValue = marketSettlementValue(market, position.tokenId);
      } catch {
        settlementValue = null;
      }
      if (settlementValue == null) {
        remaining.push(position);
        continue;
      }
      const realizedPnlUsd = (settlementValue - position.avgPrice) * position.shares;
      const settlementRecord = makeSettlementRecord(position, settlementValue, realizedPnlUsd, now);
      await prependTrade(settlementRecord);
      await analytics.recordExit(settlementRecord, "settlement", position.sourceWallets);
      settled += 1;
      await appendLog(
        "info",
        `Settled resolved position ${position.outcome} (${position.marketTitle}): ` +
          `${settlementValue >= 0.5 ? "WON" : "LOST"} ${position.shares.toFixed(2)} share(s), ` +
          `realized ${realizedPnlUsd >= 0 ? "+" : ""}${realizedPnlUsd.toFixed(2)} USD.`,
      );
    }
    return { positions: remaining, settled };
  }

  async updateSettings(patch: Partial<BotSettings>): Promise<BotStatus> {
    const current = await loadSettings();
    const next = sanitizeSettings(current, patch);
    await saveSettings(next);
    if (isRiskPresetId(patch.riskPreset) && patch.riskPreset !== "custom") {
      await appendLog("info", `Risk preset applied: ${RISK_PRESETS[next.riskPreset].label}.`);
    } else if (current.riskPreset !== "custom" && next.riskPreset === "custom") {
      await appendLog("info", "Risk preset changed to Custom due to manual field edit.");
    } else {
      await appendLog("info", "Settings updated.");
    }

    const state = await loadBotState(next);
    if (state.runState === "running") {
      this.schedule(next.pollingIntervalSec * 1000);
    }
    return this.status();
  }

  async addTrader(walletInput: string, name?: string): Promise<BotStatus> {
    const wallet = normalizeWallet(walletInput);
    if (!validWallet(wallet)) throw new Error("Wallet must be a 0x address.");

    const traders = await loadTraders();
    const existing = traders.find((trader) => trader.wallet === wallet);
    if (existing) {
      await saveTraders(traders.map((trader) => (trader.wallet === wallet ? { ...trader, enabled: true, source: "manual" } : trader)));
      await appendLog("info", `Enabled manual trader ${wallet}.`);
      return this.status();
    }

    let display = name || `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
    let weeklyVolumeUsd = 0;
    let weeklyTradeCount = 0;
    let lastTradeAt: number | null = null;
    let initialTrades: TraderTrade[] = [];
    try {
      initialTrades = await fetchUserTrades(wallet, 30);
      display = name || initialTrades[0]?.traderName || display;
      weeklyVolumeUsd = initialTrades.reduce((sum, trade) => sum + trade.price * trade.size, 0);
      weeklyTradeCount = initialTrades.length;
      lastTradeAt = initialTrades[0]?.timestamp ? initialTrades[0].timestamp * 1000 : null;
    } catch (err) {
      await appendLog("warning", `Added trader ${wallet}, but recent-trade lookup failed: ${(err as Error).message}`);
    }

    const now = Date.now();
    await saveTraders([
      {
        wallet,
        name: display,
        enabled: true,
        source: "manual",
        rank: null,
        weeklyPnlUsd: 0,
        weeklyVolumeUsd,
        weeklyTradeCount,
        copiedTradeCount: 0,
        copiedSimPnlUsd: 0,
        lastTradeAt,
        addedAt: now,
        updatedAt: now,
      },
      ...traders,
    ]);
    if (initialTrades.length > 0) {
      const seen = await loadSeenTrades();
      const ids = new Set(seen.ids);
      for (const trade of initialTrades) ids.add(seenKey(trade));
      await saveSeenTrades({ ids: [...ids] });
      await appendLog("info", `Marked ${initialTrades.length} existing trades as seen for manual trader ${wallet}.`);
    }
    await appendLog("info", `Added manual trader ${wallet}.`);
    return this.status();
  }

  async removeTrader(walletInput: string): Promise<BotStatus> {
    const wallet = normalizeWallet(walletInput);
    const traders = await loadTraders();
    await saveTraders(traders.filter((trader) => trader.wallet !== wallet));
    await appendLog("info", `Removed trader ${wallet}.`);
    return this.status();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delayMs: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, Math.max(0, delayMs));
  }

  /**
   * Schedule the next poll if the operator still wants the loop running. The
   * interval is measured start-to-start (a 3s poll on a 5s cadence waits 2s),
   * with a short floor so a slow poll never causes back-to-back hammering.
   */
  private scheduleNext(): void {
    if (this.desired === "running" || this.desired === "draining") {
      const elapsed = Date.now() - this.tickStartedAt;
      this.schedule(Math.max(MIN_POLL_GAP_MS, this.pollIntervalMs - elapsed));
    }
  }

  /**
   * Self-healing heartbeat: if the loop should be running but no poll is armed
   * (lost timer) or the current poll has hung, kick a fresh poll.
   */
  private ensureWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (this.desired !== "running" && this.desired !== "draining") return;
      const stuckLimit = Math.max(MIN_STUCK_TICK_MS, 4 * this.pollIntervalMs);
      if (this.inFlight && Date.now() - this.tickStartedAt > stuckLimit) {
        void this.tick();
      } else if (!this.inFlight && !this.timer) {
        void appendLog("warning", "Watchdog: poll loop had no next poll scheduled; restarting it.").catch(() => undefined);
        this.schedule(0);
      }
    }, WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
  }

  private async discover(force = false): Promise<void> {
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    const now = Date.now();
    const due =
      force ||
      !state.lastDiscoveryAt ||
      now - state.lastDiscoveryAt > settings.traderRefreshIntervalMin * 60 * 1000;
    if (!due) return;

    const [traders, trades, heldPositions] = await Promise.all([loadTraders(), loadTrades(), loadPositions()]);
    const previousWallets = new Set(traders.map((trader) => trader.wallet));
    const heldSourceWallets = new Set(heldPositions.flatMap((position) => position.sourceWallets));
    // Throws when the leaderboards are unreachable; callers keep the old roster.
    const discovered = await discoverTraders(settings, traders, trades, now, heldSourceWallets);
    await saveTraders(discovered);

    const newWallets = discovered
      .filter((trader) => trader.enabled && !previousWallets.has(trader.wallet))
      .map((trader) => trader.wallet);
    if (newWallets.length > 0) {
      try {
        const seen = await loadSeenTrades();
        const ids = new Set(seen.ids);
        const existingTrades = await fetchTradesForWallets(newWallets, 30);
        for (const trade of existingTrades) ids.add(seenKey(trade));
        await saveSeenTrades({ ids: [...ids] });
        await appendLog("info", `Marked ${existingTrades.length} existing trades as seen for ${newWallets.length} newly discovered wallets.`);
      } catch (err) {
        await appendLog("warning", `Could not bootstrap seen trades for new wallets: ${messageFromUnknown(err)}`);
      }
    }

    await saveBotState({ ...state, lastDiscoveryAt: now });

    // Summarize which Discovery v2 pools the tracked roster came from.
    const poolCounts = new Map<string, number>();
    for (const trader of discovered) {
      if (!trader.enabled) continue;
      const key = trader.discoverySource ?? (trader.source === "manual" ? "manual" : "auto");
      poolCounts.set(key, (poolCounts.get(key) ?? 0) + 1);
    }
    const poolSummary = [...poolCounts.entries()].map(([pool, count]) => `${pool}:${count}`).join(", ");
    await appendLog(
      "info",
      `Discovery v2 refreshed ${discovered.length} tracked wallets${poolSummary ? ` (${poolSummary})` : ""}.`,
    );
    await this.refreshCopyScores();
  }

  private async bootstrapSeenTrades(): Promise<void> {
    const [settings, traders, seen] = await Promise.all([loadSettings(), loadTraders(), loadSeenTrades()]);
    const wallets = enabledWallets(traders, MAX_WALLETS_PER_POLL);
    if (wallets.length === 0) return;
    const existingTrades = await fetchTradesForWallets(wallets, 30);
    const ids = new Set(seen.ids);
    for (const trade of existingTrades) ids.add(seenKey(trade));
    await saveSeenTrades({ ids: [...ids] });
    const state = await loadBotState(settings);
    await saveBotState({ ...state, firstRunBootstrappedAt: Date.now() });
    await appendLog("info", `Marked ${existingTrades.length} existing trader trades as seen before copying.`);
  }

  /**
   * Pull authoritative CLOB fills and reconcile them onto the live copy-trade
   * ledger, replacing local mirror estimates with real fills. Safe to call on
   * startup (catches fills from prior sessions) and after each real-mode poll.
   */
  private async reconcileLiveOrders(context: string): Promise<void> {
    const trades = await loadTrades();
    if (!trades.some((trade) => trade.mode === "real" && trade.status === "copied")) return;
    let result;
    try {
      result = await reconcileLiveTrades(trades);
    } catch (err) {
      await appendLog("error", `Live reconciliation (${context}) error: ${messageFromUnknown(err)}.`);
      return;
    }
    if (!result.summary.ran) return;
    await saveTrades(result.records);
    const { matched, partial, unmatched, voided, fetchedFills, error } = result.summary;
    if (error) {
      await appendLog("warning", `Live reconciliation (${context}): trade history unavailable (${error}); will retry next poll.`);
    }
    if (matched + partial + unmatched + voided > 0) {
      await appendLog(
        unmatched > 0 ? "warning" : "info",
        `Live reconciliation (${context}): ${matched} matched, ${partial} partial, ${unmatched} unconfirmed, ${voided} cleared as never filled (${fetchedFills} exchange fill(s) checked).`,
      );
    }
  }

  /**
   * Recompute copy-performance scores from the bot's own copied results and apply
   * auto-disable rules (pinned wallets are exempt). Persists scores onto traders
   * and logs any wallet newly auto-disabled this pass.
   */
  private async refreshCopyScores(): Promise<void> {
    const [traders, trades, positions] = await Promise.all([loadTraders(), loadTrades(), loadPositions()]);
    if (traders.length === 0) return;
    const { traders: scored, newlyDisabled } = applyCopyScores(traders, trades, positions);
    await saveTraders(scored);
    for (const entry of newlyDisabled) {
      await appendLog("warning", `Auto-disabled copy wallet ${entry.name}: ${entry.reason}`);
    }
  }

  /**
   * Fetch authoritative live account positions and reconcile them against the
   * local ledger (real mode only). Persists the classification snapshot and
   * adopts the authoritative positions so exposure caps include live/manual
   * positions. Returns the snapshot (or an error snapshot) for the dashboard.
   */
  private async reconcileLivePositionsState(context: string): Promise<LivePositionReconciliation | null> {
    const settings = await loadSettings();
    if (settings.mode !== "real") return null;
    const [localPositions, traders] = await Promise.all([loadPositions(), loadTraders()]);
    try {
      const { snapshot, positions } = await reconcileLivePositions(localPositions, traders);
      await saveLivePositions(snapshot);
      await savePositions(positions);
      const note =
        snapshot.unknownPositionCount > 0 || snapshot.stalePositionCount > 0
          ? ` (${snapshot.unknownPositionCount} unknown, ${snapshot.stalePositionCount} stale, ${snapshot.redeemableCount} redeemable)`
          : "";
      await appendLog(
        snapshot.unknownPositionCount > 0 ? "warning" : "info",
        `Live positions reconciled (${context}): ${snapshot.entries.length} entr(ies), $${snapshot.totalLiveExposureUsd.toFixed(2)} live exposure${note}.`,
      );
      return snapshot;
    } catch (err) {
      const snapshot = emptyLiveReconciliation(messageFromUnknown(err));
      await saveLivePositions(snapshot);
      await appendLog(
        "error",
        `Live position reconciliation (${context}) failed: ${messageFromUnknown(err)}. Keeping local positions.`,
      );
      return snapshot;
    }
  }

  /**
   * Read-only redeemable plan for the dashboard/API. Uses the last persisted live
   * snapshot (reconciled on poll/startup) - never trades and never hits the chain.
   * Empty (no error) in simulation, where resolved positions settle automatically.
   */
  async redeemablePlan(): Promise<RedeemablePlan> {
    const settings = await loadSettings();
    const [snapshot, redeemed] = await Promise.all([loadLivePositions(), loadRedeemBook()]);
    return buildRedeemablePlan(settings.mode === "real" ? snapshot : null, redeemed, settings.mode);
  }

  /**
   * Redeem resolved (won) positions on-chain. Real-mode only. Two ways in:
   *   - manual (default): requires confirm === "REDEEM"; this is the safe path and
   *     the only one that may include unknown/manual positions (via includeUnknown);
   *   - automatic: opts.auto, gated behind config.enableAutoRedeem; only ever
   *     redeems attribution-known positions and never unknown/manual ones.
   *
   * Invariants: never redeems unresolved/not-redeemable positions; never redeems
   * the same position twice (persisted redeem book); skips positions the bot can't
   * redeem itself (proxy/safe/neg-risk) leaving them for manual action; logs every
   * attempt; keeps looping past individual failures; updates cash/equity after.
   */
  async redeemResolved(
    opts: { confirm?: string; auto?: boolean; includeUnknown?: boolean } = {},
  ): Promise<RedeemRunResult> {
    const empty: RedeemRunResult = {
      ran: false,
      attempted: 0,
      redeemed: 0,
      failed: 0,
      skipped: 0,
      totalPayoutUsd: 0,
      attempts: [],
      error: null,
    };

    const settings = await loadSettings();
    if (settings.mode !== "real") {
      return { ...empty, error: "Redemption only applies in real mode; simulation settles resolved markets automatically." };
    }

    // Gates. Automatic redemption requires its own explicit opt-in; manual
    // redemption requires the confirmation text and dashboard auth (route-level).
    if (opts.auto) {
      if (!config.enableAutoRedeem) return empty; // detection-only by default
    } else if (opts.confirm !== "REDEEM") {
      return { ...empty, error: 'Redemption requires the confirmation text "REDEEM".' };
    }

    try {
      assertLiveRedeemAllowed();
    } catch (err) {
      return { ...empty, error: messageFromUnknown(err) };
    }

    // Refresh authoritative positions so we redeem against on-chain truth, then
    // build the plan from the fresh snapshot + persisted redeem book.
    await this.reconcileLivePositionsState("redeem");
    const [snapshot, redeemed, positions] = await Promise.all([
      loadLivePositions(),
      loadRedeemBook(),
      loadPositions(),
    ]);
    const plan = buildRedeemablePlan(snapshot, redeemed, "real");
    if (plan.error) return { ...empty, error: plan.error };

    const includeUnknown = !opts.auto && opts.includeUnknown === true && opts.confirm === "REDEEM";
    const costBasisOf = new Map(positions.map((p) => [p.tokenId, p.avgPrice * p.shares]));

    let redeemedCount = 0;
    let failed = 0;
    let skipped = 0;
    let totalPayoutUsd = 0;
    const attempts: RedeemAttemptResult[] = [];
    const redeemedTokens: string[] = [];

    for (const item of plan.items) {
      // Skip positions the bot can't redeem itself (proxy/safe/neg-risk) - they
      // stay surfaced for manual redemption on Polymarket.
      if (item.blockedReason) {
        skipped += 1;
        continue;
      }
      // Never auto/blind-redeem an unknown or manual position; only an explicit,
      // confirmed manual run with includeUnknown may touch them.
      if (!item.attributionKnown && !includeUnknown) {
        skipped += 1;
        continue;
      }

      const result = await redeemConditionOnChain(item.conditionId);
      const payoutUsd = result.success ? item.expectedPayoutUsd : 0;
      attempts.push({
        tokenId: item.tokenId,
        conditionId: item.conditionId,
        success: result.success,
        txHash: result.txHash,
        payoutUsd,
        error: result.error,
      });

      if (!result.success) {
        failed += 1;
        await appendLog("error", `Redeem failed for ${item.outcome} (${item.marketTitle}): ${result.error ?? "unknown error"}.`);
        continue; // keep looping past a single failure
      }

      // Record the on-chain redemption: ledger event + double-redeem guard.
      const costBasisUsd = costBasisOf.get(item.tokenId) ?? 0;
      const redeemRecord = makeRedeemRecord(item, payoutUsd, costBasisUsd, result.txHash);
      await prependTrade(redeemRecord);
      await analytics.recordExit(redeemRecord, "redeem");
      await recordRedeemed({
        tokenId: item.tokenId,
        conditionId: item.conditionId,
        txHash: result.txHash,
        payoutUsd,
        redeemedAt: Date.now(),
        mode: "real",
      });
      redeemedTokens.push(item.tokenId);
      redeemedCount += 1;
      totalPayoutUsd += payoutUsd;
      await appendLog(
        "info",
        `Redeemed ${item.outcome} (${item.marketTitle}): ${item.shares.toFixed(2)} share(s) → $${payoutUsd.toFixed(2)}${result.txHash ? ` [tx ${result.txHash.slice(0, 10)}…]` : ""}.`,
      );
    }

    // Drop redeemed tokens from local positions and recompute cash/equity/P&L now
    // (the next reconcile would also remove them, but reflect it immediately).
    if (redeemedTokens.length > 0) {
      const remaining = positions.filter((p) => !redeemedTokens.includes(p.tokenId));
      await savePositions(remaining);
      const state = await loadBotState(settings);
      const trades = await loadTrades();
      const metrics = buildMetrics(settings, state, remaining, trades);
      await saveBotState({ ...metrics.state, lastError: null });
      await appendEquityPoint({
        ts: Date.now(),
        equityUsd: metrics.metrics.equityUsd,
        cashUsd: metrics.metrics.cashUsd,
        exposureUsd: metrics.metrics.totalExposureUsd,
      });
    }

    if (redeemedCount > 0 || failed > 0) {
      await appendLog(
        failed > 0 ? "warning" : "info",
        `Redeem pass complete: ${redeemedCount} redeemed ($${totalPayoutUsd.toFixed(2)}), ${failed} failed, ${skipped} skipped.`,
      );
    }

    return {
      ran: true,
      attempted: attempts.length,
      redeemed: redeemedCount,
      failed,
      skipped,
      totalPayoutUsd,
      attempts,
      error: null,
    };
  }

  private async updateSimulationBuyExposurePause(settings: BotSettings, positions: BotPosition[], trades: CopyTradeRecord[]): Promise<boolean> {
    if (settings.mode !== "simulation") {
      if (this.buyExposurePaused) this.buyExposurePaused = false;
      return false;
    }

    const exposureUsd = totalExposure(positions);
    const equityUsd = calculateAvailableBalance(settings, positions, trades) + exposureUsd;
    const exposurePercent = equityUsd > 0 ? exposureUsd / equityUsd : 0;
    const capPercent = settings.maxTotalExposurePercent / 100;
    const paused = capPercent > 0 && exposurePercent >= capPercent - 1e-9;

    if (paused && !this.buyExposurePaused) {
      this.buyExposurePaused = true;
      await appendLog(
        "info",
        "BUY processing paused: total exposure " +
          (exposurePercent * 100).toFixed(1) +
          "% is at/above the " +
          settings.maxTotalExposurePercent.toFixed(1) +
          "% cap. Observing SELLs only until exposure falls below the cap.",
      );
    } else if (!paused && this.buyExposurePaused) {
      this.buyExposurePaused = false;
      await appendLog(
        "info",
        "BUY processing resumed: total exposure " +
          (exposurePercent * 100).toFixed(1) +
          "% is below the " +
          settings.maxTotalExposurePercent.toFixed(1) +
          "% cap.",
      );
    }

    return paused;
  }

  /** True when a newer poll has superseded this one (it hung and was abandoned). */
  private stale(gen: number): boolean {
    return gen !== this.tickGeneration;
  }

  /** Persist poll-owned state without clobbering operator control fields. */
  private async saveTickState(gen: number, settings: BotSettings, next: BotState): Promise<void> {
    if (this.stale(gen)) return;
    const fresh = await loadBotState(settings);
    await saveBotState(withControlFields(next, fresh));
  }

  private async tick(): Promise<void> {
    if (this.inFlight) {
      const stuckLimit = Math.max(MIN_STUCK_TICK_MS, 4 * this.pollIntervalMs);
      const runningFor = Date.now() - this.tickStartedAt;
      if (runningFor < stuckLimit) return;
      // The previous poll hung (an upstream call never returned). Abandon it:
      // bumping the generation makes it stop writing, then start a fresh poll.
      await appendLog("error", `Poll was stuck for ${Math.round(runningFor / 1000)}s; abandoning it and starting a fresh one.`).catch(() => undefined);
    }
    const gen = ++this.tickGeneration;
    this.inFlight = true;
    this.tickStartedAt = Date.now();
    this.clearTimer();

    try {
      const settings = await loadSettings();
      this.pollIntervalMs = settings.pollingIntervalSec * 1000;
      let state = await loadBotState(settings);
      if (this.desired == null) this.desired = state.desiredRunState ?? state.runState;
      if (state.runState === "draining") {
        await this.drainTick(settings, state);
        return;
      }
      if (state.runState !== "running" || this.desired !== "running") return;

      try {
        await this.discover(false);
      } catch (err) {
        await appendLog("warning", `Trader discovery failed (${messageFromUnknown(err)}); keeping the current roster.`);
      }
      state = await loadBotState(settings);
      if (state.runState !== "running" || this.stale(gen)) return;
      const traders = await loadTraders();
      const traderByWallet = new Map(traders.map((t) => [t.wallet.toLowerCase(), t]));
      const wallets = enabledWallets(traders, MAX_WALLETS_PER_POLL);
      const now = Date.now();
      state = {
        ...state,
        lastPollAt: now,
        nextPollAt: now + settings.pollingIntervalSec * 1000,
      };
      await this.saveTickState(gen, settings, state);

      if (wallets.length === 0) {
        await appendLog("warning", "Poll skipped: no enabled followed traders.");
        return;
      }

      const traderTrades = (await fetchTradesForWallets(wallets, 30)).sort((a, b) => a.timestamp - b.timestamp);
      state = {
        ...state,
        sessionWalletsChecked: state.sessionWalletsChecked + wallets.length,
        sessionTradesScanned: state.sessionTradesScanned + traderTrades.length,
      };
      // In real mode, adopt authoritative account positions BEFORE processing new
      // trades so exposure caps reflect live + manual positions (never blind).
      if (settings.mode === "real") {
        await this.reconcileLivePositionsState("poll");
      }

      const seen = await loadSeenTrades();
      const seenIds = new Set(seen.ids);
      let positions = await loadPositions();
      let processedCount = 0;
      let pausedBuyCount = 0;
      const priorTradeRecords = await loadTrades();
      const exposurePausedForBuys = await this.updateSimulationBuyExposurePause(settings, positions, priorTradeRecords);

      // Aggregate repeated skip reasons within this poll cycle so the log shows a
      // single grouped line per reason instead of one spammy line per trade.
      const skipBuckets = new Map<string, { level: LogLevel; reason: string; count: number }>();
      // Per-wallet BUY copies made this cycle, for the per-wallet copy cap.
      const walletCycleCopies = new Map<string, number>();

      for (const trade of traderTrades) {
        // Stop/Pause/Panic pressed mid-poll (or this poll was abandoned): stop
        // acting on new trades immediately.
        if (this.desired !== "running" || this.stale(gen)) break;
        const id = seenKey(trade);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        if (exposurePausedForBuys && trade.side === "BUY") {
          pausedBuyCount += 1;
          continue;
        }
        const trader = traderByWallet.get(trade.wallet.toLowerCase()) ?? null;
        if (trade.side === "BUY") this.rememberLeaderBuy(trade);
        const capture: DecisionCapture = {};
        const result = await this.processTrade(trade, settings, state, positions, walletCycleCopies, trader, capture);
        positions = result.positions;
        await prependTrade(result.record);
        // Analytics (observational only — never affects the decision above).
        await analytics.recordDecision({
          record: result.record,
          trade,
          settings,
          state,
          trader,
          market: capture.market ?? null,
          capture,
          positionsAfter: result.positions,
        });
        processedCount += 1;
        if (
          result.record.side === "BUY" &&
          (result.record.status === "simulated" || result.record.status === "copied")
        ) {
          walletCycleCopies.set(trade.wallet, (walletCycleCopies.get(trade.wallet) ?? 0) + 1);
        }
        if (result.record.status === "failed") {
          await appendLog("error", result.record.reason);
        } else if (result.record.status === "skipped") {
          const level: LogLevel = result.record.reason.startsWith("Observed trader SELL") ? "info" : "warning";
          const key = level + "::" + normalizeSkipReason(result.record.reason);
          const bucket = skipBuckets.get(key) ?? { level, reason: result.record.reason, count: 0 };
          bucket.count += 1;
          skipBuckets.set(key, bucket);
        } else if (result.record.status === "simulated" || result.record.status === "dry-run") {
          await appendLog("info", result.record.reason);
        }
      }

      for (const bucket of skipBuckets.values()) {
        await appendLog(
          bucket.level,
          bucket.count > 1 ? `${bucket.reason} (-${bucket.count} this cycle)` : bucket.reason,
        );
      }

      if (processedCount === 0 && now - this.lastHeartbeatLogAt > 2 * 60 * 1000) {
        this.lastHeartbeatLogAt = now;
        const pauseNote = pausedBuyCount > 0 ? `; ${pausedBuyCount} BUY trade(s) ignored while exposure-paused` : "; no new trades since first-run bootstrap";
        await appendLog("info", `Poll checked ${wallets.length} wallets and ${traderTrades.length} recent trades${pauseNote}.`);
      } else if (processedCount > 0) {
        this.lastHeartbeatLogAt = now;
      }


      if (settings.mode === "simulation") {
        await this.updateSimulationBuyExposurePause(settings, positions, await loadTrades());
      }

      // Refresh marks on every poll so open positions reflect live Polymarket
      // prices (and thus real unrealized P&L), not just the entry price.
      if (positions.length > 0) {
        positions = await this.refreshMarkPrices(positions);
      }

      // Simulation settlement: realize (to $1 winner / $0 loser) and close out any
      // position whose market has resolved, so resolved markets don't linger as
      // phantom exposure. Real mode resolves via on-chain redemption (manual).
      if (settings.mode === "simulation" && positions.length > 0) {
        positions = (await this.settleResolvedPositions(positions)).positions;
      }

      // Leader-holdings reconciliation: annotate whether each copied position's
      // source leader still holds it, and (when enabled) exit positions the leader
      // has left. Runs in both modes; the real-mode sale is safety-gated.
      if (positions.length > 0) {
        positions = await this.reconcileAndExitLeaders(settings, positions);
      }

      // Fully-automatic live exits: in real mode, sell any position that has hit
      // the configured take-profit / stop-loss / max-hold on this poll.
      if (settings.mode === "real" && positions.length > 0) {
        positions = await this.liveAutoExit(settings, positions);
      }

      if (this.stale(gen)) return;
      await savePositions(positions);
      await saveSeenTrades({ ids: [...seenIds] });

      // Analytics (observational only): periodically snapshot the open-position
      // timeline and run bounded background maintenance. Both are self-guarding
      // (never throw) and rate-limited so they add negligible poll overhead.
      if (now - this.lastAnalyticsSnapshotAt >= 5 * 60_000) {
        this.lastAnalyticsSnapshotAt = now;
        await analytics.recordPositionSnapshots(positions, settings.mode);
      }
      if (now - this.lastAnalyticsMaintenanceAt >= 10 * 60_000) {
        this.lastAnalyticsMaintenanceAt = now;
        await analytics.runMaintenance();
      }

      // Reconcile any live orders placed this poll against authoritative CLOB
      // fills, and re-score followed wallets from the bot's own copied results.
      if (settings.mode === "real") {
        await this.reconcileLiveOrders("poll");
        // Fully-automatic redemption of resolved winnings (gated behind
        // ENABLE_AUTO_REDEEM; no-op otherwise). Never redeems unknown/manual
        // positions; failures are logged and never break the poll loop.
        if (config.enableAutoRedeem) {
          try {
            await this.redeemResolved({ auto: true });
          } catch (err) {
            await appendLog("error", `Automatic redeem pass errored: ${messageFromUnknown(err)}.`);
          }
        }
      }
      await this.refreshCopyScores();

      const trades = await loadTrades();
      let loopLiveBalance: LiveUsdcBalance | null = null;
      if (config.livePrivateKey.trim() || config.liveFunderAddress.trim()) {
        try {
          loopLiveBalance = await getLiveUsdcBalance({ forceRefresh: settings.mode === "real" });
        } catch (err) {
          if (settings.mode === "real") {
            throw new Error("Live balance fetch failed during poll metrics: " + messageFromUnknown(err));
          }
        }
      }
      const metrics = buildMetrics(settings, state, positions, trades, Date.now(), loopLiveBalance?.usdcBalance);
      let nextState: BotState = { ...metrics.state, lastError: null, lastHeartbeatAt: Date.now() };
      nextState = await this.applyDrawdownPause(settings, nextState, metrics.metrics.equityUsd);
      await this.saveTickState(gen, settings, nextState);
      if (!state.dailyLossLockout && metrics.state.dailyLossLockout) {
        await appendLog("warning", "Daily loss limit hit: no new buys until tomorrow (UTC). Open positions are still managed.");
      }
      await appendEquityPoint({
        ts: Date.now(),
        equityUsd: metrics.metrics.equityUsd,
        cashUsd: metrics.metrics.cashUsd,
        exposureUsd: metrics.metrics.totalExposureUsd,
      });
    } catch (err) {
      if (!this.stale(gen)) {
        try {
          const settings = await loadSettings();
          const state = await loadBotState(settings);
          await saveBotState({ ...state, lastError: err instanceof Error ? err.message : "Unknown bot error", lastHeartbeatAt: Date.now() });
        } catch {
          // never let error bookkeeping break the loop
        }
        await appendLog("error", `Bot loop error: ${err instanceof Error ? err.message : "Unknown error"}`).catch(() => undefined);
      }
    } finally {
      // Only the current poll may clear the in-flight flag or schedule the next
      // one; an abandoned poll that finally returns just exits quietly.
      if (!this.stale(gen)) {
        await this.touchHeartbeat();
        this.inFlight = false;
        this.scheduleNext();
      }
    }
  }

  /** Record that a poll finished (used by /api/health and the watchdog). */
  private async touchHeartbeat(): Promise<void> {
    if (this.desired !== "running" && this.desired !== "draining") return;
    try {
      const settings = await loadSettings();
      const fresh = await loadBotState(settings);
      await saveBotState({ ...fresh, lastHeartbeatAt: Date.now() });
    } catch {
      // heartbeat is best-effort
    }
  }

  /**
   * Drawdown circuit breaker: when account value falls maxDrawdownPausePercent
   * below its peak, pause NEW buys for 24 hours (exits keep running), then
   * restart the peak from the current value so the pause doesn't re-trigger.
   */
  private async applyDrawdownPause(settings: BotSettings, state: BotState, equityUsd: number): Promise<BotState> {
    const pct = settings.maxDrawdownPausePercent;
    const now = Date.now();
    if (!(pct > 0) || !(equityUsd > 0) || !(state.peakEquityUsd > 0)) return state;
    if (state.drawdownPauseUntil && state.drawdownPauseUntil > now) return state;
    if (state.drawdownPauseUntil && state.drawdownPauseUntil <= now) {
      await appendLog("info", "Drawdown pause over: new buys are allowed again.");
      return { ...state, drawdownPauseUntil: null, peakEquityUsd: equityUsd };
    }
    const drawdown = 1 - equityUsd / state.peakEquityUsd;
    if (drawdown * 100 >= pct) {
      await appendLog(
        "warning",
        `Account is ${(drawdown * 100).toFixed(1)}% below its peak (limit ${pct}%): pausing new buys for 24 hours. Open positions are still managed.`,
      );
      return { ...state, drawdownPauseUntil: now + 24 * 60 * 60 * 1000 };
    }
    return state;
  }

  /**
   * One exit-only poll: refresh marks, sell any position that breaches an
   * auto-exit rule, and stop the bot once the book is empty.
   */
  private async drainTick(settings: BotSettings, state: BotState): Promise<void> {
    const now = Date.now();
    let positions = await loadPositions();
    if (positions.length === 0) {
      this.desired = "stopped";
      await saveBotState({ ...state, runState: "stopped", desiredRunState: "stopped", stoppedAt: now, nextPollAt: null });
      await appendLog("info", "Auto-exit complete: all positions closed. Bot stopped.");
      return;
    }

    let remaining: BotPosition[];
    let liveBalance: LiveUsdcBalance | null = null;
    if (settings.mode === "real") {
      // Real-mode drain: reconcile authoritative positions, then place LIVE SELL
      // orders for any that breach a rule. liveAutoExit logs per position and
      // keeps a position whose sell fails so the next drain tick retries it.
      await this.reconcileLivePositionsState("drain");
      positions = await this.refreshMarkPrices(await loadPositions());
      remaining = await this.liveAutoExit(settings, positions);
      try {
        liveBalance = await getLiveUsdcBalance({ forceRefresh: true });
      } catch {
        // Keep prior accounting if the balance read fails.
      }
    } else {
      positions = await this.refreshMarkPrices(positions);
      const tp = settings.autoExitTakeProfitPercent;
      const sl = settings.autoExitStopLossPercent;
      const maxHoldMs = settings.autoExitMaxHoldMinutes * 60 * 1000;

      remaining = [];
      let exits = 0;
      for (const position of positions) {
        const price = clampPrice(position.markPrice);
        const costBasis = position.avgPrice * position.shares;
        const pnl = (price - position.avgPrice) * position.shares;
        const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
        const heldMs = now - position.openedAt;

        let exitReason: string | null = null;
        if (tp > 0 && pnlPct >= tp) exitReason = `take-profit ${pnlPct.toFixed(1)}% >= ${tp}%`;
        else if (sl > 0 && pnlPct <= -sl) exitReason = `stop-loss ${pnlPct.toFixed(1)}% <= -${sl}%`;
        else if (maxHoldMs > 0 && heldMs >= maxHoldMs)
          exitReason = `max-hold ${Math.floor(heldMs / 60000)}m >= ${settings.autoExitMaxHoldMinutes}m`;

        if (!exitReason) {
          remaining.push(position);
          continue;
        }

        const shares = position.shares;
        const copyAmountUsd = shares * price;
        const exitRecord = makeExitRecord(position, price, shares, copyAmountUsd, pnl, `Auto-exit: ${exitReason}.`, "auto-exit", now);
        await prependTrade(exitRecord);
        await analytics.recordExit(exitRecord, "auto-exit", position.sourceWallets);
        exits += 1;
      }
      if (exits > 0) await appendLog("info", `Auto-exit sold ${exits} position(s); ${remaining.length} remaining.`);
    }

    await savePositions(remaining);

    const allClosed = remaining.length === 0;
    const trades = await loadTrades();
    const metrics = buildMetrics(settings, state, remaining, trades, Date.now(), liveBalance?.usdcBalance);
    await saveBotState({
      ...metrics.state,
      runState: allClosed ? "stopped" : "draining",
      desiredRunState: allClosed ? "stopped" : "draining",
      stoppedAt: allClosed ? now : state.stoppedAt,
      lastPollAt: now,
      nextPollAt: allClosed ? null : now + settings.pollingIntervalSec * 1000,
      lastError: null,
    });
    await appendEquityPoint({
      ts: now,
      equityUsd: metrics.metrics.equityUsd,
      cashUsd: metrics.metrics.cashUsd,
      exposureUsd: metrics.metrics.totalExposureUsd,
    });

    if (allClosed) {
      this.desired = "stopped";
      await appendLog("info", "Auto-exit complete: all positions closed. Bot stopped.");
    }
  }

  /**
   * Real-money execution path (mode === "real"). Places live FAK market orders
   * through the Polymarket CLOB. Every BUY is clamped to config.liveMaxOrderUsd
   * as a hard backstop on top of the percentage-sizing and exposure caps already
   * enforced upstream. Any failure is recorded as a "failed" trade instead of
   * throwing, so the poll loop keeps running.
   */
  /** Remember which followed wallets bought which outcome (consensus boost). */
  private rememberLeaderBuy(trade: TraderTrade): void {
    const at = trade.timestamp * 1000;
    let byWallet = this.recentLeaderBuys.get(trade.tokenId);
    if (!byWallet) {
      byWallet = new Map();
      this.recentLeaderBuys.set(trade.tokenId, byWallet);
    }
    byWallet.set(trade.wallet.toLowerCase(), Math.max(at, byWallet.get(trade.wallet.toLowerCase()) ?? 0));
    if (this.recentLeaderBuys.size > 2000) {
      const cutoff = Date.now() - CONSENSUS_WINDOW_MS;
      for (const [token, wallets] of this.recentLeaderBuys) {
        for (const [w, ts] of wallets) if (ts < cutoff) wallets.delete(w);
        if (wallets.size === 0) this.recentLeaderBuys.delete(token);
      }
    }
  }

  /** How many OTHER followed wallets bought this outcome in the last hour. */
  private consensusWallets(trade: TraderTrade, now: number): number {
    const byWallet = this.recentLeaderBuys.get(trade.tokenId);
    if (!byWallet) return 0;
    const me = trade.wallet.toLowerCase();
    let n = 0;
    for (const [wallet, ts] of byWallet) if (wallet !== me && now - ts <= CONSENSUS_WINDOW_MS) n += 1;
    return n;
  }

  /** Leader's position size before this SELL (current holding + sold), if readable. */
  private async leaderSharesBefore(trade: TraderTrade): Promise<number | null> {
    try {
      const held = await fetchUserPositions(trade.wallet, 500);
      const current = held.find((position) => position.tokenId === trade.tokenId)?.size ?? 0;
      return current + trade.size;
    } catch {
      return null;
    }
  }

  private async executeRealTrade(
    trade: TraderTrade,
    settings: BotSettings,
    entry: EntryPlan | null,
    sellShares: number,
    market: Market | null,
    positions: BotPosition[],
    now: number,
    buyEdge: Partial<CopyTradeRecord> = {},
    meta: TokenMarketMeta | null = null,
  ): Promise<{ record: CopyTradeRecord; positions: BotPosition[] }> {
    const requestedUsd = entry && entry.ok ? entry.usd : 0;
    const fail = (reason: string): { record: CopyTradeRecord; positions: BotPosition[] } => ({
      record: makeRecord(trade, "failed", "real", requestedUsd, 0, 0, reason, market, now, buyEdge),
      positions,
    });

    try {
      assertLiveTradingAllowed();
    } catch (err) {
      return fail(`Real trade blocked: ${err instanceof Error ? err.message : "live trading is not allowed"}`);
    }

    if (trade.side === "BUY") {
      if (!entry || !entry.ok) return fail("Real BUY skipped: no valid entry plan.");
      try {
        const res = await placeLiveMarketOrder({
          tokenId: trade.tokenId,
          conditionId: trade.conditionId,
          side: "BUY",
          usdAmount: entry.usd,
          referencePrice: entry.bestAsk,
          limitPrice: entry.limitPrice,
        });
        clearLiveBalanceCache();
        if (res.pending) {
          // Exchange delayed the match: record it (no position yet) so
          // reconciliation picks up the real fill — or voids it — next poll.
          const record = makeRecord(
            trade,
            "copied",
            "real",
            0,
            0,
            0,
            `LIVE BUY $${entry.usd.toFixed(2)} submitted (limit ${(entry.limitPrice * 100).toFixed(1)}c) following ${trade.traderName}; exchange delayed the match - order ${res.orderId}.`,
            market,
            now,
            buyEdge,
          );
          record.txOrOrderId = res.orderId ?? "";
          record.reconciliationStatus = "pending";
          return { record, positions };
        }
        if (!res.success || res.filledShares <= 0) {
          return {
            record: makeRecord(
              trade,
              "skipped",
              "real",
              0,
              0,
              0,
              `Skipped LIVE BUY: ${res.error ?? "nothing filled at or below the limit price"} (limit ${(entry.limitPrice * 100).toFixed(1)}c).`,
              market,
              now,
              buyEdge,
            ),
            positions,
          };
        }
        const feeUsd = meta ? res.filledShares * takerFeeFraction(meta, res.effectivePrice) * res.effectivePrice : 0;
        const costPerShare = (res.notionalUsd + feeUsd) / res.filledShares;
        const nextPositions = applyBuy(positions, trade, market, res.filledShares, costPerShare, entry.bestAsk, now);
        const record = makeRecord(
          trade,
          "copied",
          "real",
          res.notionalUsd,
          res.filledShares,
          0,
          `LIVE BUY $${res.notionalUsd.toFixed(2)} (${res.filledShares.toFixed(2)} sh @ ${(res.effectivePrice * 100).toFixed(1)}c, limit ${(entry.limitPrice * 100).toFixed(1)}c${entry.bumpedToMinimum ? ", sized up to the market minimum" : ""}) following ${trade.traderName} - order ${res.orderId ?? "?"} [${res.status ?? "posted"}].`,
          market,
          now,
          { ...buyEdge, feeUsd, effectivePrice: costPerShare, referencePrice: entry.bestAsk },
        );
        record.txOrOrderId = res.orderId ?? "";
        record.reconciliationStatus = "pending";
        return { record, positions: nextPositions };
      } catch (err) {
        clearLiveBalanceCache();
        return fail(`Live BUY failed: ${messageFromUnknown(err)}.`);
      }
    }

    // SELL - only if we actually hold the token.
    const existing = positions.find((position) => position.tokenId === trade.tokenId);
    if (!existing || existing.shares <= 0) {
      return {
        record: makeRecord(trade, "skipped", "real", 0, 0, 0, `Observed trader SELL from ${trade.traderName}, but the bot never copied the original BUY (missed entry); nothing to sell.`, market, now),
        positions,
      };
    }
    // Don't sell a manual / pre-existing live position (unknown attribution &
    // cost basis) just because a followed wallet sold the same token.
    if (existing.sourceWallets.length === 0) {
      return {
        record: makeRecord(
          trade,
          "skipped",
          "real",
          0,
          0,
          0,
          "Observed trader SELL, but the held position is a manual/unknown live position; not auto-selling.",
          market,
          now,
        ),
        positions,
      };
    }
    const refPrice = clampPrice(market?.bestBid ?? market?.midpoint ?? trade.price);
    const requestedSellShares = Math.min(existing.shares, sellShares > 0 ? sellShares : existing.shares);
    const snapshot = await loadLivePositions();
    const sellSize = resolveLiveSellSize({
      position: existing,
      requestedShares: requestedSellShares,
      snapshot,
      now,
      maxSnapshotAgeMs: config.livePositionsStaleSeconds * 1000,
    });
    if (!sellSize.ok) return fail(`Skipped LIVE SELL: ${sellSize.reason}.`);
    if (sellSize.note) {
      await appendLog("warning", `LIVE SELL adjusted for ${existing.outcome}: ${sellSize.note}.`);
    }
    const sellPositions = positions.map((position) =>
      position.tokenId === existing.tokenId ? { ...position, shares: sellSize.bookSharesBeforeSell } : position,
    );
    const tick = meta?.tickSize ?? 0.01;
    try {
      const res = await placeLiveMarketOrder({
        tokenId: trade.tokenId,
        conditionId: trade.conditionId,
        side: "SELL",
        shares: sellSize.shares,
        referencePrice: refPrice,
        limitPrice: roundToTick(refPrice - 3 * tick, tick, "up"),
      });
      clearLiveBalanceCache();
      if (!res.success || res.filledShares <= 0) return fail(`Live SELL rejected: ${res.error ?? "unknown error"}.`);
      const feeUsd = meta ? res.filledShares * takerFeeFraction(meta, res.effectivePrice) * res.effectivePrice : 0;
      const sold = applySell(sellPositions, trade, res.filledShares, res.effectivePrice, feeUsd, refPrice, now);
      const record = makeRecord(
        trade,
        "copied",
        "real",
        sold.copyAmountUsd,
        sold.copiedShares,
        sold.realizedPnlUsd,
        `LIVE SELL $${sold.copyAmountUsd.toFixed(2)} (${formatLiveSellShares(sold.copiedShares)} sh @ ${(res.effectivePrice * 100).toFixed(1)}c) following ${trade.traderName} - order ${res.orderId ?? "?"} [${res.status ?? "posted"}].`,
        market,
        now,
        { feeUsd },
      );
      record.txOrOrderId = res.orderId ?? "";
      record.reconciliationStatus = "pending";
      return { record, positions: sold.positions };
    } catch (err) {
      clearLiveBalanceCache();
      return fail(`Live SELL failed: ${messageFromUnknown(err)}.`);
    }
  }

  /**
   * Fully-automatic live exits: on each running poll (real mode), sell any open
   * position that has hit the configured take-profit / stop-loss / max-hold,
   * independent of whether the leader sold. A position whose live sell fails is
   * kept so the next poll retries. Returns the surviving positions.
   */
  private async liveAutoExit(settings: BotSettings, positions: BotPosition[]): Promise<BotPosition[]> {
    const tp = settings.autoExitTakeProfitPercent;
    const sl = settings.autoExitStopLossPercent;
    const maxHoldMs = settings.autoExitMaxHoldMinutes * 60 * 1000;
    if (!(tp > 0 || sl > 0 || maxHoldMs > 0)) return positions;

    try {
      await getLiveUsdcBalance({ forceRefresh: true });
    } catch (err) {
      await appendLog("error", "Live auto-exit blocked: could not fetch live USDC balance: " + messageFromUnknown(err) + ". Keeping positions.");
      return positions;
    }

    const now = Date.now();
    const snapshot = await loadLivePositions();
    const remaining: BotPosition[] = [];
    for (const position of positions) {
      if (position.shares <= 0) continue;
      // Never auto-exit a position with unknown attribution / cost basis (manual
      // or pre-existing live position the bot did not open). Surfaced for manual
      // review instead of being market-sold on a guessed cost basis.
      if (position.sourceWallets.length === 0) {
        remaining.push(position);
        continue;
      }
      const price = clampPrice(position.markPrice);
      const costBasis = position.avgPrice * position.shares;
      const pnl = (price - position.avgPrice) * position.shares;
      const pnlPct = costBasis > 0 ? (pnl / costBasis) * 100 : 0;
      const heldMs = now - position.openedAt;

      let exitReason: string | null = null;
      if (tp > 0 && pnlPct >= tp) exitReason = `take-profit ${pnlPct.toFixed(1)}% >= ${tp}%`;
      else if (sl > 0 && pnlPct <= -sl) exitReason = `stop-loss ${pnlPct.toFixed(1)}% <= -${sl}%`;
      else if (maxHoldMs > 0 && heldMs >= maxHoldMs)
        exitReason = `max-hold ${Math.floor(heldMs / 60000)}m >= ${settings.autoExitMaxHoldMinutes}m`;

      if (!exitReason) {
        remaining.push(position);
        continue;
      }

      const sellSize = resolveLiveSellSize({
        position,
        requestedShares: position.shares,
        snapshot,
        now,
        maxSnapshotAgeMs: config.livePositionsStaleSeconds * 1000,
      });
      if (!sellSize.ok) {
        await appendLog("error", `Live auto-exit SELL blocked for ${position.outcome}: ${sellSize.reason}. Keeping position.`);
        remaining.push(position);
        continue;
      }
      if (sellSize.note) {
        await appendLog("warning", `Live auto-exit adjusted ${position.outcome}: ${sellSize.note}.`);
      }
      const bookPosition = { ...position, shares: sellSize.bookSharesBeforeSell };

      try {
        const res = await placeLiveMarketOrder({
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          side: "SELL",
          shares: sellSize.shares,
          ...(await liveExitPricing(position.tokenId, position.conditionId, price)),
        });
        clearLiveBalanceCache();
        if (!res.success || res.filledShares <= 0) {
          await appendLog("error", `Live auto-exit SELL rejected for ${position.outcome}: ${res.error ?? "unknown"}. Keeping position.`);
          remaining.push(bookPosition);
          continue;
        }
        const realized = (res.effectivePrice - bookPosition.avgPrice) * res.filledShares;
        const record = makeExitRecord(
          bookPosition,
          res.effectivePrice,
          res.filledShares,
          res.notionalUsd,
          realized,
          `LIVE auto-exit: ${exitReason} - order ${res.orderId ?? "?"}.`,
          "auto-exit",
          now,
        );
        record.mode = "real";
        record.status = "copied";
        record.txOrOrderId = res.orderId ?? "";
        record.reconciliationStatus = "pending";
        await prependTrade(record);
        await analytics.recordExit(record, "auto-exit", position.sourceWallets);
        await appendLog("info", `Live auto-exit sold ${formatLiveSellShares(res.filledShares)} ${position.outcome}: ${exitReason}.`);

        const remainder = Math.max(0, sellSize.bookSharesBeforeSell - res.filledShares);
        if (remainder > LIVE_SELL_DUST) {
          remaining.push({ ...bookPosition, shares: remainder, markPrice: clampPrice(res.effectivePrice), updatedAt: now });
          await appendLog("warning", `Live auto-exit kept ${formatLiveSellShares(remainder)} ${position.outcome} after a partial fill.`);
        }
      } catch (err) {
        clearLiveBalanceCache();
        await appendLog("error", `Live auto-exit SELL failed for ${position.outcome}: ${messageFromUnknown(err)}. Keeping position.`);
        remaining.push(bookPosition);
      }
    }
    return remaining;
  }

  /**
   * Annotate copied positions with whether their source leader still holds the
   * token, and - when exitWhenLeaderNoLongerHolds is on - exit positions the
   * leader has clearly left. Bounded: only fetches positions for the source
   * wallets of currently-open bot positions. Returns the surviving positions.
   */
  private async reconcileAndExitLeaders(settings: BotSettings, positions: BotPosition[]): Promise<BotPosition[]> {
    const botOpened = positions.filter((p) => p.sourceWallets.length > 0 && p.shares > 0);
    if (botOpened.length === 0) return positions;

    const wallets = sourceWalletsOf(botOpened).slice(0, MAX_LEADER_HOLDINGS_WALLETS);
    if (wallets.length === 0) return positions;

    // Read-only fetch of each leader's current positions. A failed fetch becomes
    // "no data" (→ unknown), never a false "exited" that could trigger a sale.
    const results = await Promise.all(
      wallets.map(async (wallet) => {
        try {
          return { wallet, positions: await fetchUserPositions(wallet) };
        } catch {
          return { wallet, positions: null };
        }
      }),
    );
    const holdings = buildLeaderHoldings(results);
    const now = Date.now();
    let annotated = reconcileLeaderHoldings(positions, holdings, now);

    if (!settings.exitWhenLeaderNoLongerHolds) return annotated;
    const toExit = selectLeaderExitedPositions(annotated);
    if (toExit.length === 0) return annotated;

    annotated =
      settings.mode === "real"
        ? await this.exitLeaderExitedLive(annotated, toExit, now)
        : await this.exitLeaderExitedSim(annotated, toExit, now);
    return annotated;
  }

  /** Simulation leader-exit: sell each leader-exited position at its current mark. */
  private async exitLeaderExitedSim(
    positions: BotPosition[],
    toExit: BotPosition[],
    now: number,
  ): Promise<BotPosition[]> {
    const exitTokens = new Set(toExit.map((p) => p.tokenId));
    const survivors: BotPosition[] = [];
    for (const position of positions) {
      if (!exitTokens.has(position.tokenId) || position.shares <= 0) {
        survivors.push(position);
        continue;
      }
      const price = clampPrice(position.markPrice);
      const shares = position.shares;
      const copyAmountUsd = shares * price;
      const pnl = (price - position.avgPrice) * shares;
      const exitRecord = makeExitRecord(
        position,
        price,
        shares,
        copyAmountUsd,
        pnl,
        `Leader exited, flattening: sold ${shares.toFixed(2)} ${position.outcome} @ ${(price * 100).toFixed(1)}c (leader no longer holds).`,
        "leader-exit",
        now,
      );
      await prependTrade(exitRecord);
      await analytics.recordExit(exitRecord, "leader-exit", position.sourceWallets);
      await appendLog("info", `Leader exited ${position.outcome} (${position.marketTitle}); flattened copied position at mark.`);
    }
    return survivors;
  }

  /**
   * Real-mode leader-exit: sell each leader-exited (bot-opened) position via a
   * live CLOB SELL, but ONLY when live data is healthy (see liveExitHealth). A
   * blocked or failed sell keeps the position and logs a distinct reason so the
   * dashboard can show "leader exited but live sell blocked".
   */
  private async exitLeaderExitedLive(
    positions: BotPosition[],
    toExit: BotPosition[],
    now: number,
  ): Promise<BotPosition[]> {
    const [snapshot, trades] = await Promise.all([loadLivePositions(), loadTrades()]);
    const health = liveExitHealth(snapshot, trades, now);
    const exitTokens = new Set(toExit.map((p) => p.tokenId));
    const DUST = 1e-6;
    const survivors: BotPosition[] = [];

    for (const position of positions) {
      if (!exitTokens.has(position.tokenId) || position.shares <= DUST) {
        survivors.push(position);
        continue;
      }
      if (!health.ok) {
        survivors.push(position);
        await appendLog(
          "warning",
          `Leader exited ${position.outcome} (${position.marketTitle}), but live sell is blocked: ${health.reason}. Keeping position.`,
        );
        continue;
      }
      const price = clampPrice(position.markPrice);
      const sellSize = resolveLiveSellSize({
        position,
        requestedShares: position.shares,
        snapshot,
        now,
        maxSnapshotAgeMs: config.livePositionsStaleSeconds * 1000,
      });
      if (!sellSize.ok) {
        survivors.push(position);
        await appendLog("error", `Leader-exit SELL blocked for ${position.outcome}: ${sellSize.reason}. Keeping position.`);
        continue;
      }
      if (sellSize.note) {
        await appendLog("warning", `Leader-exit adjusted ${position.outcome}: ${sellSize.note}.`);
      }
      const bookPosition = { ...position, shares: sellSize.bookSharesBeforeSell };
      try {
        const res = await placeLiveMarketOrder({
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          side: "SELL",
          shares: sellSize.shares,
          ...(await liveExitPricing(position.tokenId, position.conditionId, price)),
        });
        clearLiveBalanceCache();
        if (!res.success || res.filledShares <= 0) {
          survivors.push(bookPosition);
          await appendLog("error", `Leader-exit SELL rejected for ${position.outcome}: ${res.error ?? "unknown"}. Keeping position.`);
          continue;
        }
        const realized = (res.effectivePrice - bookPosition.avgPrice) * res.filledShares;
        const record = makeExitRecord(
          bookPosition,
          res.effectivePrice,
          res.filledShares,
          res.notionalUsd,
          realized,
          `LIVE leader-exit: sold ${formatLiveSellShares(res.filledShares)} ${position.outcome} @ ${(res.effectivePrice * 100).toFixed(1)}c (leader no longer holds) - order ${res.orderId ?? "?"}.`,
          "leader-exit",
          now,
        );
        record.mode = "real";
        record.status = "copied";
        record.txOrOrderId = res.orderId ?? "";
        record.reconciliationStatus = "pending";
        await prependTrade(record);
        await analytics.recordExit(record, "leader-exit", position.sourceWallets);
        await appendLog("info", `Leader exited ${position.outcome}; flattened copied position via live SELL.`);

        const remainder = Math.max(0, sellSize.bookSharesBeforeSell - res.filledShares);
        if (remainder > LIVE_SELL_DUST) {
          survivors.push({ ...bookPosition, shares: remainder, markPrice: clampPrice(res.effectivePrice), updatedAt: now });
        }
      } catch (err) {
        clearLiveBalanceCache();
        survivors.push(bookPosition);
        await appendLog("error", `Leader-exit SELL failed for ${position.outcome}: ${messageFromUnknown(err)}. Keeping position.`);
      }
    }
    return survivors;
  }

  private async processTrade(
    trade: TraderTrade,
    settings: BotSettings,
    state: BotState,
    positions: BotPosition[],
    walletCycleCopies: Map<string, number>,
    trader: FollowedTrader | null = null,
    capture?: DecisionCapture,
  ): Promise<{ record: CopyTradeRecord; positions: BotPosition[] }> {
    const now = Date.now();
    const tradeAgeSec = Math.max(0, Math.floor(now / 1000) - trade.timestamp);
    let market: Market | null = null;
    const [gammaMarket, outcomeBook, tokenMeta] = await Promise.all([
      fetchMarketById(trade.tokenId).catch(() => null),
      tryGetOutcomeBook(trade.tokenId),
      getTokenMarketMeta(trade.tokenId, trade.conditionId).catch((): TokenMarketMeta | null => null),
    ]);
    market = withOutcomeQuotes(gammaMarket, outcomeBook);
    // Analytics capture (observational only — reads computed values; no effect on
    // any decision below).
    if (capture) {
      capture.market = market;
      capture.tradeAgeSec = tradeAgeSec;
    }

    const priorTrades = await loadTrades();
    const localAvailableBalanceUsd = calculateAvailableBalance(settings, positions, priorTrades);
    const exposureUsd = totalExposure(positions);
    const marketExposureUsd = positions
      .filter((position) => position.conditionId === trade.conditionId || position.tokenId === trade.tokenId)
      .reduce((sum, position) => sum + positionExposure(position), 0);
    if (capture) {
      capture.exposureBeforeUsd = exposureUsd;
      capture.marketExposureBeforeUsd = marketExposureUsd;
      capture.availableCashUsd = localAvailableBalanceUsd;
      capture.equityUsd = localAvailableBalanceUsd + exposureUsd;
    }

    // Edge metrics for copied BUYs - recorded on every BUY record (filled or
    // skipped) so the dashboard can show leader vs bot price and the adverse move.
    const adverse: AdverseEntry | null = trade.side === "BUY" ? evaluateAdverseEntry(settings, trade, market) : null;
    const buyEdge: Partial<CopyTradeRecord> = adverse
      ? {
          leaderPrice: adverse.leaderPrice ?? undefined,
          botExecPrice: adverse.botExecPrice ?? undefined,
          adverseMoveCents: adverse.adverseMoveCents ?? undefined,
        }
      : {};

    const skip = (reason: string, extra?: Partial<CopyTradeRecord>) => ({
      record: makeRecord(trade, "skipped", settings.mode, 0, 0, 0, reason, market, now, { ...buyEdge, ...extra }),
      positions,
    });
    const fail = (reason: string, extra?: Partial<CopyTradeRecord>) => ({
      record: makeRecord(trade, "failed", settings.mode, 0, 0, 0, reason, market, now, { ...buyEdge, ...extra }),
      positions,
    });

    // Freshness: hard 5-min absolute cap for all sides; real-mode BUYs honour the
    // stricter live freshness window (effectiveMaxCopyAgeSec).
    const maxAgeSec = effectiveMaxCopyAgeSec(settings, trade.side);
    if (tradeAgeSec > maxAgeSec) {
      if (settings.mode === "real" && trade.side === "BUY") {
        return skip(`Skipped LIVE BUY: trade is ${tradeAgeSec}s old (live freshness max ${maxAgeSec}s).`);
      }
      return skip(`Skipped stale trade from ${trade.traderName}: ${tradeAgeSec}s old (max ${maxAgeSec}s).`);
    }
    if (trade.price <= 0 || trade.price >= 1 || trade.size <= 0) {
      return skip("Skipped malformed trade from " + trade.traderName + ".");
    }
    // Never copy into a market that has already resolved/closed.
    if (isMarketResolved(market)) {
      return skip("Skipped trade from " + trade.traderName + ": market is resolved/closed.");
    }

    const filterReason = buyMarketFilterReason(settings, trade, market);
    if (filterReason) return skip(filterReason);

    // Adverse-entry gate: don't chase a BUY whose price already ran past the
    // leader's fill. Pure; missing/invalid prices don't trip it.
    if (adverse?.reason) return skip(adverse.reason);

    if (trade.side === "BUY") {
      if (trader?.exitOnly) {
        return skip("Skipped BUY: this trader is kept only to mirror exits of positions copied earlier.");
      }
      if (
        settings.maxHoursToResolution > 0 &&
        market?.timeToResolutionMs != null &&
        market.timeToResolutionMs > settings.maxHoursToResolution * 3600 * 1000
      ) {
        return skip(
          `Skipped BUY: market resolves in ${(market.timeToResolutionMs / 86_400_000).toFixed(0)} days; limit is ${(settings.maxHoursToResolution / 24).toFixed(0)} days (money would be tied up too long).`,
        );
      }
      const alreadyHeld = positions.some((position) => position.tokenId === trade.tokenId);
      if (settings.maxOpenPositions > 0 && !alreadyHeld && positions.length >= settings.maxOpenPositions) {
        return skip(`Skipped BUY: already holding the maximum of ${settings.maxOpenPositions} positions.`);
      }
      if (state.drawdownPauseUntil && state.drawdownPauseUntil > now) {
        return skip("Skipped BUY: new buys are paused after a drawdown (resumes automatically).");
      }
    }

    // Per-copied-wallet controls (entries only - never block exits). These keep a
    // single hot wallet from dominating the session regardless of global caps.
    if (trade.side === "BUY") {
      if (settings.maxCopiesPerWalletPerCycle > 0) {
        const already = walletCycleCopies.get(trade.wallet) ?? 0;
        if (already >= settings.maxCopiesPerWalletPerCycle) {
          return skip(
            "Skipped BUY: wallet copy cap of " +
              settings.maxCopiesPerWalletPerCycle +
              " trade(s) per poll cycle reached for this wallet.",
          );
        }
      }
      if (settings.walletTradeCooldownSec > 0) {
        const cooldownMs = settings.walletTradeCooldownSec * 1000;
        const lastCopy = priorTrades.find(
          (record) =>
            record.traderWallet === trade.wallet &&
            record.conditionId === trade.conditionId &&
            (record.status === "copied" || record.status === "simulated"),
        );
        if (lastCopy && now - lastCopy.processedAt < cooldownMs) {
          const remainingSec = Math.ceil((cooldownMs - (now - lastCopy.processedAt)) / 1000);
          return skip(
            "Skipped BUY: same wallet/market cooldown active (" + remainingSec + "s of " + settings.walletTradeCooldownSec + "s remaining).",
          );
        }
      }
    }

    let availableBalanceUsd = localAvailableBalanceUsd;
    let equityUsd = localAvailableBalanceUsd + exposureUsd;
    let liveBalance: LiveUsdcBalance | null = null;
    if (config.livePrivateKey.trim() || config.liveFunderAddress.trim()) {
      try {
        // Force-refresh in real mode; use cached value in sim to avoid extra network hits.
        liveBalance = await getLiveUsdcBalance({ forceRefresh: settings.mode === "real" });
        availableBalanceUsd = liveBalance.usdcBalance;
        equityUsd = liveBalance.usdcBalance + exposureUsd;
      } catch (err) {
        if (settings.mode === "real") {
          return fail("Real trade blocked: could not fetch live USDC balance: " + messageFromUnknown(err) + ".");
        }
        // Sim mode: non-fatal, fall back to accounting model balance.
      }
    } else if (settings.mode === "real") {
      return fail("Real trade blocked: no live private key configured.");
    }

    // Base sizing, then optional leader-conviction scaling for BUYs. Conviction
    // only scales the base and is hard-clamped to maxTradeAmountUsd inside
    // applyConvictionSizing; every other cap (live max order, exposure, available
    // balance) is still enforced by the requestedAmountUsd clamp below.
    const baseStrategyAmountUsd = calculateNextTradeSize(settings, availableBalanceUsd, equityUsd);
    let strategyAmountUsd =
      trade.side === "BUY" ? applyConvictionSizing(baseStrategyAmountUsd, trade, trader, settings) : baseStrategyAmountUsd;
    const consensusWallets = trade.side === "BUY" ? this.consensusWallets(trade, now) : 0;
    if (trade.side === "BUY" && settings.consensusBoost && consensusWallets > 0) {
      strategyAmountUsd = Math.min(
        strategyAmountUsd * CONSENSUS_SIZE_MULTIPLIER,
        settings.maxTradeAmountUsd * CONSENSUS_SIZE_MULTIPLIER,
      );
    }
    const perMarketCapUsd = dollarCapFromPercent(equityUsd, settings.maxExposurePerMarketPercent);
    const totalCapUsd = dollarCapFromPercent(equityUsd, settings.maxTotalExposurePercent);
    const dailyLossCapUsd = dollarCapFromPercent(state.dailyStartEquityUsd, settings.maxDailyLossPercent);
    const dailyStartBotPnlUsd = Number.isFinite(state.dailyStartBotPnlUsd) ? state.dailyStartBotPnlUsd : 0;
    const dailyPnlUsd = cumulativeBotPnlUsd(positions, priorTrades) - dailyStartBotPnlUsd;
    const remainingPerMarketUsd = Math.max(0, perMarketCapUsd - marketExposureUsd);
    const remainingTotalExposureUsd = Math.max(0, totalCapUsd - exposureUsd);
    const remainingAllowedExposureUsd = Math.min(remainingPerMarketUsd, remainingTotalExposureUsd);
    // Cash cushion: never spend below max(reserve % of account value, min balance).
    const reserveUsd = Math.max(
      dollarCapFromPercent(equityUsd, settings.cashReservePercent ?? 0),
      settings.minAvailableBalanceUsd,
    );
    const walletCapUsd =
      settings.maxExposurePerWalletPercent > 0
        ? Math.max(0, dollarCapFromPercent(equityUsd, settings.maxExposurePerWalletPercent) - walletExposure(positions, trade.wallet))
        : Number.POSITIVE_INFINITY;
    // Largest BUY every cap still allows. The same constraints apply in both
    // modes so simulation sizing matches live.
    const maxAllowedBuyUsd = Math.max(
      0,
      Math.min(availableBalanceUsd - reserveUsd, config.liveMaxOrderUsd, remainingAllowedExposureUsd, walletCapUsd),
    );
    const requestedAmountUsd =
      trade.side === "BUY" ? Math.min(strategyAmountUsd, maxAllowedBuyUsd) : strategyAmountUsd;
    if (capture) {
      capture.availableCashUsd = availableBalanceUsd;
      capture.equityUsd = equityUsd;
      capture.liveBalanceUsd = liveBalance ? liveBalance.usdcBalance : null;
      capture.strategyAmountUsd = strategyAmountUsd;
      capture.requestedAmountUsd = requestedAmountUsd;
      capture.perMarketCapUsd = perMarketCapUsd;
      capture.totalCapUsd = totalCapUsd;
      capture.dailyPnlUsd = dailyPnlUsd;
    }

    // Hard daily-loss lockout and panic stop: block NEW BUYs only. Exits (SELLs)
    // and flattening always remain allowed so positions can still be unwound.
    const dailyLossCapInvalid = !Number.isFinite(settings.maxDailyLossPercent) || settings.maxDailyLossPercent <= 0;
    const dailyLossBreached = !dailyLossCapInvalid && dailyLossCapUsd > 0 && dailyPnlUsd <= -dailyLossCapUsd;
    if (trade.side === "BUY" && (state.panic || dailyLossCapInvalid || state.dailyLossLockout || dailyLossBreached)) {
      if (state.panic) {
        return skip("Skipped BUY: panic stop is engaged. New entries are disabled until panic is cleared.");
      }
      if (dailyLossCapInvalid) {
        return skip(
          "Skipped BUY: daily loss cap is invalid (" +
            settings.maxDailyLossPercent +
            "% of bankroll). Set Daily loss cap above 0% to resume BUYs.",
        );
      }
      return skip(
        "Skipped BUY: bot daily loss limit hit (" +
          settings.maxDailyLossPercent +
          "% of bankroll). BUYs disabled until next session/day.",
      );
    }
    // Centralized live-state readiness gate for NEW live BUYs: refuse if any live
    // data / reconciliation / position state is uncertain (unmatched or errored
    // fills, stale pending orders, unreconciled cap, missing/stale/unknown live
    // positions). Exits are never blocked by this.
    if (settings.mode === "real" && trade.side === "BUY") {
      const livePositionsSnapshot = await loadLivePositions();
      const readiness = evaluateBuyReadiness({
        settings,
        state,
        trades: priorTrades,
        livePositions: livePositionsSnapshot,
        now,
      });
      if (!readiness.buysAllowed) {
        return skip("Skipped LIVE BUY (readiness): " + readiness.blockers.map((b) => b.detail).join(" | "));
      }
    }
    let entry: EntryPlan | null = null;
    let sellShares = 0;
    if (trade.side === "BUY") {
      if (settings.minMarketLiquidityUsd > 0 && marketLiquidity(market) < settings.minMarketLiquidityUsd) {
        return skip("Skipped BUY: market liquidity is below the configured minimum or could not be verified.");
      }
      if (remainingPerMarketUsd <= 0) {
        return skip("Skipped BUY: per-market limit (" + settings.maxExposurePerMarketPercent + "% of account) already reached.");
      }
      if (remainingTotalExposureUsd <= 0) {
        return skip("Skipped BUY: total invested limit (" + settings.maxTotalExposurePercent + "% of account) already reached.");
      }
      if (availableBalanceUsd - reserveUsd <= 0) {
        return skip("Skipped BUY: keeping the $" + reserveUsd.toFixed(2) + " cash cushion.");
      }
      entry = planEntry({
        leaderPrice: trade.price,
        quote: outcomeBook ?? (market ? { bestBid: market.bestBid, bestAsk: market.bestAsk, midpoint: market.midpoint } : null),
        params: tokenMeta ?? { minOrderSize: 5, tickSize: 0.01, feeRate: 0.05, feeExponent: 1 },
        requestedUsd: requestedAmountUsd,
        maxAllowedUsd: maxAllowedBuyUsd,
        maxAdverseEntryMoveCents: settings.maxAdverseEntryMoveCents,
        maxEntryCostPercent: settings.maxEntryCostPercent,
      });
      if (!entry.ok) return skip(entry.reason);
      if (isBelowTradeMinimum(settings, entry.usd)) {
        return skip("Skipped BUY: order $" + entry.usd.toFixed(2) + " is below the configured minimum $" + settings.minTradeAmountUsd.toFixed(2) + ".");
      }
      if (capture) capture.requestedAmountUsd = entry.usd;
    } else {
      const existing = positions.find((position) => position.tokenId === trade.tokenId);
      if (existing && existing.shares > 0) {
        sellShares =
          settings.sellBehavior === "all"
            ? existing.shares
            : proportionalSellShares({
                heldShares: existing.shares,
                leaderSoldShares: trade.size,
                leaderSharesBefore: await this.leaderSharesBefore(trade),
                minOrderSize: tokenMeta?.minOrderSize ?? 5,
              });
      }
    }


    if (settings.mode === "real") {
      return this.executeRealTrade(trade, settings, entry, sellShares, market, positions, now, buyEdge, tokenMeta);
    }

    const refPrice = clampPrice(trade.price);
    const simBuyUsd = entry && entry.ok ? entry.usd : requestedAmountUsd;
    // Simulation charges the market's real taker fee (at the expected fill price)
    // instead of a flat setting, so paper P&L matches what live would net.
    const feePrice = trade.side === "BUY" ? (entry && entry.ok ? entry.bestAsk : refPrice) : market?.bestBid ?? refPrice;
    const simFeeBps = tokenMeta ? takerFeeFraction(tokenMeta, feePrice) * 10_000 : settings.takerFeeBps;
    const costSettings: FillCostSettings = {
      takerFeeBps: simFeeBps,
      maxSlippageBps: settings.maxSlippageBps,
      fallbackSpreadBps: settings.fallbackSpreadBps,
    };
    const fetchBookSafe = async (): Promise<OrderBook | null> => {
      try {
        return await fetchBook(trade.tokenId);
      } catch {
        return null;
      }
    };

    if (trade.side === "BUY") {
      if (!settings.realisticFills) {
        const shares = simBuyUsd / refPrice;
        return {
          positions: applyBuy(positions, trade, market, shares, refPrice, refPrice, now),
          record: makeRecord(
            trade,
            "simulated",
            settings.mode,
            simBuyUsd,
            shares,
            0,
            `Simulated BUY ${simBuyUsd.toFixed(2)} USD following ${trade.traderName} (idealized fill).`,
            market,
            now,
            buyEdge,
          ),
        };
      }

      const fill = simulateFill({
        side: "BUY",
        book: outcomeBook ?? (await fetchBookSafe()),
        referencePrice: refPrice,
        marketBestBid: market?.bestBid ?? null,
        marketBestAsk: market?.bestAsk ?? null,
        marketMid: market?.midpoint ?? null,
        desiredUsd: simBuyUsd,
        settings: costSettings,
      });
      if (fill.status === "rejected" || fill.filledShares <= 0) {
        return skip(`Skipped BUY: ${fill.note}`);
      }
      const cashOut = fill.notionalUsd + fill.feeUsd;
      const effPrice = cashOut / fill.filledShares;
      return {
        positions: applyBuy(positions, trade, market, fill.filledShares, effPrice, fill.referenceMid, now),
        record: makeRecord(
          trade,
          "simulated",
          settings.mode,
          cashOut,
          fill.filledShares,
          0,
          `Simulated BUY $${cashOut.toFixed(2)} (${fill.filledShares.toFixed(2)} sh @ ${(effPrice * 100).toFixed(1)}c, ${fill.note}, fee $${fill.feeUsd.toFixed(2)})${fill.status === "partial" ? " [partial]" : ""} following ${trade.traderName}.`,
          market,
          now,
          { ...fillToExtra(fill), ...buyEdge },
        ),
      };
    }

    // SELL
    const existing = positions.find((position) => position.tokenId === trade.tokenId);
    if (!existing || existing.shares <= 0) {
      return skip(`Observed trader SELL from ${trade.traderName}, but the bot never copied the original BUY (missed entry); nothing to sell.`);
    }
    const sharesToSell = Math.min(existing.shares, sellShares > 0 ? sellShares : existing.shares);
    if (sharesToSell <= 0) return skip("Skipped SELL: calculated sell size was zero.");

    if (!settings.realisticFills) {
      const sold = applySell(positions, trade, sharesToSell, refPrice, 0, refPrice, now);
      return {
        positions: sold.positions,
        record: makeRecord(
          trade,
          "simulated",
          settings.mode,
          sold.copyAmountUsd,
          sold.copiedShares,
          sold.realizedPnlUsd,
          `Simulated SELL ${sold.copyAmountUsd.toFixed(2)} USD following ${trade.traderName} (idealized fill).`,
          market,
          now,
        ),
      };
    }

    const fill = simulateFill({
      side: "SELL",
      book: outcomeBook ?? (await fetchBookSafe()),
      referencePrice: refPrice,
      marketBestBid: market?.bestBid ?? null,
      marketBestAsk: market?.bestAsk ?? null,
      marketMid: market?.midpoint ?? null,
      desiredShares: sharesToSell,
      settings: costSettings,
    });
    if (fill.status === "rejected" || fill.filledShares <= 0) {
      return skip(`Skipped SELL: ${fill.note}`);
    }
    const sold = applySell(positions, trade, fill.filledShares, fill.fillPrice, fill.feeUsd, fill.referenceMid, now);
    return {
      positions: sold.positions,
      record: makeRecord(
        trade,
        "simulated",
        settings.mode,
        sold.copyAmountUsd,
        sold.copiedShares,
        sold.realizedPnlUsd,
        `Simulated SELL $${sold.copyAmountUsd.toFixed(2)} (${sold.copiedShares.toFixed(2)} sh @ ${(fill.fillPrice * 100).toFixed(1)}c, ${fill.note}, fee $${fill.feeUsd.toFixed(2)})${fill.status === "partial" ? " [partial]" : ""} following ${trade.traderName}.`,
        market,
        now,
        fillToExtra(fill),
      ),
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __copyBotEngine: CopyBotEngine | undefined;
}

export function getCopyBotEngine(): CopyBotEngine {
  globalThis.__copyBotEngine ??= new CopyBotEngine();
  return globalThis.__copyBotEngine;
}












