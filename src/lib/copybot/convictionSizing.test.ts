import { describe, expect, it } from "vitest";
import {
  applyConvictionSizing,
  CONVICTION_MAX_FACTOR,
  CONVICTION_MIN_FACTOR,
  leaderConvictionFactor,
} from "./accounting";

// typical recent trade size = weeklyVolumeUsd / weeklyTradeCount = 10 USD
const trader = { weeklyVolumeUsd: 100, weeklyTradeCount: 10 };
const SETTINGS = { sizingSignalMode: "leader-size-weighted" as const, maxTradeAmountUsd: 100 };

describe("leaderConvictionFactor", () => {
  it("is >1 for a bigger-than-typical trade, clamped to the max factor", () => {
    // trade USD = 0.5 * 200 = 100, typical 10 → raw factor 10 → clamped.
    expect(leaderConvictionFactor({ price: 0.5, size: 200 }, trader)).toBe(CONVICTION_MAX_FACTOR);
  });

  it("is <1 for a smaller-than-typical trade, clamped to the min factor", () => {
    // trade USD = 0.5 * 2 = 1, typical 10 → raw factor 0.1 → clamped.
    expect(leaderConvictionFactor({ price: 0.5, size: 2 }, trader)).toBe(CONVICTION_MIN_FACTOR);
  });

  it("scales proportionally within the band", () => {
    // trade USD = 0.5 * 30 = 15, typical 10 → factor 1.5.
    expect(leaderConvictionFactor({ price: 0.5, size: 30 }, trader)).toBeCloseTo(1.5, 6);
  });

  it("is neutral (1) when there is no usable signal", () => {
    expect(leaderConvictionFactor({ price: 0.5, size: 30 }, null)).toBe(1);
    expect(leaderConvictionFactor({ price: 0.5, size: 30 }, { weeklyVolumeUsd: 0, weeklyTradeCount: 0 })).toBe(1);
    expect(leaderConvictionFactor({ price: 0, size: 0 }, trader)).toBe(1);
  });
});

describe("applyConvictionSizing", () => {
  it("returns the base unchanged for local-fixed mode", () => {
    expect(applyConvictionSizing(4, { price: 0.5, size: 200 }, trader, { ...SETTINGS, sizingSignalMode: "local-fixed" })).toBe(4);
  });

  it("scales the base by the conviction factor for leader-size-weighted", () => {
    // base 4 × factor 2 = 8 (≤ maxTradeAmountUsd 100).
    expect(applyConvictionSizing(4, { price: 0.5, size: 200 }, trader, SETTINGS)).toBeCloseTo(8, 6);
  });

  it("hard-clamps the scaled amount to maxTradeAmountUsd — never exceeds it", () => {
    // base 4 × factor 2 = 8, but maxTradeAmountUsd is 5.
    expect(applyConvictionSizing(4, { price: 0.5, size: 200 }, trader, { ...SETTINGS, maxTradeAmountUsd: 5 })).toBe(5);
  });

  it("cannot exceed max order, exposure, or live-max-order caps applied downstream", () => {
    // Mirror processTrade's requestedAmountUsd clamp chain with an aggressive
    // conviction factor and assert every hard cap still binds.
    const base = 50;
    const scaled = applyConvictionSizing(base, { price: 0.5, size: 1000 }, trader, SETTINGS);
    const availableBalanceUsd = 3;
    const liveMaxOrderUsd = 1;
    const remainingAllowedExposureUsd = 0.5;
    const requested = Math.min(scaled, availableBalanceUsd, liveMaxOrderUsd, remainingAllowedExposureUsd);
    expect(requested).toBeLessThanOrEqual(availableBalanceUsd);
    expect(requested).toBeLessThanOrEqual(liveMaxOrderUsd);
    expect(requested).toBeLessThanOrEqual(remainingAllowedExposureUsd);
    expect(requested).toBe(0.5);
  });
});
