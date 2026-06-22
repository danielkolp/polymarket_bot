import { todayKey } from "./defaults";
import type { BotMetrics, BotPosition, BotSettings, BotState, CopyTradeRecord } from "./types";

export function clampPrice(price: number): number {
  if (!Number.isFinite(price)) return 0;
  return Math.min(0.99, Math.max(0.01, price));
}

export function positionExposure(position: BotPosition): number {
  return Math.max(0, position.shares * position.markPrice);
}

export function totalExposure(positions: BotPosition[]): number {
  return positions.reduce((sum, pos) => sum + positionExposure(pos), 0);
}

export function positionUnrealizedPnl(position: BotPosition): number {
  return (position.markPrice - position.avgPrice) * position.shares;
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

export function calculateEquity(settings: BotSettings, positions: BotPosition[], trades: CopyTradeRecord[]): number {
  return calculateCash(settings, trades) + totalExposure(positions);
}

export function calculateCash(settings: BotSettings, trades: CopyTradeRecord[]): number {
  return trades.reduce((cash, trade) => {
    if (trade.status !== "simulated" && trade.status !== "copied") return cash;
    if (trade.side === "BUY") return cash - trade.copyAmountUsd;
    return cash + trade.copyAmountUsd;
  }, settings.startingBalance);
}

export function calculateAvailableBalance(settings: BotSettings, positions: BotPosition[], trades: CopyTradeRecord[]): number {
  return Math.max(0, calculateCash(settings, trades));
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
  const cashUsd = calculateCash(settings, trades);
  const totalExposureUsd = totalExposure(positions);
  const equityUsd = cashUsd + totalExposureUsd;
  const realizedPnlUsd = trades
    .filter((trade) => trade.status === "simulated" || trade.status === "copied")
    .reduce((sum, trade) => sum + trade.realizedPnlUsd, 0);
  const unrealizedPnlUsd = positions.reduce((sum, pos) => sum + positionUnrealizedPnl(pos), 0);
  const roi = settings.startingBalance > 0 ? (equityUsd - settings.startingBalance) / settings.startingBalance : 0;
  const winners = trades.filter((t) => (t.status === "simulated" || t.status === "copied") && t.realizedPnlUsd > 0).length;
  const losers = trades.filter((t) => (t.status === "simulated" || t.status === "copied") && t.realizedPnlUsd < 0).length;
  const closed = winners + losers;
  const filled = trades.filter((t) => t.status === "simulated" || t.status === "copied");
  const totalFrictionUsd = filled.reduce((sum, t) => sum + (t.frictionUsd ?? 0), 0);
  const totalFeesUsd = filled.reduce((sum, t) => sum + (t.feeUsd ?? 0), 0);
  const dailyDate = todayKey(now);
  const dailyStartEquityUsd = state.dailyDate === dailyDate ? state.dailyStartEquityUsd : equityUsd;
  const peakEquityUsd = Math.max(state.peakEquityUsd || settings.startingBalance, equityUsd);
  const maxDrawdown = peakEquityUsd > 0 ? Math.max(0, (peakEquityUsd - equityUsd) / peakEquityUsd) : 0;
  const availableBalanceUsd = Math.max(0, cashUsd);
  const totalExposurePercent = equityUsd > 0 ? totalExposureUsd / equityUsd : 0;
  const exposureCap = settings.maxTotalExposurePercent / 100;
  const buyExposurePaused = settings.mode === "simulation" && exposureCap > 0 && totalExposurePercent >= exposureCap - 1e-9;

  const nextState: BotState = {
    ...state,
    dailyDate,
    dailyStartEquityUsd,
    peakEquityUsd,
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
      totalExposureUsd,
      totalExposurePercent,
      maxDrawdown,
      dailyPnlUsd: equityUsd - dailyStartEquityUsd,
      totalFrictionUsd,
      totalFeesUsd,
    },
  };
}
