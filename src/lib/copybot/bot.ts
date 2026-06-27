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
import {
  buildLeaderHoldings,
  reconcileLeaderHoldings,
  selectLeaderExitedPositions,
  sourceWalletsOf,
} from "./leaderPositions";
import { fetchUserPositions } from "@/lib/polymarket/positions";
import { inspectBullpenCli } from "./bullpen";
import {
  applyRiskPreset,
  isRiskPresetId,
  presetControlledKeys,
  presetControlledValues,
  RISK_PRESETS,
} from "./riskPresets";
import { assertLiveTradingAllowed, CLOB_MIN_MARKET_BUY_USD, placeLiveMarketOrder, PusdBalanceUnavailableError, type LiveUsdcBalance } from "@/lib/execution/liveClob";
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
  loadRedeemBook,
  loadSeenTrades,
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
 * must never be copied into ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â the leader's trade is on a market that's already
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
 * position whose market is merely halted ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â when in doubt we return null and the
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
    liveMaxCopyTradeAgeSec: sanitizeNumber(next.liveMaxCopyTradeAgeSec, current.liveMaxCopyTradeAgeSec, 5, 300),
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
  });
}

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
 * trader's trade ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â i.e. a session-close liquidation or an auto-exit rule firing.
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
 * Build a simulated SELL record that realizes a position at market resolution ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â
 * the winning outcome pays $1/share and the loser $0. Unlike a mark-priced exit
 * the settlement price is exact (not clamped to the 0.01ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ0.99 trading band), so
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

export class CopyBotEngine {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private lastHeartbeatLogAt = 0;
  private buyExposurePaused = false;
  // Analytics-only cadence guards (observational; never gate trading).
  private lastAnalyticsSnapshotAt = 0;
  private lastAnalyticsMaintenanceAt = 0;

