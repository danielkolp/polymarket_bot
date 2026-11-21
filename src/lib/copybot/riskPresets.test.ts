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
      liveMaxCopyTradeAgeSec: 3600,
      startingBalance: 100,
      minAvailableBalanceUsd: 0,
    });

    // Real mode tightens these regardless of the (loose) Action preset values.
    expect(settings.maxCopiesPerWalletPerCycle).toBe(2);
    expect(settings.maxExposurePerWalletPercent).toBe(25);
    expect(settings.maxTotalExposurePercent).toBe(85);
    expect(settings.maxExposurePerMarketPercent).toBe(15);
    expect(settings.maxMarketSpread).toBeCloseTo(0.05, 10);
    // Adverse-entry gate forced on (0 → 3c) and freshness capped to 480s
    // (Polymarket's public trade feed runs ~4 minutes behind).
    expect(settings.maxAdverseEntryMoveCents).toBe(3);
    expect(settings.liveMaxCopyTradeAgeSec).toBe(480);
    // A cash reserve is always kept in real mode; the min-balance field is no
    // longer ratcheted up from the bankroll.
    expect(settings.cashReservePercent).toBeGreaterThanOrEqual(10);
    expect(settings.minAvailableBalanceUsd).toBe(0);
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

  it("Safe preset sizes a $50 account into sellable orders", () => {
    const settings = applyRiskPreset({ ...DEFAULT_BOT_SETTINGS, mode: "real", riskPreset: "safe" });
    expect(settings.sizingMode).toBe("hybrid");
    expect(settings.sizingBase).toBe("equity");
    expect(settings.percentageCopySize).toBe(3);
    expect(settings.maxTradeAmountUsd).toBe(3);
    expect(settings.maxTotalExposurePercent).toBe(60);
    expect(settings.maxExposurePerMarketPercent).toBe(5);
    expect(settings.maxOpenPositions).toBe(8);
    expect(settings.maxBuyTokenPrice).toBeCloseTo(0.85, 10);
    expect(settings.minBuyTokenPrice).toBeCloseTo(0.2, 10);
    expect(settings.topTradersToFollow).toBe(16);
    expect(settings.cashReservePercent).toBe(25);
    expect(settings.maxDailyLossPercent).toBe(8);
    expect(settings.autoExitTakeProfitPercent).toBe(30);
    expect(settings.autoExitStopLossPercent).toBe(25);
    // Real-mode envelope never loosens Safe.
    expect(settings.maxAdverseEntryMoveCents).toBe(2);
    expect(settings.maxMarketSpread).toBeCloseTo(0.03, 10);
  });

  it("Growth is looser than Balanced which is looser than Safe", () => {
    const safe = applyRiskPreset({ ...DEFAULT_BOT_SETTINGS, mode: "real", riskPreset: "safe" });
    const steady = applyRiskPreset({ ...DEFAULT_BOT_SETTINGS, mode: "real", riskPreset: "steady" });
    const growth = applyRiskPreset({ ...DEFAULT_BOT_SETTINGS, mode: "real", riskPreset: "growth" });
    expect(steady.maxTradeAmountUsd).toBeGreaterThan(safe.maxTradeAmountUsd);
    expect(growth.maxTradeAmountUsd).toBeGreaterThan(steady.maxTradeAmountUsd);
    expect(steady.maxTotalExposurePercent).toBeGreaterThan(safe.maxTotalExposurePercent);
    expect(growth.maxTotalExposurePercent).toBeGreaterThan(steady.maxTotalExposurePercent);
    expect(steady.maxBuyTokenPrice).toBeGreaterThanOrEqual(safe.maxBuyTokenPrice);
    expect(growth.maxBuyTokenPrice).toBeGreaterThanOrEqual(steady.maxBuyTokenPrice);
    expect(steady.topTradersToFollow).toBeGreaterThan(safe.topTradersToFollow);
    expect(growth.topTradersToFollow).toBeGreaterThan(steady.topTradersToFollow);
  });
});
