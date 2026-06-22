import { config } from "@/lib/config";
import { fetchBook } from "@/lib/polymarket/clob";
import { fetchMarketById } from "@/lib/polymarket/gamma";
import { fetchTradesForWallets, fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { Market, OrderBook, TraderTrade } from "@/lib/polymarket/types";
import { simulateFill, type FillCostSettings, type FillResult } from "./fillModel";
import {
  buildMetrics,
  calculateAvailableBalance,
  calculateNextTradeSize,
  clampPrice,
  dollarCapFromPercent,
  isBelowTradeMinimum,
  positionExposure,
  totalExposure,
  walletExposure,
} from "./accounting";
import { inspectBullpenCli } from "./bullpen";
import { isRiskPresetId } from "./riskPresets";
import { assertLiveTradingAllowed, placeLiveMarketOrder, type LiveUsdcBalance } from "@/lib/execution/liveClob";
import { clearLiveBalanceCache, getLiveUsdcBalance } from "@/lib/execution/liveBalance";
import { createInitialBotState } from "./defaults";
import { buildScoreboard, normalizeSkipReason } from "./scoreboard";
import { discoverTraders } from "./discovery";
import {
  appendLog,
  clearLogs,
  ensureDataFiles,
  loadBotState,
  loadLogs,
  loadPositions,
  loadSeenTrades,
  loadSettings,
  loadTraders,
  loadTrades,
  prependTrade,
  saveBotState,
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
  LogLevel,
  SeenTradeBook,
} from "./types";

const MAX_TRADERS_TO_FOLLOW = 100;
const MAX_WALLETS_PER_POLL = 100;

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

function recordId(now = Date.now()): string {
  return `copy_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
    .filter((trader) => trader.enabled)
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

  const next: BotSettings = {
    ...current,
    ...patch,
    mode: patch.mode === "real" ? "real" : patch.mode === "simulation" ? "simulation" : current.mode,
    sizingMode:
      patch.sizingMode === "fixed" || patch.sizingMode === "percentage" || patch.sizingMode === "hybrid"
        ? patch.sizingMode
        : current.sizingMode,
    riskPreset: isRiskPresetId(patch.riskPreset) ? patch.riskPreset : current.riskPreset,
    sellBehavior: patch.sellBehavior === "all" ? "all" : patch.sellBehavior === "proportional" ? "proportional" : current.sellBehavior,
  };

  return {
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
  };
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

function messageFromUnknown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function reconcileLiveBalanceMetrics(settings: BotSettings, metrics: BotMetrics, liveBalance: LiveUsdcBalance): BotMetrics {
  const localTrackedEquity = metrics.equityUsd;
  const balanceDifference = liveBalance.usdcBalance - localTrackedEquity;
  const liveStrategySize = calculateNextTradeSize(settings, liveBalance.usdcBalance);
  const liveNextTradeSizeUsd = Math.min(liveStrategySize, config.liveMaxOrderUsd, liveBalance.usdcBalance);

  return {
    ...metrics,
    availableBalanceUsd: liveBalance.usdcBalance,
    nextTradeSizeUsd: liveNextTradeSizeUsd,
    liveUsdcBalance: liveBalance.usdcBalance,
    localTrackedEquity,
    balanceDifference,
    lastLiveBalanceCheck: liveBalance.updatedAt,
    liveBalanceStatus: Math.abs(balanceDifference) > config.liveBalanceWarningThresholdUsd ? "warning" : "ok",
    liveBalanceError: null,
  };
}

async function buildStatusMetrics(settings: BotSettings, metrics: BotMetrics): Promise<BotMetrics> {
  if (settings.mode !== "real") return metrics;

  if (!config.enableRealTrading || !config.livePrivateKey.trim()) {
    return {
      ...metrics,
      localTrackedEquity: metrics.equityUsd,
      liveBalanceStatus: "error",
      liveBalanceError: "Live balance unavailable: real trading is not fully configured.",
    };
  }

  try {
    return reconcileLiveBalanceMetrics(settings, metrics, await getLiveUsdcBalance());
  } catch (err) {
    return {
      ...metrics,
      localTrackedEquity: metrics.equityUsd,
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
  extra?: Partial<CostExtra>,
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
 * trader's trade — i.e. a session-close liquidation or an auto-exit rule firing.
 */
function makeExitRecord(
  position: BotPosition,
  price: number,
  shares: number,
  copyAmountUsd: number,
  realizedPnlUsd: number,
  reason: string,
  source: "session-close" | "auto-exit",
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

  async status(): Promise<BotStatus> {
    await ensureDataFiles();
    const settings = await loadSettings();
    const [state, traders, positions, trades, equityCurve, logs, bullpen] = await Promise.all([
      loadBotState(settings),
      loadTraders(),
      loadPositions(),
      loadTrades(),
      loadEquityCurve(settings),
      loadLogs(),
      inspectBullpenCli(),
    ]);
    const built = buildMetrics(settings, state, positions, trades);
    const statusMetrics = await buildStatusMetrics(settings, built.metrics);
    let statusState = built.state;
    if (statusState.peakEquityUsd !== state.peakEquityUsd || statusState.dailyDate !== state.dailyDate) {
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

    return {
      state: statusState,
      settings,
      metrics: statusMetrics,
      scoreboard,
      realTradingEnabled: config.enableRealTrading,
      simulationOnly: !config.enableRealTrading || settings.mode === "simulation",
      bullpen,
      traders,
      positions,
      recentTrades: trades.slice(0, 100),
      equityCurve,
      logs,
    };
  }

  async start(): Promise<BotStatus> {
    const settings = await loadSettings();
    if (settings.mode === "real") {
      try {
        assertLiveTradingAllowed();
        await getLiveUsdcBalance({ forceRefresh: true });
      } catch (err) {
        const reason = "Real trading start blocked: " + messageFromUnknown(err);
        await appendLog("error", reason);
        throw new Error(reason);
      }
    }

    let state = await loadBotState(settings);
    const now = Date.now();
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

  async pause(): Promise<BotStatus> {
    this.clearTimer();
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    await saveBotState({ ...state, runState: "paused", pausedAt: Date.now(), nextPollAt: null });
    await appendLog("info", "Bot paused.");
    return this.status();
  }

  async stop(opts: { liquidate?: boolean; source?: "session-close" | "auto-exit" } = {}): Promise<BotStatus> {
    this.clearTimer();
    const settings = await loadSettings();
    if (opts.liquidate) {
      await this.flatten(opts.source ?? "session-close");
    }
    const state = await loadBotState(settings);
    await saveBotState({ ...state, runState: "stopped", stoppedAt: Date.now(), pausedAt: null, nextPollAt: null });
    await appendLog("info", opts.liquidate ? "Bot stopped and open positions liquidated." : "Bot stopped.");
    return this.status();
  }

  /**
   * Pull live Polymarket marks for every open position on demand and recompute
   * equity. Works in any run state, so the user can see current P&L even while
   * the bot is stopped or paused.
   */
  async refreshMarks(): Promise<BotStatus> {
    let positions = await loadPositions();
    if (positions.length > 0) {
      positions = await this.refreshMarkPrices(positions);
      await savePositions(positions);
      const settings = await loadSettings();
      const state = await loadBotState(settings);
      const trades = await loadTrades();
      const metrics = buildMetrics(settings, state, positions, trades);
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
    await savePositions([]);
    await saveTrades([]);
    await saveSeenTrades({ ids: [] });
    await saveEquityCurve([
      { ts: now, equityUsd: settings.startingBalance, cashUsd: settings.startingBalance, exposureUsd: 0 },
    ]);
    await saveBotState(createInitialBotState(settings.startingBalance, now));
    await clearLogs();
    await appendLog(
      "info",
      `Simulation reset: bankroll back to ${settings.startingBalance.toFixed(2)} USD; positions, trades, and equity curve cleared.`,
    );
    return this.status();
  }

  /**
   * Sell every open position at its current (refreshed) mark price, recording a
   * simulated SELL per position and clearing the book. Used by session-only
   * liquidation and the "Sell all now" stop option. Does not change runState.
   */
  async flatten(source: "session-close" | "auto-exit" = "session-close"): Promise<{ closed: number; proceedsUsd: number; realizedPnlUsd: number }> {
    let positions = await loadPositions();
    if (positions.length === 0) return { closed: 0, proceedsUsd: 0, realizedPnlUsd: 0 };

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
      await prependTrade(
        makeExitRecord(
          position,
          price,
          shares,
          copyAmountUsd,
          pnl,
          `Liquidated ${shares.toFixed(2)} ${position.outcome} @ ${(price * 100).toFixed(1)}c (${source}).`,
          source,
          now,
        ),
      );
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
    return { closed, proceedsUsd, realizedPnlUsd };
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

  async updateSettings(patch: Partial<BotSettings>): Promise<BotStatus> {
    const current = await loadSettings();
    const next = sanitizeSettings(current, patch);
    await saveSettings(next);
    await appendLog("info", "Settings updated.");

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
    await appendLog("info", `Trader discovery refreshed ${discovered.length} tracked wallets.`);
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
        const result = await this.processTrade(trade, settings, state, positions, walletCycleCopies);
        positions = result.positions;
        await prependTrade(result.record);
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
          bucket.count > 1 ? `${bucket.reason} (×${bucket.count} this cycle)` : bucket.reason,
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

      // Fully-automatic live exits: in real mode, sell any position that has hit
      // the configured take-profit / stop-loss / max-hold on this poll.
      if (settings.mode === "real" && positions.length > 0) {
        positions = await this.liveAutoExit(settings, positions);
      }

      await savePositions(positions);
      await saveSeenTrades({ ids: [...seenIds] });

      const trades = await loadTrades();
      const metrics = buildMetrics(settings, state, positions, trades);
      await saveBotState({ ...metrics.state, lastError: null });
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

    positions = await this.refreshMarkPrices(positions);
    const tp = settings.autoExitTakeProfitPercent;
    const sl = settings.autoExitStopLossPercent;
    const maxHoldMs = settings.autoExitMaxHoldMinutes * 60 * 1000;

    const remaining: BotPosition[] = [];
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
      await prependTrade(
        makeExitRecord(position, price, shares, copyAmountUsd, pnl, `Auto-exit: ${exitReason}.`, "auto-exit", now),
      );
      exits += 1;
    }

    await savePositions(remaining);

    const allClosed = remaining.length === 0;
    const trades = await loadTrades();
    const metrics = buildMetrics(settings, state, remaining, trades);
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

    if (exits > 0) await appendLog("info", `Auto-exit sold ${exits} position(s); ${remaining.length} remaining.`);
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
  ): Promise<{ record: CopyTradeRecord; positions: BotPosition[] }> {
    const fail = (reason: string): { record: CopyTradeRecord; positions: BotPosition[] } => ({
      record: makeRecord(trade, "failed", "real", requestedAmountUsd, 0, 0, reason, market, now),
      positions,
    });

    try {
      assertLiveTradingAllowed();
    } catch (err) {
      return fail(`Real trade blocked: ${err instanceof Error ? err.message : "live trading is not allowed"}`);
    }

    if (trade.side === "BUY") {
      const usd = Math.min(requestedAmountUsd, config.liveMaxOrderUsd);
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
          `LIVE BUY $${res.notionalUsd.toFixed(2)} (~${res.filledShares.toFixed(2)} sh @ ${(res.effectivePrice * 100).toFixed(1)}c) following ${trade.traderName} — order ${res.orderId ?? "?"} [${res.status ?? "posted"}].`,
          market,
          now,
        );
        record.txOrOrderId = res.orderId ?? "";
        return { record, positions: nextPositions };
      } catch (err) {
        clearLiveBalanceCache();
        return fail(`Live BUY failed: ${messageFromUnknown(err)}.`);
      }
    }

    // SELL — only if we actually hold the token.
    const existing = positions.find((position) => position.tokenId === trade.tokenId);
    if (!existing || existing.shares <= 0) {
      return {
        record: makeRecord(trade, "skipped", "real", 0, 0, 0, "Observed trader SELL, but no local copied position exists.", market, now),
        positions,
      };
    }
    const refPrice = clampPrice(market?.bestBid ?? market?.midpoint ?? trade.price);
    const sharesToSell =
      settings.sellBehavior === "all" ? existing.shares : Math.min(existing.shares, requestedAmountUsd / refPrice);
    if (!(sharesToSell > 0)) return fail("Skipped LIVE SELL: calculated sell size was zero.");
    try {
      const res = await placeLiveMarketOrder({
        tokenId: trade.tokenId,
        side: "SELL",
        shares: sharesToSell,
        referencePrice: refPrice,
      });
      clearLiveBalanceCache();
      if (!res.success) return fail(`Live SELL rejected: ${res.error ?? "unknown error"}.`);
      const sold = applySell(positions, trade, res.filledShares, res.effectivePrice, 0, refPrice, now);
      const record = makeRecord(
        trade,
        "copied",
        "real",
        sold.copyAmountUsd,
        sold.copiedShares,
        sold.realizedPnlUsd,
        `LIVE SELL $${sold.copyAmountUsd.toFixed(2)} (${sold.copiedShares.toFixed(2)} sh @ ${(res.effectivePrice * 100).toFixed(1)}c) following ${trade.traderName} — order ${res.orderId ?? "?"} [${res.status ?? "posted"}].`,
        market,
        now,
      );
      record.txOrOrderId = res.orderId ?? "";
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
    const remaining: BotPosition[] = [];
    for (const position of positions) {
      if (position.shares <= 0) continue;
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

      try {
        const res = await placeLiveMarketOrder({
          tokenId: position.tokenId,
          side: "SELL",
          shares: position.shares,
          referencePrice: price,
        });
        clearLiveBalanceCache();
        if (!res.success) {
          await appendLog("error", `Live auto-exit SELL rejected for ${position.outcome}: ${res.error ?? "unknown"}. Keeping position.`);
          remaining.push(position);
          continue;
        }
        const realized = (res.effectivePrice - position.avgPrice) * res.filledShares;
        const record = makeExitRecord(
          position,
          res.effectivePrice,
          res.filledShares,
          res.notionalUsd,
          realized,
          `LIVE auto-exit: ${exitReason} — order ${res.orderId ?? "?"}.`,
          "auto-exit",
          now,
        );
        record.mode = "real";
        record.status = "copied";
        record.txOrOrderId = res.orderId ?? "";
        await prependTrade(record);
        await appendLog("info", `Live auto-exit sold ${position.outcome}: ${exitReason}.`);
      } catch (err) {
        clearLiveBalanceCache();
        await appendLog("error", `Live auto-exit SELL failed for ${position.outcome}: ${messageFromUnknown(err)}. Keeping position.`);
        remaining.push(position);
      }
    }
    return remaining;
  }

  private async processTrade(
    trade: TraderTrade,
    settings: BotSettings,
    state: BotState,
    positions: BotPosition[],
    walletCycleCopies: Map<string, number>,
  ): Promise<{ record: CopyTradeRecord; positions: BotPosition[] }> {
    const now = Date.now();
    const tradeAgeSec = Math.max(0, Math.floor(now / 1000) - trade.timestamp);
    let market: Market | null = null;
    try {
      market = await fetchMarketById(trade.tokenId);
    } catch {
      market = null;
    }

    const priorTrades = await loadTrades();
    const localAvailableBalanceUsd = calculateAvailableBalance(settings, positions, priorTrades);
    const exposureUsd = totalExposure(positions);
    const marketExposureUsd = positions
      .filter((position) => position.conditionId === trade.conditionId || position.tokenId === trade.tokenId)
      .reduce((sum, position) => sum + positionExposure(position), 0);

    const skip = (reason: string) => ({
      record: makeRecord(trade, "skipped", settings.mode, 0, 0, 0, reason, market, now),
      positions,
    });
    const fail = (reason: string) => ({
      record: makeRecord(trade, "failed", settings.mode, 0, 0, 0, reason, market, now),
      positions,
    });

    if (tradeAgeSec > settings.maxTradeAgeSec) {
      return skip("Skipped stale trade from " + trade.traderName + ": " + tradeAgeSec + "s old.");
    }
    if (trade.price <= 0 || trade.price >= 1 || trade.size <= 0) {
      return skip("Skipped malformed trade from " + trade.traderName + ".");
    }

    const filterReason = buyMarketFilterReason(settings, trade, market);
    if (filterReason) return skip(filterReason);

    // Per-copied-wallet controls (entries only — never block exits). These keep a
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
    if (settings.mode === "real") {
      try {
        liveBalance = await getLiveUsdcBalance({ forceRefresh: true });
        availableBalanceUsd = liveBalance.usdcBalance;
        equityUsd = liveBalance.usdcBalance + exposureUsd;
      } catch (err) {
        return fail("Real trade blocked: could not fetch live USDC balance: " + messageFromUnknown(err) + ".");
      }
    }

    const strategyAmountUsd = calculateNextTradeSize(settings, availableBalanceUsd);
    const perMarketCapUsd = dollarCapFromPercent(equityUsd, settings.maxExposurePerMarketPercent);
    const totalCapUsd = dollarCapFromPercent(equityUsd, settings.maxTotalExposurePercent);
    const dailyLossCapUsd = dollarCapFromPercent(state.dailyStartEquityUsd, settings.maxDailyLossPercent);
    const dailyPnlUsd = equityUsd - state.dailyStartEquityUsd;
    const remainingPerMarketUsd = Math.max(0, perMarketCapUsd - marketExposureUsd);
    const remainingTotalExposureUsd = Math.max(0, totalCapUsd - exposureUsd);
    const remainingAllowedExposureUsd = Math.min(remainingPerMarketUsd, remainingTotalExposureUsd);
    const requestedAmountUsd =
      settings.mode === "real" && trade.side === "BUY"
        ? Math.min(strategyAmountUsd, availableBalanceUsd, config.liveMaxOrderUsd, remainingAllowedExposureUsd)
        : strategyAmountUsd;

    if (dailyPnlUsd <= -dailyLossCapUsd) {
      return skip("Skipped trade: daily loss cap reached (" + settings.maxDailyLossPercent + "% of bankroll).");
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
      const reason =
        settings.mode === "real" && liveBalance
          ? "Skipped LIVE BUY: live-sized order $" +
            requestedAmountUsd.toFixed(2) +
            " is below min trade amount $" +
            settings.minTradeAmountUsd.toFixed(2) +
            " (live USDC $" +
            liveBalance.usdcBalance.toFixed(2) +
            ", LIVE_MAX_ORDER_USD $" +
            config.liveMaxOrderUsd.toFixed(2) +
            ")."
          : "Skipped BUY: calculated " +
            requestedAmountUsd.toFixed(2) +
            " is below min trade amount " +
            settings.minTradeAmountUsd.toFixed(2) +
            ".";
      return skip(reason);
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
      return this.executeRealTrade(trade, settings, requestedAmountUsd, market, positions, now);
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
          fillToExtra(fill),
        ),
      };
    }

    // SELL
    const existing = positions.find((position) => position.tokenId === trade.tokenId);
    if (!existing || existing.shares <= 0) return skip("Observed trader SELL, but no local copied position exists.");
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












