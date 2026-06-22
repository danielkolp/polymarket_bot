import type { BotSettings, RiskPresetId } from "./types";

export interface RiskPreset {
  id: RiskPresetId;
  label: string;
  totalExposurePercent: number;
  perMarketExposurePercent: number;
  /** Skip BUYs in markets that resolve within this many minutes. */
  minTimeToResolutionMinutes: number;
  /** Minimum acceptable BUY token price, as a fraction (0.05 = 5c). */
  minBuyTokenPrice: number;
  /** Maximum acceptable BUY token price, as a fraction (0.85 = 85c). */
  maxBuyTokenPrice: number;
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

/** The numeric settings fields each non-custom preset pins server-side. */
export const PRESET_CONTROLLED_KEYS = [
  "maxTotalExposurePercent",
  "maxExposurePerMarketPercent",
  "minTimeToResolutionMinutes",
  "minBuyTokenPrice",
  "maxBuyTokenPrice",
] as const satisfies readonly (keyof BotSettings)[];

/** Map a preset definition onto the settings fields it controls. */
export function presetControlledValues(preset: RiskPreset): Pick<BotSettings, (typeof PRESET_CONTROLLED_KEYS)[number]> {
  return {
    maxTotalExposurePercent: preset.totalExposurePercent,
    maxExposurePerMarketPercent: preset.perMarketExposurePercent,
    minTimeToResolutionMinutes: preset.minTimeToResolutionMinutes,
    minBuyTokenPrice: preset.minBuyTokenPrice,
    maxBuyTokenPrice: preset.maxBuyTokenPrice,
  };
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
  const pinned = presetControlledValues(RISK_PRESETS[settings.riskPreset]);
  return PRESET_CONTROLLED_KEYS.some((key) => settings[key] !== pinned[key]);
}
