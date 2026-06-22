/**
 * Realistic execution-cost model for the simulator.
 *
 * The naive sim filled every copy at the followed trader's exact price — no
 * spread, no slippage, no fees, infinite liquidity. That flatters returns. This
 * model instead walks the live order book to produce an honest fill:
 *
 *   - BUY  consumes the asks (you pay up the book), SELL consumes the bids.
 *   - Orders only fill at prices within a slippage tolerance of the mid, so a
 *     thin book yields a PARTIAL fill or a REJECT — never a free fill.
 *   - A configurable taker fee is applied to notional.
 *   - When no live book is available we fall back to the best quote, and failing
 *     that to an assumed spread — and we LABEL which, so precision is never faked.
 *
 * Friction (spread/slippage vs mid + fees) is reported so the dashboard can show
 * how much realistic costs eat into the strategy's gross edge.
 */
import type { OrderBook } from "@/lib/polymarket/types";

export interface FillCostSettings {
  takerFeeBps: number;
  maxSlippageBps: number;
  fallbackSpreadBps: number;
}

export interface FillResult {
  status: "filled" | "partial" | "rejected";
  costSource: "book" | "quote" | "assumed";
  filledShares: number;
  /** Effective VWAP price per share, before fees. */
  fillPrice: number;
  /** filledShares * fillPrice, before fees. */
  notionalUsd: number;
  feeUsd: number;
  /** Mid/benchmark price used to measure slippage. */
  referenceMid: number;
  /** Slippage in bps vs mid (positive = worse for us). */
  slippageBps: number;
  /** Spread/slippage cost vs mid + fees, in USD. */
  frictionUsd: number;
  note: string;
}

export interface SimulateFillParams {
  side: "BUY" | "SELL";
  book: OrderBook | null;
  /** The followed trader's price; benchmark of last resort. */
  referencePrice: number;
  marketBestBid: number | null;
  marketBestAsk: number | null;
  marketMid: number | null;
  /** BUY: cash to spend. */
  desiredUsd?: number;
  /** SELL: shares to sell. */
  desiredShares?: number;
  settings: FillCostSettings;
}

function deriveMid(params: SimulateFillParams): number {
  const { book, marketMid, marketBestBid, marketBestAsk, referencePrice } = params;
  if (book?.midpoint != null && book.midpoint > 0) return book.midpoint;
  if (marketMid != null && marketMid > 0) return marketMid;
  if (marketBestBid != null && marketBestAsk != null) return (marketBestBid + marketBestAsk) / 2;
  return referencePrice > 0 ? referencePrice : 0.5;
}

function cents(p: number): string {
  return `${(p * 100).toFixed(1)}c`;
}

export function simulateFill(params: SimulateFillParams): FillResult {
  const { side, book, settings } = params;
  const mid = deriveMid(params);
  const tol = Math.max(0, settings.maxSlippageBps) / 10_000;
  const desiredUsd = Math.max(0, params.desiredUsd ?? 0);
  const desiredShares = Math.max(0, params.desiredShares ?? 0);

  const levels = side === "BUY" ? book?.asks ?? [] : book?.bids ?? [];
  let costSource: FillResult["costSource"] = "book";
  let shares = 0;
  let notionalUsd = 0;
  let fillPrice = 0;

  if (levels.length > 0) {
    const limit = side === "BUY" ? mid * (1 + tol) : mid * (1 - tol);
    if (side === "BUY") {
      let remainingCash = desiredUsd;
      for (const lvl of levels) {
        if (lvl.price > limit || remainingCash <= 1e-9) break;
        const spend = Math.min(remainingCash, lvl.price * lvl.size);
        shares += spend / lvl.price;
        notionalUsd += spend;
        remainingCash -= spend;
      }
    } else {
      let remainingShares = desiredShares;
      for (const lvl of levels) {
        if (lvl.price < limit || remainingShares <= 1e-9) break;
        const take = Math.min(remainingShares, lvl.size);
        shares += take;
        notionalUsd += take * lvl.price;
        remainingShares -= take;
      }
    }
    fillPrice = shares > 0 ? notionalUsd / shares : 0;
  } else {
    // No live book — fall back to a quote, then to an assumed spread.
    const haveQuote = side === "BUY" ? params.marketBestAsk != null : params.marketBestBid != null;
    if (haveQuote) {
      costSource = "quote";
      fillPrice = (side === "BUY" ? params.marketBestAsk : params.marketBestBid) as number;
    } else {
      costSource = "assumed";
      const adj = Math.max(0, settings.fallbackSpreadBps) / 10_000;
      fillPrice = side === "BUY" ? params.referencePrice * (1 + adj) : params.referencePrice * (1 - adj);
    }
    fillPrice = Math.min(0.999, Math.max(0.001, fillPrice));
    if (side === "BUY") {
      shares = fillPrice > 0 ? desiredUsd / fillPrice : 0;
      notionalUsd = desiredUsd;
    } else {
      shares = desiredShares;
      notionalUsd = shares * fillPrice;
    }
  }

  const slippageBps = mid > 0 && fillPrice > 0 ? ((side === "BUY" ? fillPrice - mid : mid - fillPrice) / mid) * 10_000 : 0;

  // In the fallback path there's no depth limit, so enforce the slippage cap here.
  if (costSource !== "book" && slippageBps > settings.maxSlippageBps) {
    return {
      status: "rejected",
      costSource,
      filledShares: 0,
      fillPrice: 0,
      notionalUsd: 0,
      feeUsd: 0,
      referenceMid: mid,
      slippageBps,
      frictionUsd: 0,
      note: `Rejected: ${side} quote ${cents(fillPrice)} is ${(slippageBps / 100).toFixed(1)}% past mid ${cents(mid)} (over ${(settings.maxSlippageBps / 100).toFixed(1)}% cap).`,
    };
  }

  if (shares <= 1e-9) {
    return {
      status: "rejected",
      costSource,
      filledShares: 0,
      fillPrice: 0,
      notionalUsd: 0,
      feeUsd: 0,
      referenceMid: mid,
      slippageBps,
      frictionUsd: 0,
      note: `Rejected: no ${side === "BUY" ? "asks" : "bids"} within ${(settings.maxSlippageBps / 100).toFixed(1)}% of mid ${cents(mid)}.`,
    };
  }

  const feeUsd = notionalUsd * (Math.max(0, settings.takerFeeBps) / 10_000);
  const spreadCostUsd = (side === "BUY" ? fillPrice - mid : mid - fillPrice) * shares;
  const frictionUsd = spreadCostUsd + feeUsd;

  const target = side === "BUY" ? desiredUsd : desiredShares;
  const got = side === "BUY" ? notionalUsd : shares;
  const status: FillResult["status"] = got < target * 0.99 ? "partial" : "filled";

  return {
    status,
    costSource,
    filledShares: shares,
    fillPrice,
    notionalUsd,
    feeUsd,
    referenceMid: mid,
    slippageBps,
    frictionUsd,
    note: `${fillPrice >= mid ? "+" : "-"}${Math.abs((fillPrice - mid) * 100).toFixed(1)}c vs mid${costSource !== "book" ? ` (${costSource})` : ""}`,
  };
}
