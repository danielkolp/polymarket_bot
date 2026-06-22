import type { RiskSettings, SimMetrics } from "./types";

export function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const DEFAULT_SETTINGS: RiskSettings = {
  startingBalance: 10_000,

  // Risk controls
  maxExposurePerMarket: 500,
  maxTotalExposure: 4_000,
  maxDailyLoss: 750,
  minLiquidity: 5_000,
  minSpread: 0.01, // 1 cent — top Polymarket markets are efficient; 2c is rarely met
  staleDataTimeoutSec: 30,
  noTradeWindowMinutes: 120, // 2h before resolution

  // Strategy
  orderSize: 100,
  maxOpenOrders: 12,
  staleOrderTimeoutSec: 90,
  edgeOffset: 0.003, // quote ~0.3c inside the touch
  takeProfitOffset: 0.01, // resting maker exit ~1c above entry
  fillRatio: 0.5,

  // Active position management
  takeProfitPct: 0.08, // bank a winner once it's up 8%
  stopLossPct: 0.1, // cut a loser once it's down 10%
  feeBps: 0, // Polymarket CLOB spot fees are ~0; configurable for stress-testing

  // Buy-low entry gate
  dipLookback: 12, // ~last 12 ticks as the reference price
  buyDipThreshold: 0, // only buy at/below the recent average (true "buy the dip")

  // Copy-trading
  strategyMode: "spread",
  copyPerTradeUsd: 50,
  copyMaxLeaders: 5,
  copyLeaderMetric: "profit",
  copyLeaderWindow: "7d",
  copySlippageBps: 50, // ~0.5% worse than the trader to model lateness
  copyRecencyMinutes: 30, // only copy trades from the last 30 min when first seen

  tickIntervalSec: 4,
};

export function initialMetrics(startingBalance: number, now = Date.now()): SimMetrics {
  return {
    cash: startingBalance,
    equity: startingBalance,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalExposure: 0,
    roi: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    peakEquity: startingBalance,
    maxDrawdown: 0,
    dailyPnl: 0,
    dailyStartEquity: startingBalance,
    dailyDate: todayKey(now),
  };
}
