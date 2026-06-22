import type { BotSettings, RiskPresetId } from "./types";

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

export const RISK_PRESETS: Record<RiskPresetId, RiskPreset> = {
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
      // wallets, and copy the same hot wallet more often.
      maxTradeAgeSec: 300,
      maxTraderInactivityHours: 12,
      maxCopiesPerWalletPerCycle: 10,
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
    totalExposurePercent: 45,
    perMarketExposurePercent: 10,
    minTimeToResolutionMinutes: 60,
    minBuyTokenPrice: 0.05,
    maxBuyTokenPrice: 0.85,
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

/**
 * Make risk presets server-authoritative: whenever `riskPreset` is a non-custom
 * preset, force every preset-controlled numeric field back to that preset's
 * value. This is pure and idempotent, so it is safe to apply on every load and
 * every update — stale `settings.json` that kept old numeric fields under a new
 * preset label is corrected here. Custom is left untouched.
 */
export function applyRiskPreset(settings: BotSettings): BotSettings {
  if (settings.riskPreset === "custom" || !isRiskPresetId(settings.riskPreset)) return settings;
  const preset = RISK_PRESETS[settings.riskPreset];
  return { ...settings, ...presetControlledValues(preset) };
}

/**
 * True when any preset-controlled field in `settings` diverges from what the
 * selected non-custom preset dictates (i.e. applying the preset would change it).
 */
export function settingsDivergeFromPreset(settings: BotSettings): boolean {
  if (settings.riskPreset === "custom" || !isRiskPresetId(settings.riskPreset)) return false;
  const preset = RISK_PRESETS[settings.riskPreset];
  const pinned = presetControlledValues(preset);
  return presetControlledKeys(preset).some((key) => settings[key] !== pinned[key]);
}
