import { describe, expect, it } from "vitest";
import { evaluateBuyReadiness } from "./liveReadiness";
import type { LivePositionReconciliation } from "./types";
import { makeSettings, makeState, makeTrade } from "./testFixtures";

const NOW = Date.UTC(2026, 5, 1, 12);

function healthyLivePositions(overrides: Partial<LivePositionReconciliation> = {}): LivePositionReconciliation {
  return {
    fetchedAt: NOW,
    ok: true,
    error: null,
    entries: [],
    totalLiveExposureUsd: 0,
    unattributedExposureUsd: 0,
    unknownPositionCount: 0,
    stalePositionCount: 0,
    redeemableCount: 0,
    ...overrides,
  };
}

describe("evaluateBuyReadiness — universal gates", () => {
  it("blocks BUYs when panic is engaged (any mode)", () => {
    const r = evaluateBuyReadiness({
      settings: makeSettings({ mode: "simulation" }),
      state: makeState({ panic: true, panicReason: "stop" }),
      trades: [],
      livePositions: null,
      now: NOW,
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("panic");
  });

  it("blocks BUYs under daily-loss lockout", () => {
    const r = evaluateBuyReadiness({
      settings: makeSettings({ mode: "simulation" }),
      state: makeState({ dailyLossLockout: true }),
      trades: [],
      livePositions: null,
      now: NOW,
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("daily-loss-lockout");
  });

  it("blocks BUYs when the daily-loss cap is zero", () => {
    const r = evaluateBuyReadiness({
      settings: makeSettings({ mode: "simulation", maxDailyLossPercent: 0 }),
      state: makeState(),
      trades: [],
      livePositions: null,
      now: NOW,
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("daily-loss-cap-configured");
  });
  it("allows BUYs in a clean simulation", () => {
    const r = evaluateBuyReadiness({
      settings: makeSettings({ mode: "simulation" }),
      state: makeState(),
      trades: [],
      livePositions: null,
      now: NOW,
    });
    expect(r.buysAllowed).toBe(true);
    expect(r.blockers).toHaveLength(0);
  });
});

describe("evaluateBuyReadiness — real-mode live state", () => {
  const settings = makeSettings({ mode: "real" });

  it("blocks when live positions have not been fetched", () => {
    const r = evaluateBuyReadiness({ settings, state: makeState(), trades: [], livePositions: null, now: NOW });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("live-positions-fetched");
  });

  it("passes with healthy fresh live positions and no live orders", () => {
    const r = evaluateBuyReadiness({
      settings,
      state: makeState(),
      trades: [],
      livePositions: healthyLivePositions(),
      now: NOW,
    });
    expect(r.buysAllowed).toBe(true);
  });

  it("blocks on unmatched/errored live orders", () => {
    const unmatched = makeTrade({ mode: "real", status: "copied", reconciliationStatus: "unmatched" });
    const r = evaluateBuyReadiness({
      settings,
      state: makeState(),
      trades: [unmatched],
      livePositions: healthyLivePositions(),
      now: NOW,
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("reconciliation-clean");
  });

  it("blocks on a stale pending BUY older than the staleness window", () => {
    const pending = makeTrade({
      mode: "real",
      status: "copied",
      side: "BUY",
      reconciliationStatus: "pending",
      processedAt: NOW - 120_000,
    });
    const r = evaluateBuyReadiness({
      settings,
      state: makeState(),
      trades: [pending],
      livePositions: healthyLivePositions(),
      now: NOW,
      thresholds: { pendingStaleSeconds: 60 },
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("no-stale-pending");
  });

  it("blocks on unknown existing live positions", () => {
    const r = evaluateBuyReadiness({
      settings,
      state: makeState(),
      trades: [],
      livePositions: healthyLivePositions({ unknownPositionCount: 1 }),
      now: NOW,
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("no-unknown-positions");
  });

  it("blocks on a stale live-position snapshot", () => {
    const r = evaluateBuyReadiness({
      settings,
      state: makeState(),
      trades: [],
      livePositions: healthyLivePositions({ fetchedAt: NOW - 10 * 60_000 }),
      now: NOW,
      thresholds: { livePositionsStaleSeconds: 120 },
    });
    expect(r.buysAllowed).toBe(false);
    expect(r.blockers.map((b) => b.code)).toContain("live-positions-fresh");
  });

  it("does not flag redeemable positions as a warning or a block (Polymarket auto-redeems)", () => {
    const r = evaluateBuyReadiness({
      settings,
      state: makeState(),
      trades: [],
      livePositions: healthyLivePositions({ redeemableCount: 2 }),
      now: NOW,
    });
    expect(r.buysAllowed).toBe(true);
    expect(r.blockers.map((b) => b.code)).not.toContain("redeemable-positions");
    expect(r.warnings.map((w) => w.code)).not.toContain("redeemable-positions");
    const g = r.gates.find((x) => x.code === "redeemable-positions");
    expect(g?.ok).toBe(true);
    expect(g?.detail).toMatch(/auto-redeem/i);
  });
});
