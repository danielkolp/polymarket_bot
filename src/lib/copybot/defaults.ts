import type { BotSettings, BotState } from "./types";

export function todayKey(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  mode: "simulation",
  // Seed-only — only used if data/settings.json doesn't exist yet.
  // To change the bankroll: edit data/settings.json directly (key: "startingBalance"), then reset the sim.
  startingBalance: 15,
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
  // Edge protection: skip BUYs chasing more than 3c past the leader's fill in
  // simulation; real mode is clamped tighter (≤2c) and forced on.
  maxAdverseEntryMoveCents: 3,
  // Stricter real-mode BUY freshness (seconds) on top of the hard 5-minute cap.
  liveMaxCopyTradeAgeSec: 75,
  // Exit a copied position once its source leader has exited (gated in real mode).
  exitWhenLeaderNoLongerHolds: true,
  // Copy sizing signal. "local-fixed" preserves prior behavior.
  sizingSignalMode: "local-fixed",
  maxCopiesPerWalletPerCycle: 3,
  maxExposurePerWalletPercent: 25,
  walletTradeCooldownSec: 60,
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
    dailyStartBotPnlUsd: 0,
    peakEquityUsd: startingBalance,
    firstRunBootstrappedAt: null,
    sessionWalletsChecked: 0,
    sessionTradesScanned: 0,
    dailyLossLockout: false,
    panic: false,
    panicAt: null,
    panicReason: null,
  };
}
