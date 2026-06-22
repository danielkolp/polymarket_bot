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

export async function fetchMarketById(conditionId: string): Promise<Market | null> {
  // Gamma supports lookup by clob token / condition via the list endpoint filter.
  const raws = await gammaRequest<RawGammaMarket[]>("/markets", {
    query: { clob_token_ids: conditionId, limit: 1 },
  });
  const markets = normalizeMarkets(Array.isArray(raws) ? raws : []);
  return markets[0] ?? null;
}
