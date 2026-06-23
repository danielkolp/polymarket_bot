import { todayKey } from "./defaults";
import { isFilled, tradeIsUnsafeForAccounting, tradeNotionalUsd } from "./ledger";
import type { BotMetrics, BotPosition, BotSettings, BotState, CopyTradeRecord } from "./types";

export function clampPrice(price: number): number {
  if (!Number.isFinite(price)) return 0;
  return Math.min(0.99, Math.max(0.01, price));
}

export function positionCostBasis(position: BotPosition): number {
  return Math.max(0, position.shares * position.avgPrice);
}

export function totalOpenCostBasis(positions: BotPosition[]): number {
  return positions.reduce((sum, pos) => sum + positionCostBasis(pos), 0);
}

export function positionExposure(position: BotPosition): number {
  return Math.max(0, position.shares * position.markPrice);
}

export function totalExposure(positions: BotPosition[]): number {
  return positions.reduce((sum, pos) => sum + positionExposure(pos), 0);
}

export function positionUnrealizedPnl(position: BotPosition): number {
  return positionExposure(position) - positionCostBasis(position);
}

/**
 * Open exposure (USD) across every position that `wallet` contributed to. A
 * position shared by multiple source wallets counts toward each of them, so this
 * is a per-wallet ceiling on "markets this wallet drove us into" rather than a
 * strict partition of total exposure.
 */
export function walletExposure(positions: BotPosition[], wallet: string): number {
  return positions
    .filter((position) => position.sourceWallets.includes(wallet))
    .reduce((sum, position) => sum + positionExposure(position), 0);
}

function filledForSettledPnl(trade: CopyTradeRecord): boolean {
  return isFilled(trade) && !tradeIsUnsafeForAccounting(trade);
}

export function realizedPnlFromTrades(trades: CopyTradeRecord[]): number {
  return trades
    .filter(filledForSettledPnl)
    .reduce((sum, trade) => sum + trade.realizedPnlUsd, 0);
}

/**
 * Dashboard/accounting cash derived from the same invariant as equity:
 * cash = starting balance + settled realized P&L - open cost basis.
 *
 * This deliberately does not replay the retained trade list for open BUY cost.
 * The current open-position ledger is the source of truth for remaining cost
 * basis, which keeps cash/equity stable even when old trade rows are compacted.
 */
export function calculateAccountCash(settings: BotSettings, positions: BotPosition[], trades: CopyTradeRecord[]): number {
  return settings.startingBalance + realizedPnlFromTrades(trades) - totalOpenCostBasis(positions);
}

export function calculateEquity(settings: BotSettings, positions: BotPosition[], trades: CopyTradeRecord[]): number {
  return calculateAccountCash(settings, positions, trades) + totalExposure(positions);
}

/**
 * Retained-trade cash replay. Kept for reconciliation diagnostics only. It can
 * diverge from dashboard cash if the retained trade list no longer contains every
 * open BUY, so buildMetrics does not use it as the equity source of truth.
 */
export function calculateCash(
  settings: BotSettings,
  trades: CopyTradeRecord[],
  opts: { mirrorOnly?: boolean } = {},
): number {
  return trades.reduce((cash, trade) => {
    if (!isFilled(trade)) return cash;
    const notional = opts.mirrorOnly ? trade.copyAmountUsd : tradeNotionalUsd(trade);
    if (trade.side === "BUY") return cash - notional;
    return cash + notional;
  }, settings.startingBalance);
}

export function calculateAvailableBalance(settings: BotSettings, positions: BotPosition[], trades: CopyTradeRecord[]): number {
  return Math.max(0, calculateAccountCash(settings, positions, trades));
}

export function dollarCapFromPercent(bankrollUsd: number, percent: number): number {
  if (!Number.isFinite(bankrollUsd) || !Number.isFinite(percent)) return 0;
  return Math.max(0, bankrollUsd * (percent / 100));
}

export function calculateNextTradeSize(settings: BotSettings, availableBalanceUsd: number): number {
  let raw: number;
  if (settings.sizingMode === "fixed") {
    raw = settings.fixedCopyAmountUsd;
  } else {
    raw = availableBalanceUsd * (settings.percentageCopySize / 100);
  }

  if (settings.sizingMode === "hybrid") {
    raw = Math.max(settings.minTradeAmountUsd, Math.min(settings.maxTradeAmountUsd, raw));
  }

  if (settings.sizingMode === "fixed") {
    raw = Math.min(settings.maxTradeAmountUsd, raw);
  }

  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return Math.min(raw, availableBalanceUsd);
}

export function isBelowTradeMinimum(settings: BotSettings, amountUsd: number): boolean {
  return amountUsd + 1e-9 < settings.minTradeAmountUsd;
}

