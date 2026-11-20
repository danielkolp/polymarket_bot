/**
 * Read-only fetchers for an account's *current* on-chain positions and a token's
 * price history. Used by the Live Mode Portfolio Recovery system so the bot can
 * become portfolio-aware before any future live session.
 *
 * Positions: https://data-api.polymarket.com/v2/positions?user=<wallet>
 * Price history: https://clob.polymarket.com/prices-history?market=<tokenId>
 *
 * These are READ-ONLY. Nothing here places or signs orders.
 */
import { clobRequest } from "./client";
import { dataV2List, toNumOrNull, walletOf } from "./dataApi";

export interface AccountPosition {
  wallet: string;
  tokenId: string;
  conditionId: string;
  /** Shares currently held. */
  size: number;
  /** Average entry price (cost basis) per share, 0..1, from the API. null if absent. */
  avgPrice: number | null;
  /** Current price the API reports for the outcome, 0..1. null if absent. */
  curPrice: number | null;
  initialValueUsd: number | null;
  currentValueUsd: number | null;
  cashPnlUsd: number | null;
  percentPnl: number | null;
  /** True once the market has resolved and the position can be redeemed. */
  redeemable: boolean;
  title: string;
  slug: string;
  outcome: string;
  endDate: string | null;
  negativeRisk: boolean;
}

interface RawPositionV2 {
  proxy_wallet?: string;
  token_id?: string;
  condition_id?: string;
  current_size?: number | string;
  avg_price?: number | string;
  current_price?: number | string;
  entry_cost_usdc?: number | string;
  total_cost_usdc?: number | string;
  current_value?: number | string;
  unrealized_pnl?: number | string;
  total_pnl?: number | string;
  percent_pnl?: number | string;
  status?: string;
  redeemable?: boolean;
  negative_risk?: boolean;
  title?: string;
  slug?: string;
  outcome?: string;
  end_date?: string;
  event_slug?: string;
}

export function normalizePositionV2(raw: RawPositionV2): AccountPosition | null {
  const tokenId = raw.token_id ?? "";
  if (!tokenId) return null;
  const size = toNumOrNull(raw.current_size) ?? 0;
  return {
    wallet: walletOf(raw.proxy_wallet),
    tokenId,
    conditionId: raw.condition_id ?? "",
    size,
    avgPrice: toNumOrNull(raw.avg_price),
    curPrice: toNumOrNull(raw.current_price),
    initialValueUsd: toNumOrNull(raw.entry_cost_usdc ?? raw.total_cost_usdc),
    currentValueUsd: toNumOrNull(raw.current_value),
    cashPnlUsd: toNumOrNull(raw.unrealized_pnl ?? raw.total_pnl),
    percentPnl: toNumOrNull(raw.percent_pnl),
    redeemable: Boolean(raw.redeemable) || String(raw.status ?? "").toUpperCase() === "REDEEMABLE",
    title: raw.title ?? "(market)",
    slug: raw.slug ?? "",
    outcome: raw.outcome ?? "",
    endDate: raw.end_date ?? null,
    negativeRisk: Boolean(raw.negative_risk),
  };
}

/** v2 accepts at most 20 comma-separated condition ids per request. */
const MAX_CONDITIONS_PER_REQUEST = 20;

export interface FetchPositionsOptions {
  /**
   * Restrict to these markets. Strongly preferred when checking whether a wallet
   * still holds specific tokens: an unfiltered list is capped by pagination, so
   * a whale's long tail could be missing and look like an exit.
   */
  conditionIds?: string[];
  /** Max pages to walk for an unfiltered list (1000 rows per page). */
  maxPages?: number;
}

/**
 * Fetch the wallet's current (OPEN) positions, which in v2 includes
 * settled-but-unredeemed winners. Dust under 0.01 shares is filtered out.
 */
export async function fetchUserPositions(wallet: string, opts: FetchPositionsOptions = {}): Promise<AccountPosition[]> {
  const base = { user: wallet, filter_type: "TOKENS", filter_amount: 0.01 };
  let raws: RawPositionV2[] = [];
  const conditionIds = [...new Set((opts.conditionIds ?? []).filter(Boolean))];
  if (conditionIds.length > 0) {
    for (let i = 0; i < conditionIds.length; i += MAX_CONDITIONS_PER_REQUEST) {
      const chunk = conditionIds.slice(i, i + MAX_CONDITIONS_PER_REQUEST);
      raws.push(
        ...(await dataV2List<RawPositionV2>("/positions", { ...base, condition: chunk.join(","), limit: 1000 }, 2)),
      );
    }
  } else {
    raws = await dataV2List<RawPositionV2>("/positions", { ...base, limit: 1000 }, opts.maxPages ?? 3);
  }
  const out: AccountPosition[] = [];
  for (const r of raws) {
    const p = normalizePositionV2(r);
    if (p && p.size > 0) out.push(p);
  }
  return out;
}

export interface PricePoint {
  /** Unix seconds. */
  t: number;
  /** Price 0..1. */
  p: number;
}

export type PriceHistoryInterval = "1h" | "6h" | "1d" | "1w" | "1m" | "max";

interface RawPriceHistory {
  history?: { t?: number | string; p?: number | string }[];
}

/**
 * Fetch a token's recent price history. Returns [] on failure so callers can
 * degrade gracefully (history is enrichment, not load-bearing).
 */
export async function fetchPricesHistory(
  tokenId: string,
  interval: PriceHistoryInterval = "1w",
  fidelity = 180,
): Promise<PricePoint[]> {
  try {
    const res = await clobRequest<RawPriceHistory>("/prices-history", {
      query: { market: tokenId, interval, fidelity },
    });
    const list = Array.isArray(res?.history) ? res.history : [];
    const out: PricePoint[] = [];
    for (const point of list) {
      const t = toNumOrNull(point.t);
      const p = toNumOrNull(point.p);
      if (t != null && p != null) out.push({ t, p });
    }
    return out;
  } catch {
    return [];
  }
}