  async status(): Promise<BotStatus> {
    await ensureDataFiles();
    const settings = await loadSettings();
    const [state, traders, positions, trades, equityCurve, logs, bullpen, livePositions, redeemBook] = await Promise.all([
      loadBotState(settings),
      loadTraders(),
      loadPositions(),
      loadTrades(),
      loadEquityCurve(settings),
      loadLogs(),
      inspectBullpenCli(),
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
    let statusState = built.state;
    if (
      statusState.peakEquityUsd !== state.peakEquityUsd ||
      statusState.dailyDate !== state.dailyDate ||
      statusState.dailyStartEquityUsd !== state.dailyStartEquityUsd ||
      statusState.dailyStartBotPnlUsd !== state.dailyStartBotPnlUsd ||
      statusState.dailyLossLockout !== state.dailyLossLockout
    ) {
      await saveBotState(statusState);
    }

    if ((statusState.runState === "running" || statusState.runState === "draining") && !this.timer && !this.inFlight) {
      statusState = {
        ...statusState,
        runState: "stopped",
        stoppedAt: Date.now(),
        nextPollAt: null,
        lastError: null,
      };
      await saveBotState(statusState);
      await appendLog("info", `Bot was marked ${state.runState} from a previous server session; left stopped until Start is clicked.`);
    }

    const scoreboard = buildScoreboard(settings, statusState, statusMetrics, positions, trades);
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
      recentTrades: trades.slice(0, 100),
      equityCurve,
      logs,
      livePositions: settings.mode === "real" ? livePositions : null,
      redeemables: buildRedeemablePlan(settings.mode === "real" ? livePositions : null, redeemBook, settings.mode),
    };
  }

  async start(): Promise<BotStatus> {
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
          `Starting balance auto-synced to live wallet: $${prev.toFixed(2)} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ $${settings.startingBalance.toFixed(2)}.`,
        );
      }
      state = {
        ...state,
        dailyDate: todayKey(now),
        dailyStartEquityUsd: liveEquityUsd,
        dailyStartBotPnlUsd,
        peakEquityUsd: liveEquityUsd,
        dailyLossLockout: false,
      };
      await appendLog(
        "info",
        `Real bankroll synced from live balance: cash $${startupLiveBalance.usdcBalance.toFixed(2)}, equity $${liveEquityUsd.toFixed(2)}.`,
      );
    }
    state = {
      ...state,
      runState: "running",
      startedAt: now,
      stoppedAt: null,
      pausedAt: null,
      nextPollAt: now + settings.pollingIntervalSec * 1000,
      lastError: null,
      sessionWalletsChecked: 0,
      sessionTradesScanned: 0,
    };
    await saveBotState(state);
    await appendLog("info", `Bot started in ${settings.mode} mode.`);
    await this.discover(true);
    await this.bootstrapSeenTrades();
    this.schedule(0);
    return this.status();
  }

  async forceDiscover(): Promise<BotStatus> {
    await this.discover(true);
    return this.status();
  }

  async pause(): Promise<BotStatus> {
    this.clearTimer();
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    await saveBotState({ ...state, runState: "paused", pausedAt: Date.now(), nextPollAt: null });
    await appendLog("info", "Bot paused.");
    return this.status();
  }

  async stop(opts: { liquidate?: boolean; source?: ExitSource } = {}): Promise<BotStatus> {
    this.clearTimer();
    const settings = await loadSettings();
    let liq: FlattenResult | null = null;
    if (opts.liquidate) {
      liq = await this.flatten(opts.source ?? "session-close");
    }
    const state = await loadBotState(settings);
    await saveBotState({ ...state, runState: "stopped", stoppedAt: Date.now(), pausedAt: null, nextPollAt: null });
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
    this.clearTimer();
    const settings = await loadSettings();
    let state = await loadBotState(settings);
    const now = Date.now();
    const reason = opts.reason?.trim() || "Panic stop engaged by operator.";

    state = {
      ...state,
      runState: "stopped",
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
   * Clear a latched panic stop. Leaves the bot stopped ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â the operator must Start
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
    // while the bot is stopped. Read-only ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â it never places an order, and it logs
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

    // Recompute equity/metrics ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â also when reconciliation just emptied the book ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â
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
   *   - it is a manual/unknown live position (no source attribution) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â not the
   *     bot's to close;
   *   - its market has already resolved ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â resolved positions have no order book
   *     and Polymarket auto-redeems them to cash on settlement, so we never fake
   *     a CLOB sale for them;
   *   - the live SELL fails or only partially fills ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â the remainder is kept so the
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
    // redeemable (no order book ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â they auto-redeem and must not be CLOB-sold).
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
      // Resolved markets auto-redeem to cash ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â don't try (and fail) to sell them.
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
          side: "SELL",
          shares: sellSize.shares,
          referencePrice: price,
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
      pausedAt: null,
      nextPollAt: now + settings.pollingIntervalSec * 1000,
      lastError: null,
    });
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
   * The winning outcome pays $1/share and the loser $0 ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â we book a settlement
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
      for (const trade of initialTrades) ids.add(sourceTradeId(trade));
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
      void this.tick();
    }, Math.max(0, delayMs));
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

    const [traders, trades] = await Promise.all([loadTraders(), loadTrades()]);
    const previousWallets = new Set(traders.map((trader) => trader.wallet));
    const discovered = await discoverTraders(settings, traders, trades, now);
    await saveTraders(discovered);

    const newWallets = discovered
      .filter((trader) => trader.enabled && !previousWallets.has(trader.wallet))
      .map((trader) => trader.wallet);
    if (newWallets.length > 0) {
      try {
        const seen = await loadSeenTrades();
        const ids = new Set(seen.ids);
        const existingTrades = await fetchTradesForWallets(newWallets, 30);
        for (const trade of existingTrades) ids.add(sourceTradeId(trade));
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
    for (const trade of existingTrades) ids.add(sourceTradeId(trade));
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
    const { matched, partial, unmatched, fetchedFills, error } = result.summary;
    if (error) {
      await appendLog("error", `Live reconciliation (${context}) failed: ${error}. Live orders flagged unverified.`);
    } else if (matched + partial + unmatched > 0) {
      await appendLog(
        unmatched > 0 ? "warning" : "info",
        `Live reconciliation (${context}): ${matched} matched, ${partial} partial, ${unmatched} unmatched vs ${fetchedFills} CLOB fill(s).`,
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
   * snapshot (reconciled on poll/startup) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â never trades and never hits the chain.
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
      // Skip positions the bot can't redeem itself (proxy/safe/neg-risk) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â they
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
        `Redeemed ${item.outcome} (${item.marketTitle}): ${item.shares.toFixed(2)} share(s) ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ $${payoutUsd.toFixed(2)}${result.txHash ? ` [tx ${result.txHash.slice(0, 10)}ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦]` : ""}.`,
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

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;

    try {
      const settings = await loadSettings();
      let state = await loadBotState(settings);
      if (state.runState === "draining") {
        await this.drainTick(settings, state);
        return;
      }
      if (state.runState !== "running") return;

      await this.discover(false);
      state = await loadBotState(settings);
      if (state.runState !== "running") return;
      const traders = await loadTraders();
      const traderByWallet = new Map(traders.map((t) => [t.wallet.toLowerCase(), t]));
      const wallets = enabledWallets(traders, MAX_WALLETS_PER_POLL);
      const now = Date.now();
      state = {
        ...state,
        lastPollAt: now,
        nextPollAt: now + settings.pollingIntervalSec * 1000,
      };
      await saveBotState(state);

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
        const id = sourceTradeId(trade);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        if (exposurePausedForBuys && trade.side === "BUY") {
          pausedBuyCount += 1;
          continue;
        }
        const trader = traderByWallet.get(trade.wallet.toLowerCase()) ?? null;
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
          bucket.count > 1 ? `${bucket.reason} (ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â${bucket.count} this cycle)` : bucket.reason,
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

      await savePositions(positions);
      await saveSeenTrades({ ids: [...seenIds] });

      // Analytics (observational only): periodically snapshot the open-position
      // timeline and run bounded background maintenance. Both are self-guarding
      // (never throw) and rate-limited so they add negligible poll overhead.
      if (now - this.lastAnalyticsSnapshotAt >= 60_000) {
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
      await saveBotState({ ...metrics.state, lastError: null });
      if (!state.dailyLossLockout && metrics.state.dailyLossLockout) {
        await appendLog("warning", "Bot daily loss limit hit. BUYs disabled until next session/day.");
      }
      await appendEquityPoint({
        ts: Date.now(),
        equityUsd: metrics.metrics.equityUsd,
        cashUsd: metrics.metrics.cashUsd,
        exposureUsd: metrics.metrics.totalExposureUsd,
      });
    } catch (err) {
      const settings = await loadSettings().catch(() => null);
      if (settings) {
        const state = await loadBotState(settings);
        await saveBotState({ ...state, lastError: err instanceof Error ? err.message : "Unknown bot error" });
      }
      await appendLog("error", `Bot loop error: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      this.inFlight = false;
      const settings = await loadSettings().catch(() => null);
      const state = settings ? await loadBotState(settings).catch(() => null) : null;
      if (settings && (state?.runState === "running" || state?.runState === "draining")) {
        this.schedule(settings.pollingIntervalSec * 1000);
      }
    }
  }

  /**
   * One exit-only poll: refresh marks, sell any position that breaches an
   * auto-exit rule, and stop the bot once the book is empty.
   */
  private async drainTick(settings: BotSettings, state: BotState): Promise<void> {
    const now = Date.now();
    let positions = await loadPositions();
    if (positions.length === 0) {
      await saveBotState({ ...state, runState: "stopped", stoppedAt: now, nextPollAt: null });
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

    if (allClosed) await appendLog("info", "Auto-exit complete: all positions closed. Bot stopped.");
  }

  /**
   * Real-money execution path (mode === "real"). Places live FAK market orders
   * through the Polymarket CLOB. Every BUY is clamped to config.liveMaxOrderUsd
   * as a hard backstop on top of the percentage-sizing and exposure caps already
   * enforced upstream. Any failure is recorded as a "failed" trade instead of
   * throwing, so the poll loop keeps running.
   */
  private async executeRealTrade(
    trade: TraderTrade,
    settings: BotSettings,
    requestedAmountUsd: number,
    market: Market | null,
    positions: BotPosition[],
    now: number,
    buyEdge: Partial<CopyTradeRecord> = {},
  ): Promise<{ record: CopyTradeRecord; positions: BotPosition[] }> {
    const fail = (reason: string): { record: CopyTradeRecord; positions: BotPosition[] } => ({
      record: makeRecord(trade, "failed", "real", requestedAmountUsd, 0, 0, reason, market, now, buyEdge),
      positions,
    });

    try {
      assertLiveTradingAllowed();
    } catch (err) {
      return fail(`Real trade blocked: ${err instanceof Error ? err.message : "live trading is not allowed"}`);
    }

    if (trade.side === "BUY") {
      const usd = Math.max(CLOB_MIN_MARKET_BUY_USD, Math.min(requestedAmountUsd, config.liveMaxOrderUsd));
      if (!(usd > 0)) return fail("Real BUY skipped: order size resolved to zero.");
      const refPrice = clampPrice(market?.bestAsk ?? market?.midpoint ?? trade.price);
      try {
        const res = await placeLiveMarketOrder({
          tokenId: trade.tokenId,
          side: "BUY",
          usdAmount: usd,
          referencePrice: refPrice,
        });
        clearLiveBalanceCache();
        if (!res.success) return fail(`Live BUY rejected: ${res.error ?? "unknown error"}.`);
        const nextPositions = applyBuy(positions, trade, market, res.filledShares, res.effectivePrice, refPrice, now);
        const record = makeRecord(
          trade,
          "copied",
          "real",
          res.notionalUsd,
          res.filledShares,
          0,
          `LIVE BUY $${res.notionalUsd.toFixed(2)} (~${res.filledShares.toFixed(2)} sh @ ${(res.effectivePrice * 100).toFixed(1)}c) following ${trade.traderName} ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â order ${res.orderId ?? "?"} [${res.status ?? "posted"}].`,
          market,
          now,
          buyEdge,
        );
        record.txOrOrderId = res.orderId ?? "";
        record.reconciliationStatus = "pending";
        return { record, positions: nextPositions };
      } catch (err) {
        clearLiveBalanceCache();
        return fail(`Live BUY failed: ${messageFromUnknown(err)}.`);
      }
    }

    // SELL ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â only if we actually hold the token.
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
    const requestedSellShares =
      settings.sellBehavior === "all" ? existing.shares : Math.min(existing.shares, requestedAmountUsd / refPrice);
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
    try {
      const res = await placeLiveMarketOrder({
        tokenId: trade.tokenId,
        side: "SELL",
        shares: sellSize.shares,
        referencePrice: refPrice,
      });
      clearLiveBalanceCache();
      if (!res.success) return fail(`Live SELL rejected: ${res.error ?? "unknown error"}.`);
      const sold = applySell(sellPositions, trade, res.filledShares, res.effectivePrice, 0, refPrice, now);
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
          side: "SELL",
          shares: sellSize.shares,
          referencePrice: price,
        });
        clearLiveBalanceCache();
        if (!res.success) {
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
   * token, and ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â when exitWhenLeaderNoLongerHolds is on ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â exit positions the
   * leader has clearly left. Bounded: only fetches positions for the source
   * wallets of currently-open bot positions. Returns the surviving positions.
   */
  private async reconcileAndExitLeaders(settings: BotSettings, positions: BotPosition[]): Promise<BotPosition[]> {
    const botOpened = positions.filter((p) => p.sourceWallets.length > 0 && p.shares > 0);
    if (botOpened.length === 0) return positions;

    const wallets = sourceWalletsOf(botOpened).slice(0, MAX_LEADER_HOLDINGS_WALLETS);
    if (wallets.length === 0) return positions;

    // Read-only fetch of each leader's current positions. A failed fetch becomes
    // "no data" (ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ unknown), never a false "exited" that could trigger a sale.
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
          side: "SELL",
          shares: sellSize.shares,
          referencePrice: price,
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
    try {
      market = await fetchMarketById(trade.tokenId);
    } catch {
      market = null;
    }
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

    // Edge metrics for copied BUYs ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â recorded on every BUY record (filled or
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

    // Per-copied-wallet controls (entries only ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â never block exits). These keep a
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
    const baseStrategyAmountUsd = calculateNextTradeSize(settings, availableBalanceUsd);
    const strategyAmountUsd =
      trade.side === "BUY" ? applyConvictionSizing(baseStrategyAmountUsd, trade, trader, settings) : baseStrategyAmountUsd;
    const perMarketCapUsd = dollarCapFromPercent(equityUsd, settings.maxExposurePerMarketPercent);
    const totalCapUsd = dollarCapFromPercent(equityUsd, settings.maxTotalExposurePercent);
    const dailyLossCapUsd = dollarCapFromPercent(state.dailyStartEquityUsd, settings.maxDailyLossPercent);
    const dailyStartBotPnlUsd = Number.isFinite(state.dailyStartBotPnlUsd) ? state.dailyStartBotPnlUsd : 0;
    const dailyPnlUsd = cumulativeBotPnlUsd(positions, priorTrades) - dailyStartBotPnlUsd;
    const remainingPerMarketUsd = Math.max(0, perMarketCapUsd - marketExposureUsd);
    const remainingTotalExposureUsd = Math.max(0, totalCapUsd - exposureUsd);
    const remainingAllowedExposureUsd = Math.min(remainingPerMarketUsd, remainingTotalExposureUsd);
    // Apply the same order-size constraints in both modes so sim sizing matches live.
    const requestedAmountUsd =
      trade.side === "BUY"
        ? Math.min(strategyAmountUsd, availableBalanceUsd, config.liveMaxOrderUsd, remainingAllowedExposureUsd)
        : strategyAmountUsd;
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
    if (settings.mode === "real" && trade.side === "BUY" && liveBalance && liveBalance.usdcBalance <= settings.minAvailableBalanceUsd) {
      return skip(
        "Skipped LIVE BUY: live USDC balance $" +
          liveBalance.usdcBalance.toFixed(2) +
          " is at or below the minimum available balance $" +
          settings.minAvailableBalanceUsd.toFixed(2) +
          ".",
      );
    }
    if (settings.mode === "real" && trade.side === "BUY" && remainingPerMarketUsd <= 0) {
      return skip("Skipped LIVE BUY: per-market exposure cap " + settings.maxExposurePerMarketPercent + "% is already reached.");
    }
    if (settings.mode === "real" && trade.side === "BUY" && remainingTotalExposureUsd <= 0) {
      return skip("Skipped LIVE BUY: total exposure cap " + settings.maxTotalExposurePercent + "% is already reached.");
    }
    if (trade.side === "BUY" && isBelowTradeMinimum(settings, requestedAmountUsd)) {
      return skip(
        "Skipped BUY: order $" + requestedAmountUsd.toFixed(2) +
        " is below the configured minimum $" + settings.minTradeAmountUsd.toFixed(2) + ".",
      );
    }
    if (trade.side === "BUY" && availableBalanceUsd - requestedAmountUsd < settings.minAvailableBalanceUsd) {
      return skip(
        settings.mode === "real"
          ? "Skipped LIVE BUY: live USDC balance would fall below the configured minimum available balance $" +
              settings.minAvailableBalanceUsd.toFixed(2) +
              "."
          : "Skipped BUY: minimum available balance would be breached.",
      );
    }
    if (trade.side === "BUY" && settings.minMarketLiquidityUsd > 0 && marketLiquidity(market) < settings.minMarketLiquidityUsd) {
      return skip("Skipped BUY: market liquidity is below the configured minimum or could not be verified.");
    }
    if (trade.side === "BUY" && marketExposureUsd + requestedAmountUsd > perMarketCapUsd) {
      return skip("Skipped BUY: per-market exposure cap " + settings.maxExposurePerMarketPercent + "% would be exceeded.");
    }
    if (trade.side === "BUY" && exposureUsd + requestedAmountUsd > totalCapUsd) {
      return skip("Skipped BUY: total exposure cap " + settings.maxTotalExposurePercent + "% would be exceeded.");
    }
    if (trade.side === "BUY" && settings.maxExposurePerWalletPercent > 0) {
      const walletCapUsd = dollarCapFromPercent(equityUsd, settings.maxExposurePerWalletPercent);
      const walletExposureUsd = walletExposure(positions, trade.wallet);
      if (walletExposureUsd + requestedAmountUsd > walletCapUsd) {
        return skip("Skipped BUY: per-wallet exposure cap " + settings.maxExposurePerWalletPercent + "% would be exceeded for this wallet.");
      }
    }


    if (settings.mode === "real") {
      return this.executeRealTrade(trade, settings, requestedAmountUsd, market, positions, now, buyEdge);
    }

    const refPrice = clampPrice(trade.price);
    const costSettings: FillCostSettings = {
      takerFeeBps: settings.takerFeeBps,
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
        const shares = requestedAmountUsd / refPrice;
        return {
          positions: applyBuy(positions, trade, market, shares, refPrice, refPrice, now),
          record: makeRecord(
            trade,
            "simulated",
            settings.mode,
            requestedAmountUsd,
            shares,
            0,
            `Simulated BUY ${requestedAmountUsd.toFixed(2)} USD following ${trade.traderName} (idealized fill).`,
            market,
            now,
            buyEdge,
          ),
        };
      }

      const fill = simulateFill({
        side: "BUY",
        book: await fetchBookSafe(),
        referencePrice: refPrice,
        marketBestBid: market?.bestBid ?? null,
        marketBestAsk: market?.bestAsk ?? null,
        marketMid: market?.midpoint ?? null,
        desiredUsd: requestedAmountUsd,
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
    const sharesToSell =
      settings.sellBehavior === "all" ? existing.shares : Math.min(existing.shares, requestedAmountUsd / refPrice);
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
      book: await fetchBookSafe(),
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












