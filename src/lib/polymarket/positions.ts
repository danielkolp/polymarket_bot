/**
 * Read-only fetchers for an account's *current* on-chain positions and a token's
 * price history. Used by the Live Mode Portfolio Recovery system so the bot can
 * become portfolio-aware before any future live session.
 *
 * Positions: https://data-api.polymarket.com/positions?user=<wallet>
 * Price history: https://clob.polymarket.com/prices-history?market=<tokenId>
 *
 * These are READ-ONLY. Nothing here places or signs orders.
 */
import { clobRequest, dataRequest } from "./client";

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

interface RawPosition {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  size?: number | string;
  avgPrice?: number | string;
  curPrice?: number | string;
  initialValue?: number | string;
  currentValue?: number | string;
  cashPnl?: number | string;
  percentPnl?: number | string;
  redeemable?: boolean;
  title?: string;
  slug?: string;
  outcome?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

function toNumOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizePosition(raw: RawPosition): AccountPosition | null {
  const tokenId = raw.asset ?? "";
  if (!tokenId) return null;
  const size = toNumOrNull(raw.size) ?? 0;
  return {
    wallet: (raw.proxyWallet ?? "").toLowerCase(),
    tokenId,
    conditionId: raw.conditionId ?? "",
    size,
    avgPrice: toNumOrNull(raw.avgPrice),
    curPrice: toNumOrNull(raw.curPrice),
    initialValueUsd: toNumOrNull(raw.initialValue),
    currentValueUsd: toNumOrNull(raw.currentValue),
    cashPnlUsd: toNumOrNull(raw.cashPnl),
    percentPnl: toNumOrNull(raw.percentPnl),
    redeemable: Boolean(raw.redeemable),
    title: raw.title ?? "(market)",
    slug: raw.slug ?? "",
    outcome: raw.outcome ?? "",
    endDate: raw.endDate ?? null,
    negativeRisk: Boolean(raw.negativeRisk),
  };
}

/**
 * Fetch the wallet's current positions. `sizeThreshold` filters out dust; we
 * keep anything with a positive size by default. Resolved-but-redeemable
 * positions are included so recovery can surface them for manual redemption.
 */
export async function fetchUserPositions(wallet: string, limit = 500): Promise<AccountPosition[]> {
  const raws = await dataRequest<RawPosition[]>("/positions", {
    query: { user: wallet, limit, sizeThreshold: 0.01 },
  });
  const list = Array.isArray(raws) ? raws : [];
  const out: AccountPosition[] = [];
  for (const r of list) {
    const p = normalizePosition(r);
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
