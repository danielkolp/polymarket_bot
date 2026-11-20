import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMetrics, realizedPnlFromTrades } from "./accounting";
import { heldOppositeOutcome } from "./bot";
import { bumpToExchangeMinimum, copySellShares, leaderSellFraction } from "./copySizing";
import {
  candidateMetrics,
  cheapRejectReason,
  statsRejectReason,
  type CandidateProfile,
} from "./discovery";
import { evaluateAutoExit, withUpdatedPeak } from "./exitRules";
import { compactTrades, isCarryRecord } from "./ledgerCompaction";
import { makePosition, makeSettings, makeState, makeTrade } from "./testFixtures";
import { displayName } from "@/lib/polymarket/dataApi";
import { normalizePositionV2 } from "@/lib/polymarket/positions";
import { normalizeTradeV2 } from "@/lib/polymarket/traderTrades";
import type { TraderTrade } from "@/lib/polymarket/types";

const NOW = Date.UTC(2026, 10, 20, 12);
const WALLET = "0x" + "a".repeat(40);

describe("ledger compaction", () => {
  it("preserves total realized P&L exactly while bounding the ledger", () => {
    const trades = [];
    for (let i = 0; i < 60; i++) {
      trades.push(makeTrade({ status: "simulated", side: "SELL", realizedPnlUsd: i % 3 === 0 ? -1.25 : 0.75, processedAt: NOW - i }));
      trades.push(makeTrade({ status: "skipped", processedAt: NOW - i }));
    }
    const before = realizedPnlFromTrades(trades);
    const compacted = compactTrades(trades, { maxFilled: 10, maxOther: 5 });
    expect(realizedPnlFromTrades(compacted)).toBeCloseTo(before, 9);
    expect(compacted.filter((t) => t.status === "skipped")).toHaveLength(5);
    expect(compacted.filter(isCarryRecord)).toHaveLength(1);
    expect(compacted.length).toBeLessThanOrEqual(10 + 5 + 1);
  });

  it("never folds live orders that are still pending reconciliation", () => {
    const pending = makeTrade({ mode: "real", status: "copied", reconciliationStatus: "pending", processedAt: NOW - 1000 });
    const filled = Array.from({ length: 20 }, (_, i) => makeTrade({ status: "simulated", realizedPnlUsd: 1, processedAt: NOW - i }));
    const compacted = compactTrades([...filled, pending], { maxFilled: 5, maxOther: 5 });
    expect(compacted).toContain(pending);
  });

  it("is a no-op within limits and re-folds into an existing carry", () => {
    const small = [makeTrade({ status: "simulated", realizedPnlUsd: 2 })];
    expect(compactTrades(small)).toBe(small);
    const first = compactTrades(
      Array.from({ length: 8 }, () => makeTrade({ status: "simulated", realizedPnlUsd: 1 })),
      { maxFilled: 3, maxOther: 1 },
    );
    const second = compactTrades(
      [...Array.from({ length: 5 }, () => makeTrade({ status: "simulated", realizedPnlUsd: 1 })), ...first],
      { maxFilled: 3, maxOther: 1 },
    );
    expect(realizedPnlFromTrades(second)).toBeCloseTo(13, 9);
    expect(second.filter(isCarryRecord)).toHaveLength(1);
  });

  it("keeps equity unchanged and excludes carries from win stats", () => {
    const settings = makeSettings({ startingBalance: 50 });
    const trades = Array.from({ length: 30 }, (_, i) =>
      makeTrade({ status: "simulated", side: "SELL", realizedPnlUsd: i % 2 ? 1 : -0.5, processedAt: NOW - i }),
    );
    const before = buildMetrics(settings, makeState(), [], trades, NOW).metrics;
    const after = buildMetrics(settings, makeState(), [], compactTrades(trades, { maxFilled: 4, maxOther: 1 }), NOW).metrics;
    expect(after.equityUsd).toBeCloseTo(before.equityUsd, 9);
    expect(after.winners + after.losers).toBe(4);
  });
});

