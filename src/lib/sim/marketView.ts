/**
 * A per-token "view" unifying Gamma market fields with a (possibly missing)
 * CLOB order book into the snapshot the engine reasons about. When a live book
 * is present we use it; otherwise we fall back to Gamma's best bid/ask/last.
 */
import type { BookLevel, Market, OrderBook } from "@/lib/polymarket/types";

export interface TokenView {
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  outcomeLabel: string;

  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  last: number | null;
  spread: number | null;
  liquidity: number;

  bids: BookLevel[]; // best (highest) first
  asks: BookLevel[]; // best (lowest) first
  hasBook: boolean;
  fetchedAt: number;

  // Static market context for risk checks
  active: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;
  timeToResolutionMs: number | null;
}

/** Build a view for a market's primary tradable outcome (outcomes[0]). */
export function buildTokenView(
  market: Market,
  book: OrderBook | undefined,
  now: number,
): TokenView | null {
  const outcome = market.outcomes[0];
  if (!outcome || !outcome.tokenId) return null;

  const hasBook = !!book && (book.bids.length > 0 || book.asks.length > 0);

  const bestBid = hasBook ? book!.bestBid : market.bestBid;
  const bestAsk = hasBook ? book!.bestAsk : market.bestAsk;
  const mid =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : market.midpoint ?? outcome.price ?? market.lastTradePrice;
  const spread =
    bestBid != null && bestAsk != null ? bestAsk - bestBid : market.spread || null;

  return {
    marketId: market.conditionId,
    marketQuestion: market.question,
    tokenId: outcome.tokenId,
    outcomeLabel: outcome.label,

    bestBid,
    bestAsk,
    mid,
    last: market.lastTradePrice,
    spread,
    liquidity: market.liquidity,

    bids: hasBook ? book!.bids : [],
    asks: hasBook ? book!.asks : [],
    hasBook,
    fetchedAt: hasBook ? book!.fetchedAt : now,

    active: market.active,
    acceptingOrders: market.acceptingOrders,
    enableOrderBook: market.enableOrderBook,
    timeToResolutionMs: market.timeToResolutionMs,
  };
}

/**
 * Build a minimal view from an order book alone (no Gamma Market). Used to mark
 * copy-traded positions whose markets aren't in the scanner universe.
 */
export function buildViewFromBook(
  tokenId: string,
  book: OrderBook,
  meta: { marketId: string; marketQuestion: string; outcomeLabel: string },
  now: number,
): TokenView | null {
  if (book.bids.length === 0 && book.asks.length === 0) return null;
  return {
    marketId: meta.marketId,
    marketQuestion: meta.marketQuestion,
    tokenId,
    outcomeLabel: meta.outcomeLabel,
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
    mid: book.midpoint,
    last: book.midpoint,
    spread: book.spread,
    liquidity: 0,
    bids: book.bids,
    asks: book.asks,
    hasBook: true,
    fetchedAt: book.fetchedAt,
    active: true,
    acceptingOrders: true,
    enableOrderBook: true,
    timeToResolutionMs: null,
  };
}

/** Total ask size at or below `price` — liquidity a resting BUY could lift. */
export function askSizeAtOrBelow(view: TokenView, price: number): number {
  return view.asks.filter((l) => l.price <= price + 1e-9).reduce((s, l) => s + l.size, 0);
}

/** Total bid size at or above `price` — demand a resting SELL could hit. */
export function bidSizeAtOrAbove(view: TokenView, price: number): number {
  return view.bids.filter((l) => l.price >= price - 1e-9).reduce((s, l) => s + l.size, 0);
}
