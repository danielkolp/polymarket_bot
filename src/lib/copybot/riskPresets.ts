import type { BotSettings, RiskPresetId } from "./types";

// ── Real-money safety envelope ────────────────────────────────────────────────
// Applied to live settings on every load regardless of the selected preset, so
// loose simulation presets can never loosen real-money risk. They only ever
// TIGHTEN a configured value. The envelope is sized so a small account (e.g.
// $50) can still place orders that clear Polymarket's 5-share minimum.
export const REAL_MODE_MAX_COPIES_PER_WALLET_PER_CYCLE = 2;
export const REAL_MODE_MAX_EXPOSURE_PER_WALLET_PERCENT = 25;
export const REAL_MODE_MAX_TOTAL_EXPOSURE_PERCENT = 90;
export const REAL_MODE_MAX_PER_MARKET_EXPOSURE_PERCENT = 15;
export const REAL_MODE_MAX_MARKET_SPREAD = 0.05;
/** Real mode always keeps at least this % of account value in cash. */
export const REAL_MODE_MIN_CASH_RESERVE_PERCENT = 10;
/** Adverse-entry gate is forced on in real mode and capped at this many cents. */
export const REAL_MODE_MAX_ADVERSE_ENTRY_MOVE_CENTS = 3;
/**
 * Real-mode BUY freshness ceiling (seconds). Polymarket's public trade feed runs
 * ~4 minutes behind, so this allows ~8 minutes; every entry is still capped at
 * the leader's price + maxAdverseEntryMoveCents.
 */
export const REAL_MODE_MAX_COPY_TRADE_AGE_SEC = 480;

export interface RiskPreset {
  id: RiskPresetId;
  label: string;
  /** Short operator-facing description of how this preset behaves. */
  description?: string;
  totalExposurePercent: number;
  perMarketExposurePercent: number;
  /** Skip BUYs in markets that resolve within this many minutes. */
  minTimeToResolutionMinutes: number;
  /** Minimum acceptable BUY token price, as a fraction (0.05 = 5c). */
  minBuyTokenPrice: number;
  /** Maximum acceptable BUY token price, as a fraction (0.85 = 85c). */
  maxBuyTokenPrice: number;
  /**
   * Additional settings fields this preset pins beyond the five core risk fields
   * above (e.g. discovery breadth, polling cadence, conviction thresholds). These
   * are applied and re-pinned exactly like the core fields, and editing any of
   * them drops the preset to "custom".
   */
  extraSettings?: Partial<BotSettings>;
}


/** Settings shared by the three small-account live presets. */
const SMALL_ACCOUNT_BASE: Partial<BotSettings> = {
  sizingMode: "hybrid",
  sizingBase: "equity",
  sizingSignalMode: "local-fixed",
  minTradeAmountUsd: 1,
  minAvailableBalanceUsd: 1,
  cashReservePercent: 25,
  maxEntryCostPercent: 6,
  maxDrawdownPausePercent: 20,
  maxMarketSpread: 0.03,
  maxAdverseEntryMoveCents: 2,
  liveMaxCopyTradeAgeSec: 480,
  maxTradeAgeSec: 900,
  exitWhenLeaderNoLongerHolds: true,
  sellBehavior: "proportional",
  autoExitTakeProfitPercent: 30,
  autoExitStopLossPercent: 25,
  autoExitMaxHoldMinutes: 10 * 24 * 60,
  // Fast detection = entries closer to the trader's price. 12 wallets every 5s
  // is ~24 req/10s against Polymarket's 300 req/10s limit for /v2/trades.
  pollingIntervalSec: 5,
  traderRefreshIntervalMin: 30,
  topTradersToFollow: 12,
  minTraderWeeklyVolumeUsd: 1000,
  minTraderTradeCount: 10,
  maxTraderInactivityHours: 48,
  minMarketLiquidityUsd: 1000,
  maxCopiesPerWalletPerCycle: 1,
  maxExposurePerWalletPercent: 20,
  walletTradeCooldownSec: 300,
  consensusBoost: true,
  realisticFills: true,
  sessionOnly: false,
};

