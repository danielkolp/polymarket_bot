import { describe, expect, it } from "vitest";
import { applyCopyScores, computeCopyScore } from "./copyScore";
import { makePosition, makeTrade } from "./testFixtures";

const WALLET = "0x" + "b".repeat(40);

describe("computeCopyScore", () => {
  it("computes ROI from authoritative notional for reconciled real BUYs", () => {
    const buy = makeTrade({
      traderWallet: WALLET,
      mode: "real",
      side: "BUY",
      reconciliationStatus: "matched",
      copyAmountUsd: 10,
      actualNotionalUsd: 8,
      realizedPnlUsd: 0,
    });
    const sell = makeTrade({
      traderWallet: WALLET,
      mode: "real",
      side: "SELL",
      reconciliationStatus: "matched",
      realizedPnlUsd: 4,
    });
    const score = computeCopyScore(WALLET, [buy, sell], []);
    expect(score.investedUsd).toBe(8);
    expect(score.copyRoi).toBeCloseTo(0.5); // 4 / 8
    expect(score.realizedPnlUsd).toBe(4);
  });

  it("flags meaningful negative ROI for auto-disable after the larger sample", () => {
    const trades = Array.from({ length: 40 }, () =>
      makeTrade({ traderWallet: WALLET, side: "BUY", copyAmountUsd: 10, realizedPnlUsd: -0.6 }),
    );
    const score = computeCopyScore(WALLET, trades, []);
    expect(score.filledCopies).toBe(40);
    expect(score.copyRoi).toBeCloseTo(-0.06);
    expect(score.autoDisableReason).toMatch(/negative copy roi/i);
    expect(score.reviewReason).toBeNull();
  });

  it("marks tiny unrealized negative ROI under review without auto-disable", () => {
    const buy = makeTrade({ traderWallet: WALLET, side: "BUY", copyAmountUsd: 100, copiedShares: 200 });
    const pos = makePosition({ sourceWallets: [WALLET], avgPrice: 0.5, markPrice: 0.4985, shares: 200 });
    const score = computeCopyScore(WALLET, [buy], [pos]);
    expect(score.copyRoi).toBeCloseTo(-0.003);
    expect(score.autoDisableReason).toBeNull();
    expect(score.reviewReason).toMatch(/under review/i);
  });

  it("marks material losses under review below the minimum auto-disable sample", () => {
    const trades = [makeTrade({ traderWallet: WALLET, side: "BUY", copyAmountUsd: 10, realizedPnlUsd: -5 })];
    const score = computeCopyScore(WALLET, trades, []);
    expect(score.copyRoi).toBeCloseTo(-0.5);
    expect(score.autoDisableReason).toBeNull();
    expect(score.reviewReason).toMatch(/1\/40 copied trades/i);
  });

  it("marks high skip ratios under review without auto-disable", () => {
    const trades = Array.from({ length: 8 }, () => makeTrade({ traderWallet: WALLET, status: "skipped" }));
    const score = computeCopyScore(WALLET, trades, []);
    expect(score.skipRatio).toBe(1);
    expect(score.autoDisableReason).toBeNull();
    expect(score.reviewReason).toMatch(/fail risk gates/i);
  });
});

describe("applyCopyScores", () => {
  const baseTrader = {
    wallet: WALLET,
    name: "w",
    enabled: true,
    source: "auto" as const,
    rank: 1,
    weeklyPnlUsd: 0,
    weeklyVolumeUsd: 0,
    weeklyTradeCount: 0,
    copiedTradeCount: 0,
    copiedSimPnlUsd: 0,
    lastTradeAt: null,
    addedAt: 0,
    updatedAt: 0,
  };

  const losingTrades = Array.from({ length: 40 }, () =>
    makeTrade({ traderWallet: WALLET, side: "BUY", copyAmountUsd: 10, realizedPnlUsd: -0.6 }),
  );

  it("auto-disables a failing wallet and reports it as newly disabled", () => {
    const { traders, newlyDisabled } = applyCopyScores([baseTrader], losingTrades, []);
    expect(traders[0].autoDisabled).toBe(true);
    expect(traders[0].underReview).toBe(false);
    expect(newlyDisabled).toHaveLength(1);
  });

  it("never auto-disables a pinned wallet", () => {
    const { traders, newlyDisabled } = applyCopyScores([{ ...baseTrader, pinned: true }], losingTrades, []);
    expect(traders[0].autoDisabled).toBe(false);
    expect(traders[0].underReview).toBe(true);
    expect(newlyDisabled).toHaveLength(0);
    expect(traders[0].copyScore).not.toBeNull();
  });

  it("attributes open-position unrealized PnL to the source wallet", () => {
    const buy = makeTrade({ traderWallet: WALLET, side: "BUY", copyAmountUsd: 10 });
    const pos = makePosition({ sourceWallets: [WALLET], avgPrice: 0.5, markPrice: 0.6, shares: 10 });
    const score = computeCopyScore(WALLET, [buy], [pos]);
    expect(score.openPositionCount).toBe(1);
    expect(score.unrealizedPnlUsd).toBeCloseTo(1); // (0.6-0.5)*10
  });
});
