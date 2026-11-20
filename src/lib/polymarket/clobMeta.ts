/**
 * Per-token CLOB metadata the strategy needs before it can size or price an
 * order correctly:
 *
 *  - the OUTCOME-SPECIFIC order book (Gamma's bestBid/bestAsk only describe the
 *    market's first outcome, so they are wrong for "No" tokens);
 *  - the minimum order size in shares (a position smaller than this cannot be
 *    sold with a marketable order);
 *  - the tick size / neg-risk flag;
 *  - the taker fee schedule. Polymarket charges takers
 *        fee/share = rate * (p * (1 - p)) ^ exponent
 *    on most categories since 2026-03 (makers pay nothing).
 *
 * All reads are public CLOB REST endpoints (no auth) so simulation and live
 * mode price trades identically. Results are cached: books for a few seconds,
 * market parameters for an hour.
 */
import { clobRequest } from "./client";
import { fetchBook } from "./clob";
import type { OrderBook } from "./types";

export interface TokenMarketMeta {
  tokenId: string;
  conditionId: string | null;
  /** Minimum order size in shares (defaults to 5 when unknown). */
  minOrderSize: number;
  tickSize: number;
  negRisk: boolean;
  /** Taker fee rate `r` (0 when fees are not enabled for the market). */
  feeRate: number;
  /** Taker fee exponent `e` (usually 1). */
  feeExponent: number;
  /** Whether the metadata came from the CLOB (`true`) or are defaults. */
  known: boolean;
  fetchedAt: number;
}

interface RawClobMarket {
  c?: string;
  mos?: number;
  mts?: number;
  nr?: boolean;
  fd?: { r?: number; e?: number; to?: boolean };
}

export const DEFAULT_MIN_ORDER_SHARES = 5;
const DEFAULT_TICK = 0.01;
const META_TTL_MS = 60 * 60 * 1000;
const META_ERROR_TTL_MS = 2 * 60 * 1000;
const BOOK_TTL_MS = 4_000;
const MAX_CACHE = 2_000;

const metaCache = new Map<string, TokenMarketMeta>();
const conditionByToken = new Map<string, string>();
const bookCache = new Map<string, { book: OrderBook; at: number }>();

function trimCache<K, V>(map: Map<K, V>): void {
  while (map.size > MAX_CACHE) {
    const first = map.keys().next();
    if (first.done) break;
    map.delete(first.value);
  }
}

function defaults(tokenId: string, conditionId: string | null): TokenMarketMeta {
  return {
    tokenId,
    conditionId,
    minOrderSize: DEFAULT_MIN_ORDER_SHARES,
    tickSize: DEFAULT_TICK,
    negRisk: false,
    // Unknown fee schedule: assume a typical 5% rate so cost checks stay
    // conservative rather than optimistic.
    feeRate: 0.05,
    feeExponent: 1,
    known: false,
    fetchedAt: Date.now(),
  };
}

async function resolveConditionId(tokenId: string, hint?: string | null): Promise<string | null> {
  if (hint && /^0x[0-9a-fA-F]{64}$/.test(hint)) return hint;
  const cached = conditionByToken.get(tokenId);
  if (cached) return cached;
  try {
    const res = await clobRequest<{ condition_id?: string }>(`/markets-by-token/${tokenId}`, { retries: 1 });
    if (res?.condition_id) {
      conditionByToken.set(tokenId, res.condition_id);
      trimCache(conditionByToken);
      return res.condition_id;
    }
  } catch {
    // fall through to defaults
  }
  return null;
}

