/**
 * Gamma Markets API fetchers (market/event metadata + discovery filters).
 * https://gamma-api.polymarket.com
 */
import { gammaRequest } from "./client";
import { normalizeMarkets } from "./normalize";
import type { Market, RawGammaMarket } from "./types";

export interface MarketQuery {
  limit?: number;
  offset?: number;
  /** Gamma sort field, e.g. "volume24hr", "liquidity", "endDate". */
  order?: string;
  ascending?: boolean;
  active?: boolean;
  closed?: boolean;
  archived?: boolean;
  liquidityNumMin?: number;
  volumeNumMin?: number;
  /** ISO date string. */
  endDateMin?: string;
  endDateMax?: string;
  tagId?: number;
  /** Category slug, e.g. "sports", "politics", "crypto". */
  tagSlug?: string;
  relatedTags?: boolean;
}

/**
 * Resolve a category tag slug (e.g. "crypto") to its numeric tag id, which is
 * what /markets actually filters on. Results are cached for the process.
 */
const tagIdCache = new Map<string, number | null>();

export async function resolveTagId(slug: string): Promise<number | null> {
  const key = slug.toLowerCase();
  if (tagIdCache.has(key)) return tagIdCache.get(key)!;
  try {
    const tag = await gammaRequest<{ id?: string | number }>(`/tags/slug/${encodeURIComponent(key)}`);
    const id = tag?.id != null ? Number(tag.id) : NaN;
    const resolved = Number.isFinite(id) ? id : null;
    tagIdCache.set(key, resolved);
    return resolved;
  } catch {
    tagIdCache.set(key, null);
    return null;
  }
}

/**
 * Fetch and normalize markets. Applies Gamma-side filters where supported;
 * the route layer / client refines anything Gamma can't express.
 */
export async function fetchMarkets(query: MarketQuery = {}): Promise<Market[]> {
  // /markets filters by numeric tag_id, not slug — resolve if needed.
  let tagId = query.tagId;
  if (tagId == null && query.tagSlug) {
    tagId = (await resolveTagId(query.tagSlug)) ?? undefined;
  }

  const raws = await gammaRequest<RawGammaMarket[]>("/markets", {
    query: {
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
      order: query.order ?? "volume24hr",
      ascending: query.ascending ?? false,
      active: query.active,
      closed: query.closed,
      archived: query.archived,
      liquidity_num_min: query.liquidityNumMin,
      volume_num_min: query.volumeNumMin,
      end_date_min: query.endDateMin,
      end_date_max: query.endDateMax,
      tag_id: tagId,
      related_tags: query.relatedTags,
    },
  });
  return normalizeMarkets(Array.isArray(raws) ? raws : []);
}

const MARKET_CACHE_TTL_MS = 10_000;
const MARKET_CACHE_MAX = 2000;
const marketCache = new Map<string, { at: number; market: Market | null }>();
const marketInFlight = new Map<string, Promise<Market | null>>();

async function lookupMarketByToken(tokenId: string): Promise<Market | null> {
  // Gamma's list endpoint hides closed markets by default, so a resolved market
  // returns []. Fall back to closed=true — otherwise resolved positions never
  // settle and keep their last (stale) mark forever.
  const open = await gammaRequest<RawGammaMarket[]>("/markets", {
    query: { clob_token_ids: tokenId, limit: 1 },
  });
  const openMarkets = normalizeMarkets(Array.isArray(open) ? open : []);
  if (openMarkets[0]) return openMarkets[0];
  const closed = await gammaRequest<RawGammaMarket[]>("/markets", {
    query: { clob_token_ids: tokenId, closed: true, limit: 1 },
  });
  return normalizeMarkets(Array.isArray(closed) ? closed : [])[0] ?? null;
}

/**
 * Look up the market containing a CLOB token id (open OR resolved). Results are
 * cached briefly and concurrent lookups for the same token share one request,
 * which keeps per-poll mark/settlement refreshes well under Gamma's rate limits.
 * Pass `maxAgeMs: 0` when a decision needs the freshest quote (e.g. entry gates).
 */
export async function fetchMarketById(tokenId: string, opts: { maxAgeMs?: number } = {}): Promise<Market | null> {
  const maxAgeMs = opts.maxAgeMs ?? MARKET_CACHE_TTL_MS;
  const cached = marketCache.get(tokenId);
  if (cached && Date.now() - cached.at <= maxAgeMs) return cached.market;

  const pending = marketInFlight.get(tokenId);
  if (pending) return pending;

  const request = lookupMarketByToken(tokenId)
    .then((market) => {
      if (marketCache.size >= MARKET_CACHE_MAX) {
        const oldest = marketCache.keys().next().value;
        if (oldest !== undefined) marketCache.delete(oldest);
      }
      marketCache.set(tokenId, { at: Date.now(), market });
      return market;
    })
    .finally(() => {
      marketInFlight.delete(tokenId);
    });
  marketInFlight.set(tokenId, request);
  return request;
}

/** Test hook: drop cached market lookups. */
export function clearMarketCache(): void {
  marketCache.clear();
}
