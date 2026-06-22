/**
 * Mark-to-market and metric computation. Total PnL is derived from equity vs
 * starting balance; realized is then total minus unrealized, so we don't have
 * to track the realized history of positions that have already been closed.
 */
import type { EngineCtx } from "./engineCtx";
import { todayKey } from "./defaults";
import type { RiskSettings, SimMetrics } from "./types";

export interface MarkResult {
  holdingsValue: number;
  unrealizedPnl: number;
  totalExposure: number;
}

/** Update each position's mark from its current view; return aggregate values. */
export function markPositions(ctx: EngineCtx): MarkResult {
  let holdingsValue = 0;
  let unrealizedPnl = 0;
  let totalExposure = 0;

  for (const pos of ctx.positionsByToken.values()) {
    const view = ctx.views.get(pos.tokenId);
    const mark = view?.mid ?? pos.markPrice;
    pos.markPrice = mark;
    const value = pos.shares * mark;
    holdingsValue += value;
    unrealizedPnl += (mark - pos.avgPrice) * pos.shares;
    totalExposure += Math.abs(value);
  }

  return { holdingsValue, unrealizedPnl, totalExposure };
}

export function computeMetrics(
  prev: SimMetrics,
  ctx: EngineCtx,
  settings: RiskSettings,
  mark: MarkResult,
): SimMetrics {
  const startingBalance = settings.startingBalance;
  const equity = ctx.cash + mark.holdingsValue;
  const totalPnl = equity - startingBalance;
  const unrealizedPnl = mark.unrealizedPnl;
  const realizedPnl = totalPnl - unrealizedPnl;
  const roi = startingBalance > 0 ? totalPnl / startingBalance : 0;

  const totalTrades = ctx.wins + ctx.losses;
  const winRate = totalTrades > 0 ? ctx.wins / totalTrades : 0;

  const peakEquity = Math.max(prev.peakEquity, equity);
  const drawdown = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
  const maxDrawdown = Math.max(prev.maxDrawdown, drawdown);

  // Daily rollover.
  const today = todayKey(ctx.now);
  let dailyDate = prev.dailyDate;
  let dailyStartEquity = prev.dailyStartEquity;
  if (today !== prev.dailyDate) {
    dailyDate = today;
    dailyStartEquity = equity;
  }
  const dailyPnl = equity - dailyStartEquity;

  return {
    cash: ctx.cash,
    equity,
    realizedPnl,
    unrealizedPnl,
    totalExposure: mark.totalExposure,
    roi,
    wins: ctx.wins,
    losses: ctx.losses,
    winRate,
    peakEquity,
    maxDrawdown,
    dailyPnl,
    dailyStartEquity,
    dailyDate,
  };
}
