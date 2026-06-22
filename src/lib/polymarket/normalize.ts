/**
 * Normalization: turn loose upstream shapes into Bonk's internal Market /
 * OrderBook types. Handles JSON-encoded string arrays and numeric strings.
 */
import type {
  BookLevel,
  Market,
  MarketOutcome,
  OrderBook,
  RawClobBook,
  RawGammaMarket,
} from "./types";

function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toNumOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Parse a JSON-encoded string array like "[\"Yes\",\"No\"]"; tolerant of bad input. */
function parseJsonArray(value: string | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
  } catch {
    return [];
  }
}

export function normalizeMarket(raw: RawGammaMarket): Market | null {
  const conditionId = raw.conditionId ?? raw.id;
  if (!conditionId) return null;

  const labels = parseJsonArray(raw.outcomes);
  const tokenIds = parseJsonArray(raw.clobTokenIds);
  const prices = parseJsonArray(raw.outcomePrices);

  const outcomes: MarketOutcome[] = tokenIds.map((tokenId, i) => ({
    label: labels[i] ?? `Outcome ${i + 1}`,
    tokenId,
    price: toNumOrNull(prices[i]),
  }));

  const bestBid = toNumOrNull(raw.bestBid);
  const bestAsk = toNumOrNull(raw.bestAsk);
  const midpoint = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;

  const endDate = raw.endDate ?? null;
  const endMs = endDate ? Date.parse(endDate) : NaN;
  const timeToResolutionMs = Number.isFinite(endMs) ? endMs - Date.now() : null;

  return {
    id: String(raw.id ?? conditionId),
    conditionId,
    question: raw.question ?? "(untitled market)",
    slug: raw.slug ?? "",
    category: raw.category ?? "Uncategorized",
    outcomes,

    liquidity: toNum(raw.liquidityNum ?? raw.liquidity),
    volume: toNum(raw.volumeNum ?? raw.volume),
    volume24hr: toNum(raw.volume24hr),
    spread: toNum(raw.spread),
    bestBid,
    bestAsk,
    midpoint,
    lastTradePrice: toNumOrNull(raw.lastTradePrice),

    startDate: raw.startDate ?? null,
    endDate,
    timeToResolutionMs,

    active: Boolean(raw.active),
    closed: Boolean(raw.closed),
    acceptingOrders: Boolean(raw.acceptingOrders),
    enableOrderBook: Boolean(raw.enableOrderBook),

    image: raw.image ?? raw.icon ?? null,
  };
}

export function normalizeMarkets(raws: RawGammaMarket[]): Market[] {
  const out: Market[] = [];
  for (const raw of raws) {
    const m = normalizeMarket(raw);
    if (m) out.push(m);
  }
  return out;
}

function normalizeLevels(levels: RawClobBook["bids"], desc: boolean): BookLevel[] {
  const parsed: BookLevel[] = (levels ?? [])
    .map((l) => ({ price: toNum(l.price), size: toNum(l.size) }))
    .filter((l) => l.size > 0 && l.price > 0);
  parsed.sort((a, b) => (desc ? b.price - a.price : a.price - b.price));
  return parsed;
}

export function normalizeBook(raw: RawClobBook, tokenIdFallback: string): OrderBook {
  const bids = normalizeLevels(raw.bids, true); // best (highest) first
  const asks = normalizeLevels(raw.asks, false); // best (lowest) first
  const bestBid = bids.length ? bids[0].price : null;
  const bestAsk = asks.length ? asks[0].price : null;
  const midpoint = bestBid != null && bestAsk != null ? (bestBid + bestAsk) / 2 : null;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const ts = raw.timestamp ? Number(raw.timestamp) : NaN;

  return {
    tokenId: raw.asset_id ?? tokenIdFallback,
    bids,
    asks,
    bestBid,
    bestAsk,
    midpoint,
    spread,
    timestamp: Number.isFinite(ts) ? ts : null,
    fetchedAt: Date.now(),
  };
}
