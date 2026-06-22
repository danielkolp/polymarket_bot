import type { BotSettings, BotState } from "./types";

export function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  mode: "simulation",
  startingBalance: 100,
  pollingIntervalSec: 30,
  topTradersToFollow: 25,
  sizingMode: "percentage",
  fixedCopyAmountUsd: 5,
  percentageCopySize: 2,
  minTradeAmountUsd: 0.01,
  maxTradeAmountUsd: 5,
  riskPreset: "conservative",
  maxExposurePerMarketPercent: 10,
  maxTotalExposurePercent: 40,
  maxDailyLossPercent: 10,
  minAvailableBalanceUsd: 1,
  sellBehavior: "proportional",
  minTraderWeeklyVolumeUsd: 100,
  minTraderTradeCount: 1,
  maxTraderInactivityHours: 4,
  minMarketLiquidityUsd: 250,
  minBuyTokenPrice: 0.1,
  maxBuyTokenPrice: 0.75,
  maxMarketSpread: 0.08,
  minTimeToResolutionMinutes: 60,
  maxTradeAgeSec: 300,
  traderRefreshIntervalMin: 10,
  sessionOnly: false,
  autoExitTakeProfitPercent: 0,
  autoExitStopLossPercent: 0,
  autoExitMaxHoldMinutes: 0,
  realisticFills: true,
  takerFeeBps: 0,
  maxSlippageBps: 500,
  fallbackSpreadBps: 200,
};

export function createInitialBotState(startingBalance: number, now = Date.now()): BotState {
  return {
    runState: "stopped",
    startedAt: null,
    stoppedAt: null,
    pausedAt: null,
    lastPollAt: null,
    nextPollAt: null,
    lastDiscoveryAt: null,
    lastError: null,
    dailyDate: todayKey(now),
    dailyStartEquityUsd: startingBalance,
    peakEquityUsd: startingBalance,
    firstRunBootstrappedAt: null,
    sessionWalletsChecked: 0,
    sessionTradesScanned: 0,
  };
}
