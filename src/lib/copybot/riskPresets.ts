import type { RiskPresetId } from "./types";

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
