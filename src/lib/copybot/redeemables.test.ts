import { describe, expect, it } from "vitest";
import { buildRedeemablePlan, makeRedeemRecord } from "./redeemables";
import { isFilled, tradeIsUnsafeForAccounting, tradeNotionalUsd } from "./ledger";
import { calculateCash } from "./accounting";
import { makeSettings } from "./testFixtures";
import type {
  LivePositionEntry,
  LivePositionReconciliation,
  RedeemBook,
  RedeemableItem,
} from "./types";

function entry(overrides: Partial<LivePositionEntry> = {}): LivePositionEntry {
  return {
    tokenId: "tok-win",
    conditionId: "0x" + "a".repeat(64),
    marketTitle: "Will it resolve YES?",
    outcome: "Yes",
    liveShares: 10,
    localShares: 10,
    markPrice: 0.99,
    exposureUsd: 9.9,
    classification: "known-bot-position",
    attributionKnown: true,
    redeemable: true,
    negativeRisk: false,
    ...overrides,
  };
}

function snapshot(entries: LivePositionEntry[]): LivePositionReconciliation {
  return {
    fetchedAt: 0,
    ok: true,
    error: null,
    entries,
    totalLiveExposureUsd: 0,
    unattributedExposureUsd: 0,
    unknownPositionCount: 0,
    stalePositionCount: 0,
    redeemableCount: entries.filter((e) => e.redeemable).length,
  };
}

const noRedeemed: RedeemBook = { entries: [] };

describe("buildRedeemablePlan — detection", () => {
  it("returns an empty (no-error) plan in simulation mode", () => {
    const plan = buildRedeemablePlan(snapshot([entry()]), noRedeemed, "simulation");
    expect(plan.items).toHaveLength(0);
    expect(plan.error).toBeNull();
  });

  it("surfaces an error when the snapshot is missing", () => {
    const plan = buildRedeemablePlan(null, noRedeemed, "real");
    expect(plan.error).toMatch(/snapshot/i);
  });

  it("only includes positions flagged redeemable", () => {
    const plan = buildRedeemablePlan(
      snapshot([entry({ tokenId: "win", redeemable: true }), entry({ tokenId: "open", redeemable: false })]),
      noRedeemed,
      "real",
    );
    expect(plan.items.map((i) => i.tokenId)).toEqual(["win"]);
  });

  it("computes expected payout as shares (winner pays $1/share) and totals it", () => {
    const plan = buildRedeemablePlan(
      snapshot([entry({ tokenId: "a", liveShares: 10 }), entry({ tokenId: "b", liveShares: 5 })]),
      noRedeemed,
      "real",
    );
    expect(plan.items.find((i) => i.tokenId === "a")?.expectedPayoutUsd).toBe(10);
    expect(plan.totalExpectedPayoutUsd).toBe(15);
  });

  it("excludes positions already redeemed (double-redeem guard)", () => {
    const redeemed: RedeemBook = {
      entries: [{ tokenId: "win", conditionId: "c", txHash: "0xtx", payoutUsd: 10, redeemedAt: 1, mode: "real" }],
    };
    const plan = buildRedeemablePlan(snapshot([entry({ tokenId: "win" })]), redeemed, "real");
    expect(plan.items).toHaveLength(0);
  });

  it("labels EOA + standard-CTF positions as bot-redeemable (blockedReason null)", () => {
    // Default test config: chain 137, signatureType 0, non-neg-risk → redeemable.
    const plan = buildRedeemablePlan(snapshot([entry()]), noRedeemed, "real");
    expect(plan.items[0].blockedReason).toBeNull();
    expect(plan.redeemableCount).toBe(1);
    expect(plan.manualCount).toBe(0);
  });

  it("marks neg-risk markets as manual-only (blockedReason set)", () => {
    const plan = buildRedeemablePlan(snapshot([entry({ negativeRisk: true })]), noRedeemed, "real");
    expect(plan.items[0].blockedReason).toMatch(/neg-risk/i);
    expect(plan.redeemableCount).toBe(0);
    expect(plan.manualCount).toBe(1);
  });
});

describe("makeRedeemRecord — ledger correctness", () => {
  const item: RedeemableItem = {
    tokenId: "tok-win",
    conditionId: "0xcond",
    marketTitle: "Market",
    outcome: "Yes",
    shares: 10,
    expectedPayoutUsd: 10,
    attributionKnown: true,
    classification: "known-bot-position",
    negativeRisk: false,
    blockedReason: null,
  };

  it("is a filled, authoritative SELL that does NOT block new BUYs", () => {
    const rec = makeRedeemRecord(item, 10, 4, "0xhash");
    expect(rec.side).toBe("SELL");
    expect(isFilled(rec)).toBe(true);
    // Pre-marked matched/authoritative because it carries an on-chain tx hash.
    expect(tradeIsUnsafeForAccounting(rec)).toBe(false);
    expect(tradeNotionalUsd(rec)).toBe(10);
    expect(rec.txHashes).toEqual(["0xhash"]);
  });

  it("realizes P&L as payout minus cost basis", () => {
    // Bought 10 shares @ 0.40 = $4 cost; redeemed for $10 → +$6 realized.
    const rec = makeRedeemRecord(item, 10, 4, "0xhash");
    expect(rec.realizedPnlUsd).toBe(6);
  });

  it("credits the redemption payout to cash via the ledger", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const rec = makeRedeemRecord(item, 10, 4, "0xhash");
    expect(calculateCash(settings, [rec])).toBe(110); // SELL adds proceeds
  });
});
