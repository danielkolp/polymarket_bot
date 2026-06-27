import { describe, expect, it } from "vitest";
import { DEFAULT_BOT_SETTINGS } from "./defaults";
import { applyRiskPreset } from "./riskPresets";

describe("applyRiskPreset", () => {
  it("pins Action Mode simulation copies per wallet to 3", () => {
    const settings = applyRiskPreset({
      ...DEFAULT_BOT_SETTINGS,
      mode: "simulation",
      riskPreset: "action",
      maxCopiesPerWalletPerCycle: 10,
    });

    expect(settings.maxCopiesPerWalletPerCycle).toBe(3);
  });

  it("clamps Action Mode to the non-negotiable real-money caps regardless of preset", () => {
    const settings = applyRiskPreset({
      ...DEFAULT_BOT_SETTINGS,
      mode: "real",
      riskPreset: "action",
      maxCopiesPerWalletPerCycle: 10,
      maxExposurePerWalletPercent: 25,
      maxTotalExposurePercent: 85,
      maxExposurePerMarketPercent: 20,
      maxMarketSpread: 0.15,
      maxAdverseEntryMoveCents: 0,
      liveMaxCopyTradeAgeSec: 300,
      startingBalance: 100,
      minAvailableBalanceUsd: 0,
    });

    // Real mode tightens these regardless of the (loose) Action preset values.
    expect(settings.maxCopiesPerWalletPerCycle).toBe(1);
    expect(settings.maxExposurePerWalletPercent).toBe(10);
    expect(settings.maxTotalExposurePercent).toBe(30);
    expect(settings.maxExposurePerMarketPercent).toBe(4);
    expect(settings.maxMarketSpread).toBeCloseTo(0.05, 10);
    // Adverse-entry gate forced on (0 → 2c) and freshness capped to 90s.
    expect(settings.maxAdverseEntryMoveCents).toBe(2);
    expect(settings.liveMaxCopyTradeAgeSec).toBe(90);
    // Min available balance floored to 25% of bankroll.
    expect(settings.minAvailableBalanceUsd).toBeCloseTo(25, 10);
  });

  it("does not clamp simulation settings (Action Mode stays loose)", () => {
    const settings = applyRiskPreset({
      ...DEFAULT_BOT_SETTINGS,
      mode: "simulation",
      riskPreset: "action",
    });
    expect(settings.maxTotalExposurePercent).toBe(85);
    expect(settings.maxExposurePerMarketPercent).toBe(20);
  });

  it("keeps Live Default stricter at one copy per wallet", () => {
    const settings = applyRiskPreset({
      ...DEFAULT_BOT_SETTINGS,
      mode: "real",
      riskPreset: "live-default",
      maxCopiesPerWalletPerCycle: 10,
      maxExposurePerWalletPercent: 25,
    });

    expect(settings.maxCopiesPerWalletPerCycle).toBe(1);
    expect(settings.maxExposurePerWalletPercent).toBe(10);
  });
});