/** Tick size, min order size, neg-risk and fee schedule for a token (cached 1h). */
export async function getTokenMarketMeta(tokenId: string, conditionIdHint?: string | null): Promise<TokenMarketMeta> {
  const now = Date.now();
  const cached = metaCache.get(tokenId);
  if (cached && now - cached.fetchedAt < (cached.known ? META_TTL_MS : META_ERROR_TTL_MS)) return cached;

  const conditionId = await resolveConditionId(tokenId, conditionIdHint);
  let meta = defaults(tokenId, conditionId);
  if (conditionId) {
    try {
      const raw = await clobRequest<RawClobMarket>(`/clob-markets/${conditionId}`, { retries: 1 });
      const fees = raw?.fd;
      meta = {
        tokenId,
        conditionId,
        minOrderSize: Number(raw?.mos) > 0 ? Number(raw?.mos) : DEFAULT_MIN_ORDER_SHARES,
        tickSize: Number(raw?.mts) > 0 ? Number(raw?.mts) : DEFAULT_TICK,
        negRisk: raw?.nr === true,
        feeRate: fees && Number(fees.r) > 0 ? Number(fees.r) : 0,
        feeExponent: fees && Number(fees.e) > 0 ? Number(fees.e) : 1,
        known: true,
        fetchedAt: now,
      };
    } catch {
      // keep conservative defaults; retried after META_ERROR_TTL_MS
    }
  }
  metaCache.set(tokenId, meta);
  trimCache(metaCache);
  return meta;
}

/** Outcome-specific order book with a short cache (best-first levels). */
export async function getOutcomeBook(tokenId: string, maxAgeMs = BOOK_TTL_MS): Promise<OrderBook> {
  const hit = bookCache.get(tokenId);
  if (hit && Date.now() - hit.at <= maxAgeMs) return hit.book;
  const book = await fetchBook(tokenId);
  bookCache.set(tokenId, { book, at: Date.now() });
  trimCache(bookCache);
  return book;
}

/** Best-effort book read: null instead of throwing. */
export async function tryGetOutcomeBook(tokenId: string, maxAgeMs = BOOK_TTL_MS): Promise<OrderBook | null> {
  try {
    return await getOutcomeBook(tokenId, maxAgeMs);
  } catch {
    return null;
  }
}

/** Taker fee in USD per share at price `p`. */
export function takerFeePerShare(meta: Pick<TokenMarketMeta, "feeRate" | "feeExponent">, price: number): number {
  const p = Math.min(0.999, Math.max(0.001, price));
  if (!(meta.feeRate > 0)) return 0;
  return meta.feeRate * Math.pow(p * (1 - p), meta.feeExponent || 1);
}

/** Taker fee as a fraction of notional at price `p` (e.g. 0.025 = 2.5%). */
export function takerFeeFraction(meta: Pick<TokenMarketMeta, "feeRate" | "feeExponent">, price: number): number {
  const p = Math.min(0.999, Math.max(0.001, price));
  return takerFeePerShare(meta, p) / p;
}

/**
 * Smallest USD notional that buys at least the market's minimum order size
 * (plus a small buffer so the position stays sellable after rounding), and
 * never less than the CLOB's $1 marketable-BUY floor.
 */
export function minSellableBuyUsd(minOrderShares: number, price: number, bufferPct = 5): number {
  const shares = Math.max(DEFAULT_MIN_ORDER_SHARES, minOrderShares) * (1 + bufferPct / 100);
  return Math.max(1, Math.ceil(shares * Math.max(0.001, price) * 100) / 100);
}

/** Round a price to the tick grid (down for BUY limits, up for SELL floors). */
export function roundToTick(price: number, tick: number, mode: "down" | "up" | "nearest"): number {
  const t = tick > 0 ? tick : DEFAULT_TICK;
  const steps = price / t;
  const rounded = mode === "down" ? Math.floor(steps + 1e-9) : mode === "up" ? Math.ceil(steps - 1e-9) : Math.round(steps);
  const decimals = Math.max(0, Math.ceil(-Math.log10(t)));
  return Number(Math.min(1 - t, Math.max(t, rounded * t)).toFixed(decimals));
}

/** For tests. */
export function __resetClobMetaCaches(): void {
  metaCache.clear();
  conditionByToken.clear();
  bookCache.clear();
}
