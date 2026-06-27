import { describe, expect, it } from "vitest";
import { makePosition } from "./testFixtures";
import { floorLiveSellShares, resolveLiveSellSize } from "./liveSellSizing";
import type { LivePositionEntry, LivePositionReconciliation } from "./types";

const now = Date.UTC(2026, 5, 26, 20, 15, 16);

function snapshot(entry: Partial<LivePositionEntry> = {}): LivePositionReconciliation {
  const liveShares = entry.liveShares ?? 4.347825;
  const markPrice = entry.markPrice ?? 0.5;
  return {
    fetchedAt: now,
    ok: true,
    error: null,
    entries: [
      {
        tokenId: "tok",
        conditionId: "cond",
        marketTitle: "market",
        outcome: "Yes",
        liveShares,
        localShares: 4.76,
        markPrice,
        exposureUsd: liveShares * markPrice,
        classification: "known-bot-position",
        attributionKnown: true,
        redeemable: false,
        negativeRisk: false,
        ...entry,
      },
    ],
    totalLiveExposureUsd: liveShares * markPrice,
    unattributedExposureUsd: 0,
    unknownPositionCount: 0,
    stalePositionCount: 0,
    redeemableCount: entry.redeemable ? 1 : 0,
  };
}

describe("resolveLiveSellSize", () => {
  it("clamps stale local shares to the live sellable share balance", () => {
    const decision = resolveLiveSellSize({
      position: makePosition({ tokenId: "tok", shares: 4.76 }),
      requestedShares: 4.76,
      snapshot: snapshot({ liveShares: 4.347825 }),
      now,
      maxSnapshotAgeMs: 30_000,
    });

    expect(decision.ok).toBe(true);
    expect(decision.shares).toBe(4.347825);
    expect(decision.bookSharesBeforeSell).toBe(4.347825);
    expect(decision.clamped).toBe(true);
    expect(decision.note).toContain("clamped from 4.76");
  });

  it("floors sell sizes to six decimals so it never rounds above wallet balance", () => {
    expect(floorLiveSellShares(4.3478259)).toBe(4.347825);
  });

  it("blocks live sells when the live-position snapshot is stale", () => {
    const decision = resolveLiveSellSize({
      position: makePosition({ tokenId: "tok", shares: 4.76 }),
      requestedShares: 4.76,
      snapshot: snapshot(),
      now: now + 31_000,
      maxSnapshotAgeMs: 30_000,
    });

    expect(decision.ok).toBe(false);
    expect(decision.reason).toBe("live position snapshot is stale");
  });
});
