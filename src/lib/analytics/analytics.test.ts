import { describe, it, expect } from "vitest";
import { categorizeMarket, inferCorrelationKeys } from "./categorize";
import { computeDecisionScore } from "./score";
import { reasonCodeOf, buildDecisionRecord, type RecordDecisionInput } from "./recorder";
import { buildCompletedTrades } from "./lifecycle";
import { buildDashboardSummary, buildTraderAnalytics } from "./aggregate";
import type { DecisionRecord } from "./types";
import type { BotSettings, CopyTradeRecord, FollowedTrader } from "@/lib/copybot/types";
import type { Market, TraderTrade } from "@/lib/polymarket/types";
import { DEFAULT_BOT_SETTINGS } from "@/lib/copybot/defaults";

const settings: BotSettings = { ...DEFAULT_BOT_SETTINGS };

function market(over: Partial<Market> = {}): Market {
  return {
    id: "m1",
    conditionId: "cond1",
    question: "Will X happen?",
    slug: "will-x-happen",
    category: "",
    outcomes: [{ label: "Yes", tokenId: "tok1", price: 0.5 }],
    liquidity: 50_000,
    volume: 1_000_000,
    volume24hr: 100_000,
    spread: 0.02,
    bestBid: 0.49,
    bestAsk: 0.51,
    midpoint: 0.5,
    lastTradePrice: 0.5,
    startDate: null,
    endDate: null,
    timeToResolutionMs: 72 * 3_600_000,
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    image: null,
    ...over,
  };
}

function trade(over: Partial<TraderTrade> = {}): TraderTrade {
  return {
    wallet: "0xabc",
    traderName: "Leader",
    side: "BUY",
    tokenId: "tok1",
    conditionId: "cond1",
    size: 100,
    price: 0.5,
    timestamp: Math.floor(Date.now() / 1000),
    title: "Will X happen?",
    outcome: "Yes",
    txHash: "0xhash",
    ...over,
  };
}

function copyRecord(over: Partial<CopyTradeRecord> = {}): CopyTradeRecord {
  return {
    id: "rec1",
    sourceTradeId: "src1",
    status: "simulated",
    mode: "simulation",
    traderWallet: "0xabc",
    traderName: "Leader",
    side: "BUY",
    tokenId: "tok1",
    conditionId: "cond1",
    marketSlug: "will-x-happen",
    marketTitle: "Will X happen?",
    outcome: "Yes",
    price: 0.5,
    sourceSize: 100,
    sourceAmountUsd: 50,
    copyAmountUsd: 10,
    copiedShares: 20,
    realizedPnlUsd: 0,
    reason: "Simulated BUY",
    txOrOrderId: "0xhash",
    sourceTimestamp: Date.now(),
    processedAt: Date.now(),
    ...over,
  };
}

describe("categorizeMarket", () => {
  it("uses Gamma category when present", () => {
    expect(categorizeMarket(market({ category: "Sports" }))).toBe("sports");
    expect(categorizeMarket(market({ category: "Crypto" }))).toBe("crypto");
  });

  it("falls back to keyword heuristics", () => {
    expect(categorizeMarket(market({ question: "Will Bitcoin hit $100k?" }))).toBe("crypto");
    expect(categorizeMarket(market({ question: "2024 presidential election winner" }))).toBe("politics");
    expect(categorizeMarket(market({ question: "Lakers vs Celtics — who wins the game?" }))).toBe("sports");
    expect(categorizeMarket(market({ question: "Random unmatched question" }))).toBe("other");
  });
});

describe("inferCorrelationKeys", () => {
  it("extracts match, league, election, and date keys", () => {
    const keys = inferCorrelationKeys(
      "NFL: Eagles vs Cowboys game winner",
      "cond1",
      "2026-01-15T00:00:00Z",
    );
    expect(keys.league).toBe("nfl");
    expect(keys.match).toContain("cowboys");
    expect(keys.match).toContain("eagles");
    expect(keys.resolutionDate).toBe("2026-01-15");
  });
});

