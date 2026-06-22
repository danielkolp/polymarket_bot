import { describe, expect, it } from "vitest";
import { marketSettlementValue } from "./bot";
import type { Market } from "@/lib/polymarket/types";

function makeMarket(overrides: Partial<Market> = {}): Market {
  return {
    id: "m1",
    conditionId: "cond1",
    question: "Will it?",
    slug: "will-it",
    category: "Test",
    outcomes: [
      { label: "Yes", tokenId: "yes", price: 1 },
      { label: "No", tokenId: "no", price: 0 },
    ],
    liquidity: 0,
    volume: 0,
    volume24hr: 0,
    spread: 0,
    bestBid: null,
    bestAsk: null,
    midpoint: null,
    lastTradePrice: null,
    startDate: null,
    endDate: null,
    timeToResolutionMs: null,
    active: false,
    closed: true,
    acceptingOrders: false,
    enableOrderBook: false,
    image: null,
    ...overrides,
  };
}

describe("marketSettlementValue", () => {
  it("pays $1 for the winning outcome of a closed market", () => {
    expect(marketSettlementValue(makeMarket(), "yes")).toBe(1);
  });

  it("pays $0 for the losing outcome of a closed market", () => {
    expect(marketSettlementValue(makeMarket(), "no")).toBe(0);
  });

  it("returns null when the market is not closed (still tradable)", () => {
    const open = makeMarket({ closed: false, active: true, acceptingOrders: true });
    expect(marketSettlementValue(open, "yes")).toBeNull();
  });

  it("does NOT settle a merely paused market (not accepting orders but not closed)", () => {
    // closed === false is the key guard: a halted-but-unresolved market must not
    // crystallize a loss against the position.
    const paused = makeMarket({ closed: false, active: true, acceptingOrders: false });
    expect(marketSettlementValue(paused, "no")).toBeNull();
  });

  it("returns null for an ambiguous (non-binary) outcome price on a closed market", () => {
    const ambiguous = makeMarket({
      outcomes: [
        { label: "Yes", tokenId: "yes", price: 0.5 },
        { label: "No", tokenId: "no", price: 0.5 },
      ],
    });
    expect(marketSettlementValue(ambiguous, "yes")).toBeNull();
  });

  it("returns null when the token is not one of the market's outcomes", () => {
    expect(marketSettlementValue(makeMarket(), "missing")).toBeNull();
  });

  it("returns null when outcome price is unavailable", () => {
    const noPrice = makeMarket({
      outcomes: [{ label: "Yes", tokenId: "yes", price: null }],
    });
    expect(marketSettlementValue(noPrice, "yes")).toBeNull();
  });

  it("returns null for a null market", () => {
    expect(marketSettlementValue(null, "yes")).toBeNull();
  });
});
