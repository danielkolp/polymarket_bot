import { describe, expect, it } from "vitest";
import { planEntry, proportionalSellShares } from "./entryPlan";

const params = { minOrderSize: 5, tickSize: 0.01, feeRate: 0.05, feeExponent: 1 };
const base = {
  leaderPrice: 0.5,
  quote: { bestBid: 0.49, bestAsk: 0.5, midpoint: 0.495 },
  params,
  requestedUsd: 3,
  maxAllowedUsd: 5,
  maxAdverseEntryMoveCents: 2,
  maxEntryCostPercent: 4,
};

describe("planEntry", () => {
  it("caps the worst price at leader + allowed chase", () => {
    const plan = planEntry(base);
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.limitPrice).toBeCloseTo(0.52, 10);
      expect(plan.usd).toBe(3);
    }
  });

  it("skips when the ask already ran past the cap", () => {
    const plan = planEntry({ ...base, quote: { bestBid: 0.54, bestAsk: 0.55, midpoint: 0.545 } });
    expect(plan.ok).toBe(false);
  });

  it("counts fee + premium over the trader, not the half-spread", () => {
    // Wide 6c spread but we pay the trader's own price: only the 2.5% fee counts.
    const plan = planEntry({ ...base, quote: { bestBid: 0.44, bestAsk: 0.5, midpoint: 0.47 } });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.entryCostFraction).toBeCloseTo(0.025, 3);
  });

  it("passes a typical 30c entry on Safe (live case: ~2.7% fee + 1c premium)", () => {
    const plan = planEntry({
      ...base,
      leaderPrice: 0.31,
      quote: { bestBid: 0.31, bestAsk: 0.32, midpoint: 0.315 },
      params: { ...params, feeRate: 0.04 },
      maxEntryCostPercent: 6,
    });
    expect(plan.ok).toBe(true);
  });

  it("still rejects an entry that costs too much to copy", () => {
    // 2c premium on a 22c ask is ~9%, plus a ~3.9% fee.
    const plan = planEntry({
      ...base,
      leaderPrice: 0.2,
      quote: { bestBid: 0.21, bestAsk: 0.22, midpoint: 0.215 },
      maxEntryCostPercent: 6,
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/too costly/);
  });

  it("bumps a too-small order up to the 5-share minimum when caps allow", () => {
    const plan = planEntry({ ...base, requestedUsd: 1 });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.bumpedToMinimum).toBe(true);
      // 5 shares * 1.05 buffer at the 0.52 limit ≈ $2.73
      expect(plan.usd).toBeGreaterThanOrEqual(2.73);
      expect(plan.usd / plan.limitPrice).toBeGreaterThanOrEqual(5);
    }
  });

  it("skips when caps don't allow a sellable size", () => {
    const plan = planEntry({ ...base, requestedUsd: 1, maxAllowedUsd: 2 });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/minimum/);
  });

  it("never exceeds what the caps allow", () => {
    const plan = planEntry({ ...base, requestedUsd: 10, maxAllowedUsd: 4 });
    expect(plan.ok && plan.usd).toBe(4);
  });

  it("fee-free markets pass the cost check easily", () => {
    const plan = planEntry({ ...base, params: { ...params, feeRate: 0 } });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.feeFraction).toBe(0);
  });

  it("rejects an empty book", () => {
    expect(planEntry({ ...base, quote: { bestBid: null, bestAsk: null, midpoint: null } }).ok).toBe(false);
  });
});

describe("proportionalSellShares", () => {
  it("sells the same fraction the leader sold", () => {
    expect(proportionalSellShares({ heldShares: 20, leaderSoldShares: 500, leaderSharesBefore: 1000, minOrderSize: 5 })).toBe(10);
  });
  it("sells everything when the leader exits (almost) fully", () => {
    expect(proportionalSellShares({ heldShares: 20, leaderSoldShares: 980, leaderSharesBefore: 1000, minOrderSize: 5 })).toBe(20);
  });
  it("sells everything instead of leaving unsellable dust", () => {
    expect(proportionalSellShares({ heldShares: 8, leaderSoldShares: 500, leaderSharesBefore: 1000, minOrderSize: 5 })).toBe(8);
  });
  it("sells everything when the leader's prior size is unknown", () => {
    expect(proportionalSellShares({ heldShares: 12, leaderSoldShares: 10, leaderSharesBefore: null, minOrderSize: 5 })).toBe(12);
  });
});