export function buildMetrics(
  settings: BotSettings,
  state: BotState,
  positions: BotPosition[],
  trades: CopyTradeRecord[],
  now = Date.now(),
): { metrics: BotMetrics; state: BotState } {
  const realizedPnlUsd = realizedPnlFromTrades(trades);
  const totalOpenCostBasisUsd = totalOpenCostBasis(positions);
  const totalExposureUsd = totalExposure(positions);
  const unrealizedPnlUsd = totalExposureUsd - totalOpenCostBasisUsd;
  const equityUsd = settings.startingBalance + realizedPnlUsd + unrealizedPnlUsd;
  const cashUsd = equityUsd - totalExposureUsd;
  const availableBalanceUsd = Math.max(0, cashUsd);

  const retainedTradeCashUsd = calculateCash(settings, trades);
  const cashUsdLocalMirror = calculateCash(settings, trades, { mirrorOnly: true });
  const roi = settings.startingBalance > 0 ? (realizedPnlUsd + unrealizedPnlUsd) / settings.startingBalance : 0;
  const settledFilled = trades.filter(filledForSettledPnl);
  const winners = settledFilled.filter((t) => t.realizedPnlUsd > 0).length;
  const losers = settledFilled.filter((t) => t.realizedPnlUsd < 0).length;
  const closed = winners + losers;
  const filled = trades.filter((t) => t.status === "simulated" || t.status === "copied");
  const totalFrictionUsd = filled.reduce((sum, t) => sum + (t.frictionUsd ?? 0), 0);
  const totalFeesUsd = filled.reduce((sum, t) => sum + (t.feeUsd ?? 0), 0);
  const dailyDate = todayKey(now);
  const sameDay = state.dailyDate === dailyDate;
  const dailyStartEquityUsd = sameDay ? state.dailyStartEquityUsd : equityUsd;
  const peakEquityUsd = Math.max(state.peakEquityUsd || settings.startingBalance, equityUsd);
  const maxDrawdown = peakEquityUsd > 0 ? Math.max(0, (peakEquityUsd - equityUsd) / peakEquityUsd) : 0;
  const totalExposurePercent = equityUsd > 0 ? totalExposureUsd / equityUsd : 0;
  const exposureCap = settings.maxTotalExposurePercent / 100;
  const buyExposurePaused = settings.mode === "simulation" && exposureCap > 0 && totalExposurePercent >= exposureCap - 1e-9;

  const dailyPnlUsd = equityUsd - dailyStartEquityUsd;
  // Hard daily-loss lockout. Latches once breached and stays latched for the rest
  // of the local day (cleared only at the day boundary or on reset), so a brief
  // equity bounce can't silently re-enable BUYs after a bad day.
  const dailyLossCapUsd = dollarCapFromPercent(dailyStartEquityUsd, settings.maxDailyLossPercent);
  const lossBreachedNow = settings.maxDailyLossPercent > 0 && dailyLossCapUsd > 0 && dailyPnlUsd <= -dailyLossCapUsd;
  const dailyLossLockout = sameDay ? Boolean(state.dailyLossLockout) || lossBreachedNow : false;
  const dailyLossLockoutReason = dailyLossLockout
    ? `Daily loss ${dailyPnlUsd.toFixed(2)} USD reached the ${settings.maxDailyLossPercent}% cap (-${dailyLossCapUsd.toFixed(2)} USD). New BUYs disabled until the next day.`
    : null;

  // Live orders awaiting authoritative CLOB reconciliation.
  const unsafeRealOrders = trades.filter(tradeIsUnsafeForAccounting);
  const unreconciledLiveOrders = unsafeRealOrders.length;
  const unreconciledNotionalUsd = unsafeRealOrders.reduce((sum, t) => sum + Math.abs(t.copyAmountUsd), 0);
  const pendingReservedUsd = unsafeRealOrders
    .filter((t) => t.side === "BUY")
    .reduce((sum, t) => sum + Math.abs(t.copyAmountUsd), 0);
  const cashUsdAuthoritative = cashUsd;
  const hasBlocking = unsafeRealOrders.some(
    (t) => t.reconciliationStatus === "unmatched" || t.reconciliationStatus === "error",
  );
  const accountingConfidence: BotMetrics["accountingConfidence"] = hasBlocking
    ? "blocked"
    : unreconciledLiveOrders > 0
      ? "degraded"
      : "high";

  const nextState: BotState = {
    ...state,
    dailyDate,
    dailyStartEquityUsd,
    peakEquityUsd,
    dailyLossLockout,
  };

  return {
    state: nextState,
    metrics: {
      cashUsd,
      availableBalanceUsd,
      equityUsd,
      liveUsdcBalance: null,
      localTrackedEquity: equityUsd,
      balanceDifference: null,
      lastLiveBalanceCheck: null,
      liveBalanceStatus: "unknown",
      liveBalanceError: null,
      buyExposurePaused,
      buyExposurePauseReason: buyExposurePaused
        ? "Total exposure is at the configured cap; BUY processing is paused until exposure falls below it."
        : null,
      realizedPnlUsd,
      unrealizedPnlUsd,
      roi,
      winRate: closed > 0 ? winners / closed : 0,
      winners,
      losers,
      nextTradeSizeUsd: calculateNextTradeSize(settings, availableBalanceUsd),
      totalTrades: trades.filter((t) => t.status === "simulated" || t.status === "copied" || t.status === "dry-run").length,
      failedTrades: trades.filter((t) => t.status === "failed").length,
      skippedTrades: trades.filter((t) => t.status === "skipped").length,
      openPositions: positions.length,
      totalOpenCostBasisUsd,
      totalExposureUsd,
      totalExposurePercent,
      maxDrawdown,
      dailyPnlUsd,
      totalFrictionUsd,
      totalFeesUsd,
      dailyLossLockout,
      dailyLossLockoutReason,
      panic: Boolean(state.panic),
      panicReason: state.panic ? state.panicReason ?? "Panic stop engaged." : null,
      unreconciledLiveOrders,
      cashUsdLocalMirror,
      cashUsdAuthoritative,
      pendingReservedUsd,
      unreconciledNotionalUsd,
      accountingConfidence,
    },
  };
}