describe("computeDecisionScore", () => {
  it("returns a 0..100 total with all components present", () => {
    const score = computeDecisionScore({
      settings,
      traderCopyScore: 80,
      traderWeeklyPnlUsd: 1000,
      liquidityUsd: 100_000,
      spread: 0.01,
      tradeAgeSec: 5,
      slippageCents: 0,
      price: 0.5,
      volumeUsd: 1_000_000,
      timeToResolutionMs: 72 * 3_600_000,
      marketExposureBeforeUsd: 0,
      equityUsd: 1000,
    });
    expect(score.total).toBeGreaterThan(0);
    expect(score.total).toBeLessThanOrEqual(100);
    for (const v of Object.values(score.components)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("penalizes stale, wide-spread, illiquid trades", () => {
    const good = computeDecisionScore({
      settings, traderCopyScore: 90, traderWeeklyPnlUsd: null, liquidityUsd: 200_000, spread: 0.005,
      tradeAgeSec: 2, slippageCents: 0, price: 0.5, volumeUsd: 5_000_000, timeToResolutionMs: 100 * 3_600_000,
      marketExposureBeforeUsd: 0, equityUsd: 1000,
    });
    const bad = computeDecisionScore({
      settings, traderCopyScore: 20, traderWeeklyPnlUsd: null, liquidityUsd: 200, spread: 0.09,
      tradeAgeSec: settings.maxTradeAgeSec, slippageCents: 4, price: 0.97, volumeUsd: 500, timeToResolutionMs: 30 * 60_000,
      marketExposureBeforeUsd: 500, equityUsd: 1000,
    });
    expect(good.total).toBeGreaterThan(bad.total);
  });
});

describe("reasonCodeOf", () => {
  it("buckets common skip reasons", () => {
    expect(reasonCodeOf("Skipped stale trade from X: 90s old")).toBe("stale");
    expect(reasonCodeOf("Skipped BUY: market spread 12c exceeds max")).toBe("spread");
    expect(reasonCodeOf("Skipped BUY: total exposure cap 50% would be exceeded")).toBe("cap-total");
    expect(reasonCodeOf("Skipped BUY: panic stop is engaged")).toBe("panic");
    expect(reasonCodeOf("Simulated BUY 10 USD")).toBe("other");
  });
});

describe("buildDecisionRecord", () => {
  const trader: FollowedTrader = {
    wallet: "0xabc", name: "Leader", enabled: true, source: "auto", rank: 1,
    weeklyPnlUsd: 5000, weeklyVolumeUsd: 100000, weeklyTradeCount: 50, copiedTradeCount: 10,
    copiedSimPnlUsd: 100, lastTradeAt: Date.now(), addedAt: Date.now(), updatedAt: Date.now(),
    copyScore: { wallet: "0xabc", copiedBuys: 5, copiedSells: 3, filledCopies: 8, skippedCount: 2, skipRatio: 0.2,
      realizedPnlUsd: 50, unrealizedPnlUsd: 10, investedUsd: 200, copyRoi: 0.3, avgSlippageBps: 5,
      highPriceEntryCount: 0, lowLiquidityEntryCount: 0, openPositionCount: 1, score: 75,
      autoDisableReason: null, reviewReason: null },
  };

  it("captures full context and derives a score for a filled BUY", () => {
    const input: RecordDecisionInput = {
      record: copyRecord({ leaderPrice: 0.5, botExecPrice: 0.51, adverseMoveCents: 1, effectivePrice: 0.51, feeUsd: 0.05 }),
      trade: trade(),
      settings, state: {} as never, trader, market: market(),
      capture: { tradeAgeSec: 5, exposureBeforeUsd: 0, marketExposureBeforeUsd: 0, availableCashUsd: 1000,
        equityUsd: 1000, requestedAmountUsd: 10, perMarketCapUsd: 100, totalCapUsd: 500, dailyPnlUsd: 0, liveBalanceUsd: null },
      positionsAfter: [],
    };
    const d = buildDecisionRecord(input);
    expect(d.action).toBe("BUY");
    expect(d.tokenId).toBe("tok1");
    expect(d.market.category).toBe("other");
    expect(d.trader.ourCopyRoi).toBe(0.3);
    expect(d.trader.copyScore).toBe(75);
    expect(d.slippageCents).toBe(1);
    expect(d.score.total).toBeGreaterThan(0);
    expect(d.reasonCode).toBe("other");
  });

  it("marks skips with action SKIP", () => {
    const input: RecordDecisionInput = {
      record: copyRecord({ status: "skipped", reason: "Skipped stale trade from Leader: 90s old (max 60s)." }),
      trade: trade(), settings, state: {} as never, trader: null, market: market(),
      capture: {}, positionsAfter: [],
    };
    const d = buildDecisionRecord(input);
    expect(d.action).toBe("SKIP");
    expect(d.reasonCode).toBe("stale");
  });
});

describe("buildCompletedTrades", () => {
  it("pairs filled BUY and SELL decisions into round trips", async () => {
    const base: Partial<DecisionRecord> = {
      mode: "simulation", status: "simulated", tokenId: "tok1",
      market: { conditionId: "cond1", tokenId: "tok1", title: "X", slug: "x", category: "crypto", outcome: "Yes",
        liquidityUsd: 1, volumeUsd: 1, volume24hrUsd: 1, spread: 0.01, bid: 0.5, ask: 0.51, midpoint: 0.5,
        impliedProbability: 0.5, timeToResolutionMs: 1, resolvesAt: null },
      copiedWallet: "0xabc",
    };
    const buy = { ...base, id: "d1", ts: 1000, action: "BUY", side: "BUY", copiedShares: 100, effectivePrice: 0.40, ourFillPrice: 0.40, slippageCents: 0 } as DecisionRecord;
    const sell = { ...base, id: "d2", ts: 2000, action: "SELL", side: "SELL", copiedShares: 100, effectivePrice: 0.60, ourFillPrice: 0.60, copyAmountUsd: 60 } as DecisionRecord;

    const completed = await buildCompletedTrades([buy, sell]);
    expect(completed).toHaveLength(1);
    expect(completed[0].entryPrice).toBeCloseTo(0.40);
    expect(completed[0].exitPrice).toBeCloseTo(0.60);
    expect(completed[0].realizedPnlUsd).toBeCloseTo(20);
    expect(completed[0].roi).toBeCloseTo(0.5);
    expect(completed[0].holdMs).toBe(1000);
  });
});

describe("buildCompletedTrades with bot-autonomous exits", () => {
  it("closes a round trip when the exit comes from the exits stream (auto-exit, not a leader copy-sell)", async () => {
    const base: Partial<DecisionRecord> = {
      mode: "real", status: "copied", tokenId: "tok1", copiedWallet: "0xabc",
      market: { conditionId: "cond1", tokenId: "tok1", title: "X", slug: "x", category: "crypto", outcome: "Yes",
        liquidityUsd: 1, volumeUsd: 1, volume24hrUsd: 1, spread: 0.01, bid: 0.5, ask: 0.51, midpoint: 0.5,
        impliedProbability: 0.5, timeToResolutionMs: 1, resolvesAt: null },
    };
    const buy = { ...base, id: "d1", ts: 1000, action: "BUY", side: "BUY", copiedShares: 100, effectivePrice: 0.40, ourFillPrice: 0.40 } as DecisionRecord;
    // Exit lives only in the exits stream (e.g. a take-profit auto-exit).
    const exit = { ...base, id: "x1", ts: 5000, action: "SELL", side: "SELL", copiedShares: 100, effectivePrice: 0.55, ourFillPrice: 0.55, copyAmountUsd: 55, exitSource: "auto-exit" } as DecisionRecord;

    // Decision log alone (no exit) leaves the trade open...
    expect(await buildCompletedTrades([buy], [])).toHaveLength(0);
    // ...merging the exits stream closes it.
    const completed = await buildCompletedTrades([buy], [exit]);
    expect(completed).toHaveLength(1);
    expect(completed[0].realizedPnlUsd).toBeCloseTo(15);
    expect(completed[0].holdMs).toBe(4000);
  });
});

describe("buildDashboardSummary", () => {
  it("aggregates totals, performance, and skip reasons", () => {
    const decisions: DecisionRecord[] = [
      { id: "a", action: "BUY", side: "BUY", status: "simulated", reasonCode: "other", tokenId: "tok1",
        copiedWallet: "0xabc", score: { total: 80 } } as DecisionRecord,
      { id: "b", action: "SKIP", side: "BUY", status: "skipped", reasonCode: "stale", tokenId: "tok2",
        copiedWallet: "0xabc", score: { total: 30 } } as DecisionRecord,
    ];
    const completed = [
      { tokenId: "tok1", realizedPnlUsd: 20, costBasisUsd: 40, roi: 0.5, holdMs: 1000, exitTs: 2000,
        category: "crypto", copiedWallet: "0xabc" } as never,
    ];
    const summary = buildDashboardSummary({ decisions, completed, missed: [] });
    expect(summary.totals.buys).toBe(1);
    expect(summary.totals.skips).toBe(1);
    expect(summary.performance.cumulativeRealizedPnlUsd).toBe(20);
    expect(summary.performance.winRate).toBe(1);
    expect(summary.skipReasons.find((s) => s.reasonCode === "stale")?.count).toBe(1);
  });
});

describe("buildTraderAnalytics", () => {
  it("computes per-trader win rate and ROI", () => {
    const decisions: DecisionRecord[] = [
      { copiedWallet: "0xabc", side: "BUY", status: "simulated", copyAmountUsd: 40, slippageCents: 1,
        trader: { name: "Leader" } } as DecisionRecord,
    ];
    const completed = [
      { copiedWallet: "0xabc", realizedPnlUsd: 20, costBasisUsd: 40, roi: 0.5, holdMs: 1000, exitTs: Date.now(), category: "crypto" } as never,
    ];
    const analytics = buildTraderAnalytics(decisions, completed);
    expect(analytics).toHaveLength(1);
    expect(analytics[0].winRate).toBe(1);
    expect(analytics[0].realizedCopyRoi).toBeCloseTo(0.5);
  });
});
