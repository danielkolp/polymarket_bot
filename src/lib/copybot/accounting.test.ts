import { describe, expect, it } from "vitest";
import { buildMetrics, calculateCash } from "./accounting";
import { makePosition, makeSettings, makeState, makeTrade } from "./testFixtures";
import type { BotMetrics, BotSettings } from "./types";

const DAY1 = Date.UTC(2026, 5, 1, 12);
const DAY2 = Date.UTC(2026, 5, 2, 12);

function expectAccountingInvariant(settings: BotSettings, metrics: BotMetrics): void {
  expect(metrics.equityUsd).toBeCloseTo(settings.startingBalance + metrics.realizedPnlUsd + metrics.unrealizedPnlUsd);
  expect(metrics.equityUsd).toBeCloseTo(metrics.cashUsd + metrics.totalExposureUsd);
  expect(metrics.unrealizedPnlUsd).toBeCloseTo(metrics.totalExposureUsd - metrics.totalOpenCostBasisUsd);
  expect(metrics.roi).toBeCloseTo((metrics.realizedPnlUsd + metrics.unrealizedPnlUsd) / settings.startingBalance);
}

describe("calculateCash with authoritative fill fields", () => {
  it("uses mirror estimates before reconciliation", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const buy = makeTrade({ side: "BUY", mode: "real", reconciliationStatus: "pending", copyAmountUsd: 10 });
    expect(calculateCash(settings, [buy])).toBe(90);
  });

  it("prefers authoritative notional once a real BUY is reconciled", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const buy = makeTrade({
      side: "BUY",
      mode: "real",
      reconciliationStatus: "matched",
      copyAmountUsd: 10,
      actualNotionalUsd: 7.5,
    });
    expect(calculateCash(settings, [buy])).toBe(92.5);
    // mirrorOnly still reflects the original estimate
    expect(calculateCash(settings, [buy], { mirrorOnly: true })).toBe(90);
  });

  it("adds authoritative notional for reconciled SELLs", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const sell = makeTrade({
      side: "SELL",
      mode: "real",
      reconciliationStatus: "matched",
      copyAmountUsd: 8,
      actualNotionalUsd: 9,
    });
    expect(calculateCash(settings, [sell])).toBe(109);
  });
});

describe("buildMetrics accounting invariant", () => {
  it("derives equity from starting balance plus realized and unrealized P&L", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const positions = [makePosition({ shares: 20, avgPrice: 0.5, markPrice: 0.45 })];
    const { metrics } = buildMetrics(settings, makeState(), positions, [], DAY1);

    expect(metrics.totalOpenCostBasisUsd).toBeCloseTo(10);
    expect(metrics.totalExposureUsd).toBeCloseTo(9);
    expect(metrics.cashUsd).toBeCloseTo(90);
    expect(metrics.unrealizedPnlUsd).toBeCloseTo(-1);
    expect(metrics.equityUsd).toBeCloseTo(99);
    expectAccountingInvariant(settings, metrics);
  });

  it("does not inflate equity when retained trades are missing open BUY cost", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const positions = [makePosition({ shares: 100, avgPrice: 0.5, markPrice: 0.4657 })];
    const { metrics } = buildMetrics(settings, makeState(), positions, [], DAY1);

    expect(metrics.realizedPnlUsd).toBe(0);
    expect(metrics.unrealizedPnlUsd).toBeCloseTo(-3.43);
    expect(metrics.equityUsd).toBeCloseTo(96.57);
    expectAccountingInvariant(settings, metrics);
  });

  it("keeps realized P&L, cash, exposure, ROI, and bankroll risk on the same source", () => {
    const settings = makeSettings({ startingBalance: 100 });
    const positions = [makePosition({ shares: 80, avgPrice: 0.5, markPrice: 0.475 })];
    const sell = makeTrade({ side: "SELL", copyAmountUsd: 14, copiedShares: 20, realizedPnlUsd: 4 });
    const { metrics } = buildMetrics(settings, makeState(), positions, [sell], DAY1);

    expect(metrics.realizedPnlUsd).toBeCloseTo(4);
    expect(metrics.totalOpenCostBasisUsd).toBeCloseTo(40);
    expect(metrics.totalExposureUsd).toBeCloseTo(38);
    expect(metrics.unrealizedPnlUsd).toBeCloseTo(-2);
    expect(metrics.cashUsd).toBeCloseTo(64);
    expect(metrics.equityUsd).toBeCloseTo(102);
    expect(metrics.totalExposurePercent).toBeCloseTo(38 / 102);
    expectAccountingInvariant(settings, metrics);
  });
});