describe("exit rules", () => {
  const base = { autoExitTakeProfitPercent: 0, autoExitStopLossPercent: 0, autoExitMaxHoldMinutes: 0, autoExitTrailingStopPercent: 0 };

  it("fires take-profit, stop-loss and max-hold", () => {
    expect(evaluateAutoExit(makePosition({ avgPrice: 0.4, markPrice: 0.6 }), { ...base, autoExitTakeProfitPercent: 40 }, NOW)).toMatch(/take-profit/);
    expect(evaluateAutoExit(makePosition({ avgPrice: 0.5, markPrice: 0.35 }), { ...base, autoExitStopLossPercent: 25 }, NOW)).toMatch(/stop-loss/);
    expect(
      evaluateAutoExit(makePosition({ openedAt: NOW - 3 * 3600_000 }), { ...base, autoExitMaxHoldMinutes: 120 }, NOW),
    ).toMatch(/max-hold/);
    expect(evaluateAutoExit(makePosition(), base, NOW)).toBeNull();
  });

  it("trailing stop arms only after the position traded above entry", () => {
    const trail = { ...base, autoExitTrailingStopPercent: 20 };
    // Never in profit: a 30% drawdown is the stop-loss's job, not the trail's.
    expect(evaluateAutoExit(makePosition({ avgPrice: 0.5, markPrice: 0.35, peakMarkPrice: 0.5 }), trail, NOW)).toBeNull();
    // Ran to 0.80, now 0.60 = 25% giveback from peak -> exit.
    expect(evaluateAutoExit(makePosition({ avgPrice: 0.5, markPrice: 0.6, peakMarkPrice: 0.8 }), trail, NOW)).toMatch(/trailing-stop/);
    // 10% giveback -> hold.
    expect(evaluateAutoExit(makePosition({ avgPrice: 0.5, markPrice: 0.72, peakMarkPrice: 0.8 }), trail, NOW)).toBeNull();
  });

  it("tracks the running peak mark", () => {
    const p = withUpdatedPeak(makePosition({ avgPrice: 0.5, markPrice: 0.7, peakMarkPrice: 0.6 }));
    expect(p.peakMarkPrice).toBe(0.7);
    expect(withUpdatedPeak({ ...p, markPrice: 0.65 }).peakMarkPrice).toBe(0.7);
  });
});

describe("copy sizing", () => {
  it("mirrors the fraction of their position the leader sold", () => {
    expect(leaderSellFraction(25, 75)).toBeCloseTo(0.25);
    expect(leaderSellFraction(100, 0)).toBe(1);
    expect(leaderSellFraction(10, null)).toBeNull();
    expect(leaderSellFraction(0, 10)).toBeNull();
  });

  it("sells everything on a near-full or unknown exit, or when the remainder is dust", () => {
    expect(copySellShares({ heldShares: 10, fraction: 0.25, price: 0.6, minRemainderUsd: 1 })).toEqual({ shares: 2.5, full: false });
    expect(copySellShares({ heldShares: 10, fraction: 0.95, price: 0.6, minRemainderUsd: 1 }).full).toBe(true);
    expect(copySellShares({ heldShares: 10, fraction: null, price: 0.6, minRemainderUsd: 1 }).full).toBe(true);
    // 2 shares left @ 0.30 = $0.60 < $1 -> sell all.
    expect(copySellShares({ heldShares: 4, fraction: 0.5, price: 0.3, minRemainderUsd: 1 })).toEqual({ shares: 4, full: true });
  });

  it("bumps small BUYs to the $1 exchange minimum but never inflates zero", () => {
    expect(bumpToExchangeMinimum(0.62, 1)).toEqual({ amountUsd: 1, bumped: true });
    expect(bumpToExchangeMinimum(1.25, 1)).toEqual({ amountUsd: 1.25, bumped: false });
    expect(bumpToExchangeMinimum(0, 1)).toEqual({ amountUsd: 0, bumped: false });
  });

  it("detects a held opposite outcome in the same market", () => {
    const positions = [makePosition({ tokenId: "yes", conditionId: "c1", outcome: "Yes" })];
    expect(heldOppositeOutcome(positions, { conditionId: "c1", tokenId: "no" })?.outcome).toBe("Yes");
    expect(heldOppositeOutcome(positions, { conditionId: "c1", tokenId: "yes" })).toBeNull();
    expect(heldOppositeOutcome(positions, { conditionId: "c2", tokenId: "no" })).toBeNull();
  });
});

function trade(overrides: Partial<TraderTrade>): TraderTrade {
  return {
    wallet: WALLET,
    traderName: "t",
    side: "BUY",
    tokenId: "tok",
    conditionId: "c",
    size: 100,
    price: 0.5,
    timestamp: Math.floor(NOW / 1000) - 3600,
    title: "Will X happen?",
    outcome: "Yes",
    txHash: "0x",
    ...overrides,
  };
}