export const RISK_PRESETS: Record<RiskPresetId, RiskPreset> = {
  safe: {
    id: "safe",
    label: "Safe",
    description:
      "Built for small accounts: about 6% of your balance per trade (max $4), at most 60% invested and 8 open positions, a 25% cash cushion, buying pauses for the day after an 8% loss. Take-profit +30%, stop-loss -25%.",
    totalExposurePercent: 60,
    perMarketExposurePercent: 10,
    minTimeToResolutionMinutes: 60,
    minBuyTokenPrice: 0.2,
    // Capped at 85c from data, not taste: replaying ~15k resolved buys by
    // profitable leaderboard traders (Nov 2026, held to resolution, after fees
    // and 0.5c slippage), buys at 85-93c returned -2% to 0% per dollar for the
    // whole leaderboard and -4% to -8% for the followed traders. Their edge is
    // in the 20-80c range. Higher-priced buys add risk without adding profit.
    maxBuyTokenPrice: 0.85,
    extraSettings: {
      ...SMALL_ACCOUNT_BASE,
      topTradersToFollow: 16,
      percentageCopySize: 6,
      maxTradeAmountUsd: 4,
      maxOpenPositions: 8,
      maxDailyLossPercent: 8,
      maxHoursToResolution: 14 * 24,
    },
  },
  steady: {
    id: "steady",
    label: "Balanced",
    description:
      "About 8% of your balance per trade (max $6), up to 75% invested and 10 open positions, buying pauses for the day after a 12% loss.",
    totalExposurePercent: 75,
    perMarketExposurePercent: 12,
    minTimeToResolutionMinutes: 60,
    minBuyTokenPrice: 0.15,
    maxBuyTokenPrice: 0.85,
    extraSettings: {
      ...SMALL_ACCOUNT_BASE,
      percentageCopySize: 8,
      maxTradeAmountUsd: 6,
      maxOpenPositions: 10,
      maxDailyLossPercent: 12,
      maxHoursToResolution: 21 * 24,
      topTradersToFollow: 18,
      maxEntryCostPercent: 7,
    },
  },
  growth: {
    id: "growth",
    label: "Growth",
    description:
      "More active: about 10% of your balance per trade (max $10), up to 85% invested and 12 open positions, buying pauses for the day after a 15% loss. Bigger swings both ways.",
    totalExposurePercent: 85,
    perMarketExposurePercent: 15,
    minTimeToResolutionMinutes: 30,
    minBuyTokenPrice: 0.1,
    maxBuyTokenPrice: 0.85,
    extraSettings: {
      ...SMALL_ACCOUNT_BASE,
      percentageCopySize: 10,
      maxTradeAmountUsd: 10,
      maxOpenPositions: 12,
      maxDailyLossPercent: 15,
      maxHoursToResolution: 30 * 24,
      topTradersToFollow: 20,
      maxEntryCostPercent: 8,
      maxMarketSpread: 0.04,
      maxCopiesPerWalletPerCycle: 2,
      autoExitStopLossPercent: 30,
    },
  },
  conservative: {
    id: "conservative",
    label: "Conservative",
    totalExposurePercent: 40,
    perMarketExposurePercent: 10,
    minTimeToResolutionMinutes: 60,
    minBuyTokenPrice: 0.1,
    maxBuyTokenPrice: 0.75,
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    totalExposurePercent: 60,
    perMarketExposurePercent: 15,
    minTimeToResolutionMinutes: 30,
    minBuyTokenPrice: 0.05,
    maxBuyTokenPrice: 0.85,
  },
  "aggressive-simulation": {
    id: "aggressive-simulation",
    label: "Aggressive Simulation",
    totalExposurePercent: 80,
    perMarketExposurePercent: 20,
    minTimeToResolutionMinutes: 15,
    minBuyTokenPrice: 0.03,
    maxBuyTokenPrice: 0.95,
  },
  action: {
    id: "action",
    label: "Action Mode",
    description:
      "Follows more traders, allows fresher high-frequency copying, and lowers conviction/order thresholds to generate trades fast. Real-money safety gates (order caps, readiness, panic, daily-loss lockout) still apply.",
    // Core risk band — wide so few BUYs are filtered out on price/time.
    totalExposurePercent: 85,
    perMarketExposurePercent: 20,
    minTimeToResolutionMinutes: 10,
    minBuyTokenPrice: 0.02,
    maxBuyTokenPrice: 0.97,
    extraSettings: {
      // Follow more traders and poll faster for a higher trade rate.
      topTradersToFollow: 60,
      pollingIntervalSec: 15,
      traderRefreshIntervalMin: 5,
      // Fresher high-frequency copying: copy only very recent trades (the engine
      // hard-caps copy age at 5 min regardless), follow more recently-active
      // wallets, while keeping each hot wallet capped per poll cycle.
      maxTradeAgeSec: 300,
      maxTraderInactivityHours: 12,
      maxCopiesPerWalletPerCycle: 3,
      walletTradeCooldownSec: 15,
      // Lower conviction / order thresholds so more candidate trades qualify.
      minTraderWeeklyVolumeUsd: 25,
      minTraderTradeCount: 1,
      minMarketLiquidityUsd: 50,
      minTradeAmountUsd: 0.01,
      maxMarketSpread: 0.15,
    },
  },
  "live-default": {
    id: "live-default",
    label: "Live Default",
    description:
      "Legacy very tight real-money caps (4% per market). Too small for accounts under ~$150 because Polymarket orders need at least 5 shares - prefer Safe.",
    totalExposurePercent: 30,
    perMarketExposurePercent: 4,
    minTimeToResolutionMinutes: 60,
    minBuyTokenPrice: 0.05,
    maxBuyTokenPrice: 0.85,
    extraSettings: {
      maxCopiesPerWalletPerCycle: 1,
      maxExposurePerWalletPercent: 10,
      maxMarketSpread: REAL_MODE_MAX_MARKET_SPREAD,
      maxAdverseEntryMoveCents: 2,
      liveMaxCopyTradeAgeSec: 60,
    },
  },
  custom: {
    id: "custom",
    label: "Custom",
    totalExposurePercent: 40,
    perMarketExposurePercent: 10,
    minTimeToResolutionMinutes: 60,
    minBuyTokenPrice: 0.1,
    maxBuyTokenPrice: 0.75,
  },
};

