/**
 * Types for Polymarket data: both the raw upstream shapes (loosely typed, since
 * the upstream returns numeric strings and JSON-encoded string arrays) and the
 * normalized internal shapes the rest of Bonk consumes.
 */

// ---------------------------------------------------------------------------
// Raw upstream shapes (Gamma + CLOB). Fields are optional/loose on purpose.
// ---------------------------------------------------------------------------

export interface RawGammaMarket {
  id?: string;
  conditionId?: string;
  question?: string;
  slug?: string;
  description?: string;
  category?: string;
  // JSON-encoded string arrays, e.g. "[\"Yes\", \"No\"]"
  outcomes?: string;
  outcomePrices?: string;
  clobTokenIds?: string;
  liquidity?: string | number;
  liquidityNum?: number;
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: string | number;
  spread?: string | number;
  bestBid?: string | number;
  bestAsk?: string | number;
  lastTradePrice?: string | number;
  startDate?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  acceptingOrders?: boolean;
  enableOrderBook?: boolean;
  image?: string;
  icon?: string;
}

export interface RawClobBookLevel {
  price: string;
  size: string;
}

export interface RawClobBook {
  market?: string;
  asset_id?: string;
  bids?: RawClobBookLevel[];
  asks?: RawClobBookLevel[];
  hash?: string;
  timestamp?: string;
}

// ---------------------------------------------------------------------------
// Normalized internal shapes.
// ---------------------------------------------------------------------------

export interface MarketOutcome {
  /** "Yes" / "No" / team name / etc. */
  label: string;
  /** CLOB token id for this outcome. */
  tokenId: string;
  /** Implied probability 0..1 from Gamma, if available. */
  price: number | null;
}

export interface Market {
  id: string;
  conditionId: string;
  question: string;
  slug: string;
  category: string;
  outcomes: MarketOutcome[];

  liquidity: number;
  volume: number;
  volume24hr: number;
  /** Spread as a fraction (e.g. 0.03 = 3 cents on a 0..1 price scale). */
  spread: number;
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  lastTradePrice: number | null;

  startDate: string | null;
  endDate: string | null;
  /** Milliseconds until resolution, or null if no end date. */
  timeToResolutionMs: number | null;

  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  enableOrderBook: boolean;

  image: string | null;
}

export interface BookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  /** Sorted best-first: bids descending by price, asks ascending by price. */
  bids: BookLevel[];
  asks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
  /** Fractional spread (bestAsk - bestBid). */
  spread: number | null;
  /** Upstream timestamp in ms, if provided. */
  timestamp: number | null;
  /** When Bonk fetched it (ms epoch). Used for stale-data detection. */
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Copy-trading: leaderboard + per-trader trades.
// ---------------------------------------------------------------------------

export interface Leader {
  wallet: string;
  name: string;
  /** Profit ($) or volume ($) depending on the leaderboard metric. */
  amount: number;
  rank: number;
}

export interface TraderTrade {
  wallet: string;
  traderName: string;
  side: "BUY" | "SELL";
  tokenId: string;
  conditionId: string;
  size: number; // shares
  price: number; // 0..1
  /** Unix seconds. */
  timestamp: number;
  title: string;
  outcome: string;
  txHash: string;
}

// Standard API envelope returned by all internal /api routes.
export type ApiOk<T> = { ok: true; data: T; fetchedAt: number };
export type ApiErr = { ok: false; error: string };
export type ApiEnvelope<T> = ApiOk<T> | ApiErr;
