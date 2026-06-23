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

  it("caps Action Mode real wallets to two copies and ten percent exposure", () => {
    const settings = applyRiskPreset({
      ...DEFAULT_BOT_SETTINGS,
      mode: "real",
      riskPreset: "action",
      maxCopiesPerWalletPerCycle: 10,
      maxExposurePerWalletPercent: 25,
    });

    expect(settings.maxCopiesPerWalletPerCycle).toBe(2);
    expect(settings.maxExposurePerWalletPercent).toBe(10);
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