describe("buildMetrics accounting confidence", () => {
  it("reports high confidence with no unsafe real orders", () => {
    const settings = makeSettings({ mode: "real" });
    const { metrics } = buildMetrics(settings, makeState({ dailyDate: "2026-06-01" }), [], [], DAY1);
    expect(metrics.accountingConfidence).toBe("high");
    expect(metrics.unreconciledLiveOrders).toBe(0);
    expectAccountingInvariant(settings, metrics);
  });

  it("degrades with pending real orders and blocks with unmatched ones", () => {
    const settings = makeSettings({ mode: "real" });
    const pending = makeTrade({ mode: "real", side: "BUY", reconciliationStatus: "pending", copyAmountUsd: 5 });
    const degraded = buildMetrics(settings, makeState(), [], [pending], DAY1).metrics;
    expect(degraded.accountingConfidence).toBe("degraded");
    expect(degraded.pendingReservedUsd).toBe(5);
    expectAccountingInvariant(settings, degraded);

    const unmatched = makeTrade({ mode: "real", side: "BUY", reconciliationStatus: "unmatched", copyAmountUsd: 5 });
    const blocked = buildMetrics(settings, makeState(), [], [unmatched], DAY1).metrics;
    expect(blocked.accountingConfidence).toBe("blocked");
    expectAccountingInvariant(settings, blocked);
  });

  it("excludes unreconciled real PnL from realized PnL", () => {
    const settings = makeSettings({ mode: "real" });
    const safe = makeTrade({ mode: "simulation", realizedPnlUsd: 4 });
    const unsafe = makeTrade({ mode: "real", reconciliationStatus: "pending", realizedPnlUsd: 99 });
    const { metrics } = buildMetrics(settings, makeState(), [], [safe, unsafe], DAY1);
    expect(metrics.realizedPnlUsd).toBe(4);
    expectAccountingInvariant(settings, metrics);
  });
});

describe("daily-loss lockout", () => {
  const settings = makeSettings({ maxDailyLossPercent: 10 });

  it("latches once the daily-loss cap is breached and blocks via metrics flag", () => {
    // Start of day equity 100; a 12 USD settled loss exceeds the 10% cap.
    const state = makeState({ dailyDate: "2026-06-01", dailyStartEquityUsd: 100, peakEquityUsd: 100 });
    const lossTrade = makeTrade({ side: "SELL", copyAmountUsd: 0, copiedShares: 0, realizedPnlUsd: -12 });
    const { metrics, state: next } = buildMetrics(settings, state, [], [lossTrade], DAY1);
    expect(metrics.dailyLossLockout).toBe(true);
    expect(next.dailyLossLockout).toBe(true);
    expectAccountingInvariant(settings, metrics);
  });

  it("stays latched even if equity recovers later the same day", () => {
    const latched = makeState({ dailyDate: "2026-06-01", dailyStartEquityUsd: 100, dailyLossLockout: true });
    // No losing trades now; equity is fine, but the latch persists.
    const { metrics } = buildMetrics(settings, latched, [], [], DAY1);
    expect(metrics.dailyLossLockout).toBe(true);
    expectAccountingInvariant(settings, metrics);
  });

  it("clears at the next local day boundary", () => {
    const latched = makeState({ dailyDate: "2026-06-01", dailyStartEquityUsd: 100, dailyLossLockout: true });
    const { metrics, state: next } = buildMetrics(settings, latched, [], [], DAY2);
    expect(metrics.dailyLossLockout).toBe(false);
    expect(next.dailyDate).toBe("2026-06-02");
    expectAccountingInvariant(settings, metrics);
  });
});