describe("discovery filters", () => {
  const settings = makeSettings();
  const profile = (overrides: Partial<CandidateProfile> = {}): CandidateProfile => ({
    wallet: WALLET,
    name: "w",
    week: { wallet: WALLET, name: "w", amount: 1000, rank: 5, pnlUsd: 1000, volume: 20000 },
    month: { wallet: WALLET, name: "w", amount: 3000, rank: 9, pnlUsd: 3000, volume: 60000 },
    trades: Array.from({ length: 20 }, (_, i) => trade({ timestamp: Math.floor(NOW / 1000) - i * 3600 })),
    stats: null,
    ...overrides,
  });

  it("accepts a consistent, human-paced, copyable trader", () => {
    const p = profile();
    const m = candidateMetrics(p, settings, NOW);
    expect(m.consistency).toBe(1);
    expect(m.efficiency).toBeCloseTo(0.05);
    expect(cheapRejectReason(p, m, settings, NOW)).toBeNull();
  });

  it("rejects HFT bots, fast-market traders, and uncopyable price profiles", () => {
    const hft = profile({ trades: Array.from({ length: 100 }, (_, i) => trade({ timestamp: Math.floor(NOW / 1000) - i * 60 })) });
    expect(cheapRejectReason(hft, candidateMetrics(hft, settings, NOW), settings, NOW)).toMatch(/HFT/);

    const fast = profile({ trades: Array.from({ length: 20 }, (_, i) => trade({ slug: "btc-updown-5m-1", timestamp: Math.floor(NOW / 1000) - i * 3600 })) });
    expect(cheapRejectReason(fast, candidateMetrics(fast, settings, NOW), settings, NOW)).toMatch(/crypto/);

    const pennies = profile({ trades: Array.from({ length: 20 }, (_, i) => trade({ price: 0.97, timestamp: Math.floor(NOW / 1000) - i * 3600 })) });
    expect(cheapRejectReason(pennies, candidateMetrics(pennies, settings, NOW), settings, NOW)).toMatch(/price band/);

    const loser = profile({ month: { wallet: WALLET, name: "w", amount: -50, rank: 9, pnlUsd: -50, volume: 1000 } });
    expect(cheapRejectReason(loser, candidateMetrics(loser, settings, NOW), settings, NOW)).toMatch(/30d/);
  });

  it("rejects market makers, lifetime losers, bots and unrealized one-hit wonders", () => {
    const stats = {
      wallet: WALLET,
      trades: 300,
      joinDate: Math.floor(NOW / 1000) - 365 * 86400,
      realizedPnlUsd: 100_000,
      unrealizedPnlUsd: 0,
      makerRebateUsd: 0,
      takerRebateUsd: 0,
      rewardIncomeUsd: 0,
    };
    expect(statsRejectReason(stats, NOW)).toBeNull();
    expect(statsRejectReason({ ...stats, makerRebateUsd: 20_000, takerRebateUsd: 15_000 }, NOW)).toMatch(/market maker/);
    expect(statsRejectReason({ ...stats, realizedPnlUsd: -5 }, NOW)).toMatch(/not positive/);
    expect(statsRejectReason({ ...stats, trades: 200_000 }, NOW)).toMatch(/bot/);
    expect(statsRejectReason({ ...stats, realizedPnlUsd: 16_000 }, NOW, 1_500_000)).toMatch(/unrealized/);
    expect(statsRejectReason(null, NOW)).toBeNull();
  });
});

describe("Data API v2 normalizers", () => {
  it("normalizes a v2 trade row", () => {
    const t = normalizeTradeV2({
      proxy_wallet: "0xABCDEF0000000000000000000000000000000001",
      side: "SELL",
      token_id: "123",
      condition_id: "0xc",
      size: "2.5",
      price: 0.43,
      timestamp: 1795150679,
      slug: "btc-updown-5m",
      event_slug: "ev",
      outcome: "Up",
      outcome_index: 999,
      name: "0xABCDEF0000000000000000000000000000000001-1781790657712",
      pseudonym: "Alive-Heroine",
      transaction_hash: "0xhash",
    });
    expect(t).toMatchObject({
      wallet: "0xabcdef0000000000000000000000000000000001",
      side: "SELL",
      tokenId: "123",
      size: 2.5,
      traderName: "Alive-Heroine",
      eventSlug: "ev",
      outcomeIndex: undefined,
    });
    expect(normalizeTradeV2({ side: "BUY" })).toBeNull();
  });

  it("normalizes a v2 position row", () => {
    const p = normalizePositionV2({
      proxy_wallet: "0xW",
      token_id: "t",
      condition_id: "c",
      current_size: 223.5,
      avg_price: 0.679,
      current_price: 0.775,
      entry_cost_usdc: 151.5,
      current_value: 172.9,
      unrealized_pnl: 21.4,
      status: "REDEEMABLE",
      negative_risk: true,
      end_date: "2026-10-28",
    });
    expect(p).toMatchObject({ size: 223.5, avgPrice: 0.679, curPrice: 0.775, redeemable: true, negativeRisk: true, endDate: "2026-10-28" });
  });

  it("ignores the auto-generated address-timestamp display name", () => {
    expect(displayName("0x2c335066fe58fe9237c3d3dc7b275c2a034a0563", null, "0x2c335066FE58fe9237c3d3Dc7b275C2a034a0563-1759935795465")).toBe("0x2c33…0563");
    expect(displayName("0xabc", null, "DrSlips")).toBe("DrSlips");
  });
});

describe("Gamma resolved-market lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to closed=true so resolved markets still settle", async () => {
    const { fetchMarketById, clearMarketCache } = await import("@/lib/polymarket/gamma");
    clearMarketCache();
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        const closed = url.includes("closed=true");
        const body = closed
          ? [{ id: "1", conditionId: "c", question: "Q", closed: true, active: true, outcomes: '["Yes","No"]', outcomePrices: '["0","1"]', clobTokenIds: '["tokA","tokB"]' }]
          : [];
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      }),
    );
    const market = await fetchMarketById("tokA");
    expect(urls).toHaveLength(2);
    expect(market?.closed).toBe(true);
    expect(market?.outcomes.find((o) => o.tokenId === "tokA")?.price).toBe(0);
    // Cached: no extra request.
    await fetchMarketById("tokA");
    expect(urls).toHaveLength(2);
  });
});
