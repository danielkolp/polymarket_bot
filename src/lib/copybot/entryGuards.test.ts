import { describe, expect, it } from "vitest";
import { currentExecutableAsk, effectiveMaxCopyAgeSec, evaluateAdverseEntry } from "./entryGuards";
import { makeSettings } from "./testFixtures";
import type { Market, TraderTrade } from "@/lib/polymarket/types";

function market(overrides: Partial<Market> = {}): Market {
  return {
    id: "m",
    conditionId: "c",
    question: "q",
    slug: "s",
    category: "",
    outcomes: [],
    liquidity: 1000,
    volume: 0,
    volume24hr: 0,
    spread: 0.02,
    bestBid: 0.39,
    bestAsk: 0.41,
    midpoint: 0.4,
    lastTradePrice: 0.4,
    startDate: null,
    endDate: null,
    timeToResolutionMs: 1_000_000_000,
    active: true,
    closed: false,
    acceptingOrders: true,
    enableOrderBook: true,
    image: null,
    ...overrides,
  };
}

function buy(price: number): Pick<TraderTrade, "price"> {
  return { price };
}

describe("evaluateAdverseEntry", () => {
  it("skips a BUY when the current ask is more than the cap above the leader price", () => {
    const r = evaluateAdverseEntry(makeSettings({ maxAdverseEntryMoveCents: 2 }), buy(0.4), market({ bestAsk: 0.47 }));
    expect(r.reason).toMatch(/current ask 47\.0c is 7\.0c worse than leader fill 40\.0c \(max 2\.0c\)/i);
    expect(r.leaderPrice).toBeCloseTo(0.4);
    expect(r.botExecPrice).toBeCloseTo(0.47);
    expect(r.adverseMoveCents).toBeCloseTo(7, 6);
  });

  it("allows a BUY when the current ask is within the adverse-move limit", () => {
    const r = evaluateAdverseEntry(makeSettings({ maxAdverseEntryMoveCents: 2 }), buy(0.4), market({ bestAsk: 0.415 }));
    expect(r.reason).toBeNull();
    expect(r.adverseMoveCents).toBeCloseTo(1.5, 6);
  });

  it("allows a BUY at a price better than the leader (negative adverse move)", () => {
    const r = evaluateAdverseEntry(makeSettings({ maxAdverseEntryMoveCents: 2 }), buy(0.4), market({ bestAsk: 0.38 }));
    expect(r.reason).toBeNull();
    expect(r.adverseMoveCents).toBeCloseTo(-2, 6);
  });

  it("does not trip on a missing/invalid current price (other gates handle that)", () => {
    const r = evaluateAdverseEntry(
      makeSettings({ maxAdverseEntryMoveCents: 2 }),
      buy(0.4),
      market({ bestAsk: null, midpoint: null }),
    );
    expect(r.reason).toBeNull();
    expect(r.botExecPrice).toBeNull();
    expect(r.adverseMoveCents).toBeNull();
  });

  it("does not trip on a missing/invalid leader price", () => {
    const r = evaluateAdverseEntry(makeSettings({ maxAdverseEntryMoveCents: 2 }), buy(0), market({ bestAsk: 0.9 }));
    expect(r.reason).toBeNull();
    expect(r.leaderPrice).toBeNull();
  });

  it("is disabled when the cap is zero", () => {
    const r = evaluateAdverseEntry(makeSettings({ maxAdverseEntryMoveCents: 0 }), buy(0.4), market({ bestAsk: 0.95 }));
    expect(r.reason).toBeNull();
  });

  it("falls back to midpoint when best ask is unavailable", () => {
    expect(currentExecutableAsk(market({ bestAsk: null, midpoint: 0.55 }))).toBeCloseTo(0.55);
    expect(currentExecutableAsk(market({ bestAsk: 0.6, midpoint: 0.55 }))).toBeCloseTo(0.6);
    expect(currentExecutableAsk(null)).toBeNull();
  });
});

describe("effectiveMaxCopyAgeSec", () => {
  it("uses the looser maxTradeAgeSec (capped at 5 min) in simulation", () => {
    const s = makeSettings({ mode: "simulation", maxTradeAgeSec: 300, liveMaxCopyTradeAgeSec: 60 });
    expect(effectiveMaxCopyAgeSec(s, "BUY")).toBe(300);
    expect(effectiveMaxCopyAgeSec(s, "SELL")).toBe(300);
  });

  it("uses the stricter live freshness window for real-mode BUYs", () => {
    const s = makeSettings({ mode: "real", maxTradeAgeSec: 300, liveMaxCopyTradeAgeSec: 60 });
    expect(effectiveMaxCopyAgeSec(s, "BUY")).toBe(60);
  });

  it("keeps the looser window for real-mode SELLs so leader exits can still be reacted to", () => {
    const s = makeSettings({ mode: "real", maxTradeAgeSec: 300, liveMaxCopyTradeAgeSec: 60 });
    expect(effectiveMaxCopyAgeSec(s, "SELL")).toBe(300);
  });

  it("never exceeds the hard 5-minute absolute cap", () => {
    const s = makeSettings({ mode: "simulation", maxTradeAgeSec: 86400, liveMaxCopyTradeAgeSec: 60 });
    expect(effectiveMaxCopyAgeSec(s, "BUY")).toBe(300);
  });
});
