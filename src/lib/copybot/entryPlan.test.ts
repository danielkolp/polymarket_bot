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

  it("uses the outcome book, not the leader price, for cost", () => {
    // 5% fee rate at p=0.5 is 2.5% of price; wide 6c spread adds ~5.7%.
    const plan = planEntry({ ...base, quote: { bestBid: 0.44, bestAsk: 0.5, midpoint: 0.47 } });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.reason).toMatch(/entry cost/);
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