export function isRiskPresetId(value: unknown): value is RiskPresetId {
  return typeof value === "string" && value in RISK_PRESETS;
}

/** The five core risk fields every non-custom preset pins server-side. */
export const CORE_PRESET_KEYS = [
  "maxTotalExposurePercent",
  "maxExposurePerMarketPercent",
  "minTimeToResolutionMinutes",
  "minBuyTokenPrice",
  "maxBuyTokenPrice",
] as const satisfies readonly (keyof BotSettings)[];

/** Map a preset definition onto every settings field it controls (core + extra). */
export function presetControlledValues(preset: RiskPreset): Partial<BotSettings> {
  return {
    maxTotalExposurePercent: preset.totalExposurePercent,
    maxExposurePerMarketPercent: preset.perMarketExposurePercent,
    minTimeToResolutionMinutes: preset.minTimeToResolutionMinutes,
    minBuyTokenPrice: preset.minBuyTokenPrice,
    maxBuyTokenPrice: preset.maxBuyTokenPrice,
    ...preset.extraSettings,
  };
}

/** The settings keys a given preset pins (core five plus any extras). */
export function presetControlledKeys(preset: RiskPreset): (keyof BotSettings)[] {
  return Object.keys(presetControlledValues(preset)) as (keyof BotSettings)[];
}

