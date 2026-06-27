import { describe, expect, it } from "vitest";
import { reconcileAccountPositions } from "./livePositions";
import { makePosition } from "./testFixtures";
import type { AccountPosition } from "@/lib/polymarket/positions";
import type { FollowedTrader } from "./types";

function makeAccountPosition(overrides: Partial<AccountPosition> = {}): AccountPosition {
  return {
    wallet: "0xwallet",
    tokenId: "tok",
    conditionId: "cond",
    size: 1.6666,
    avgPrice: 0.6,
    curPrice: 0.595,
    initialValueUsd: 1,
    currentValueUsd: 0.9916,
    cashPnlUsd: -0.0084,
    percentPnl: -0.0084,
    redeemable: false,
    title: "market",
    slug: "slug",
    outcome: "Under",
    endDate: null,
    negativeRisk: false,
    ...overrides,
  };
}

function makeTrader(wallet: string): FollowedTrader {
  return {
    wallet,
    name: "wallet",
    enabled: true,
    source: "manual",
    rank: null,
    weeklyPnlUsd: 0,
    weeklyVolumeUsd: 0,
    weeklyTradeCount: 0,
    copiedTradeCount: 0,
    copiedSimPnlUsd: 0,
    lastTradeAt: null,
    addedAt: 1,
    updatedAt: 1,
  };
}

describe("reconcileAccountPositions", () => {
  it("uses Polymarket account avg price instead of stale local mirror cost basis", () => {
    const local = makePosition({
      tokenId: "tok",
      conditionId: "cond",
      outcome: "Under",
      shares: 2.3809,
      avgPrice: 0.42,
      markPrice: 0.42,
      sourceWallets: ["0x" + "a".repeat(40)],
    });

    const { snapshot, positions } = reconcileAccountPositions(
      [makeAccountPosition()],
      [local],
      [makeTrader(local.sourceWallets[0])],
      Date.UTC(2026, 5, 23),
    );

    expect(snapshot.entries[0].classification).toBe("known-bot-position");
    expect(positions[0].shares).toBeCloseTo(1.6666);
    expect(positions[0].avgPrice).toBeCloseTo(0.6);
    expect(positions[0].markPrice).toBeCloseTo(0.595);
    expect(positions[0].sourceWallets).toEqual(local.sourceWallets);
  });

  it("excludes resolved/redeemable positions from the open-positions book and exposure", () => {
    const { snapshot, positions } = reconcileAccountPositions(
      [
        makeAccountPosition({ tokenId: "open", redeemable: false, size: 2, curPrice: 0.5 }),
        makeAccountPosition({ tokenId: "resolved", redeemable: true, size: 10, curPrice: 0.01 }),
      ],
      [],
      [],
      Date.UTC(2026, 5, 23),
    );

    // Both surface in the snapshot entries…
    expect(snapshot.entries.map((e) => e.tokenId).sort()).toEqual(["open", "resolved"]);
    expect(snapshot.redeemableCount).toBe(1);
    // …but only the open one is adopted as an authoritative open position.
    expect(positions.map((p) => p.tokenId)).toEqual(["open"]);
    // Resolved dust is not counted as open exposure.
    expect(snapshot.totalLiveExposureUsd).toBeCloseTo(1, 6); // 2 * 0.5
  });

  it("does not let a resolved (unknown) position block new BUYs via unknownPositionCount", () => {
    const { snapshot } = reconcileAccountPositions(
      [makeAccountPosition({ tokenId: "resolved", redeemable: true, size: 5 })],
      [],
      [],
      Date.UTC(2026, 5, 23),
    );
    expect(snapshot.unknownPositionCount).toBe(0);
    expect(snapshot.redeemableCount).toBe(1);
  });
});