export function applyRealModeSafetyCaps(settings: BotSettings): BotSettings {
  if (settings.mode !== "real") return settings;

  const maxCopies =
    settings.maxCopiesPerWalletPerCycle <= 0
      ? REAL_MODE_MAX_COPIES_PER_WALLET_PER_CYCLE
      : Math.min(settings.maxCopiesPerWalletPerCycle, REAL_MODE_MAX_COPIES_PER_WALLET_PER_CYCLE);
  const maxWalletExposure =
    settings.maxExposurePerWalletPercent <= 0
      ? REAL_MODE_MAX_EXPOSURE_PER_WALLET_PERCENT
      : Math.min(settings.maxExposurePerWalletPercent, REAL_MODE_MAX_EXPOSURE_PER_WALLET_PERCENT);
  const maxTotalExposure = Math.min(settings.maxTotalExposurePercent, REAL_MODE_MAX_TOTAL_EXPOSURE_PERCENT);
  const maxPerMarketExposure = Math.min(settings.maxExposurePerMarketPercent, REAL_MODE_MAX_PER_MARKET_EXPOSURE_PERCENT);
  // maxMarketSpread: 0 means "no spread filter" — never let that through in real
  // mode; force it to the real-mode ceiling.
  const maxSpread =
    settings.maxMarketSpread <= 0
      ? REAL_MODE_MAX_MARKET_SPREAD
      : Math.min(settings.maxMarketSpread, REAL_MODE_MAX_MARKET_SPREAD);
  const cashReserve = Math.max(settings.cashReservePercent ?? 0, REAL_MODE_MIN_CASH_RESERVE_PERCENT);
  // Adverse-entry gate is forced ON in real mode (0 = disabled is not allowed).
  const maxAdverse =
    settings.maxAdverseEntryMoveCents <= 0
      ? REAL_MODE_MAX_ADVERSE_ENTRY_MOVE_CENTS
      : Math.min(settings.maxAdverseEntryMoveCents, REAL_MODE_MAX_ADVERSE_ENTRY_MOVE_CENTS);
  const liveMaxAge =
    settings.liveMaxCopyTradeAgeSec <= 0
      ? REAL_MODE_MAX_COPY_TRADE_AGE_SEC
      : Math.min(settings.liveMaxCopyTradeAgeSec, REAL_MODE_MAX_COPY_TRADE_AGE_SEC);

  const next: BotSettings = {
    ...settings,
    maxCopiesPerWalletPerCycle: maxCopies,
    maxExposurePerWalletPercent: maxWalletExposure,
    maxTotalExposurePercent: maxTotalExposure,
    maxExposurePerMarketPercent: maxPerMarketExposure,
    maxMarketSpread: maxSpread,
    cashReservePercent: cashReserve,
    maxAdverseEntryMoveCents: maxAdverse,
    liveMaxCopyTradeAgeSec: liveMaxAge,
  };

  // Avoid allocating a new object when nothing actually changed.
  const unchanged = (Object.keys(next) as (keyof BotSettings)[]).every((k) => next[k] === settings[k]);
  return unchanged ? settings : next;
}

/**
 * Make risk presets server-authoritative: whenever `riskPreset` is a non-custom
 * preset, force every preset-controlled numeric field back to that preset's
 * value. This is pure and idempotent, so it is safe to apply on every load and
 * every update — stale `settings.json` that kept old numeric fields under a new
 * preset label is corrected here. Custom skips preset pinning, but real mode
 * still receives non-negotiable safety caps.
 */
export function applyRiskPreset(settings: BotSettings): BotSettings {
  if (settings.riskPreset === "custom" || !isRiskPresetId(settings.riskPreset)) return applyRealModeSafetyCaps(settings);
  const preset = RISK_PRESETS[settings.riskPreset];
  return applyRealModeSafetyCaps({ ...settings, ...presetControlledValues(preset) });
}

/**
 * True when any preset-controlled field in `settings` diverges from what the
 * selected non-custom preset dictates (i.e. applying the preset would change it).
 */
export function settingsDivergeFromPreset(settings: BotSettings): boolean {
  if (settings.riskPreset === "custom" || !isRiskPresetId(settings.riskPreset)) return false;
  const preset = RISK_PRESETS[settings.riskPreset];
  const pinned = applyRealModeSafetyCaps({ ...settings, ...presetControlledValues(preset) });
  return presetControlledKeys(preset).some((key) => settings[key] !== pinned[key]);
}
