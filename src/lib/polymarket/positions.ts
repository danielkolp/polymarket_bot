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
  /** Resolved against this outcome (worth $0). Data API v2 `REDEEMABLE_LOST`. */
  lost?: boolean;
  title: string;
  slug: string;
  outcome: string;
  endDate: string | null;
  negativeRisk: boolean;
}

interface RawPosition {
  // Data API v2 (snake_case)
  proxy_wallet?: string;
  token_id?: string;
  condition_id?: string;
  current_size?: number | string;
  avg_price?: number | string;
  current_price?: number | string;
  entry_cost_usdc?: number | string;
  current_value?: number | string;
  unrealized_pnl?: number | string;
  percent_pnl?: number | string;
  status?: string;
  end_date?: string;
  negative_risk?: boolean;
  // Data API v1 (camelCase) — kept for tolerance in tests/fixtures.
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
  const tokenId = raw.token_id ?? raw.asset ?? "";
  if (!tokenId) return null;
  const size = toNumOrNull(raw.current_size ?? raw.size) ?? 0;
  const status = String(raw.status ?? "").toUpperCase();
  const curPrice = toNumOrNull(raw.current_price ?? raw.curPrice);
  const resolved = Boolean(raw.redeemable) || status === "REDEEMABLE" || status === "REDEEMABLE_LOST";
  // Data API v2 marks EVERY resolved, still-held position "REDEEMABLE" — losers
  // included (worth $0). Only a resolved position priced near $1 is a winning
  // claim; everything else resolved is a loss.
  const lost = status === "REDEEMABLE_LOST" || (resolved && (curPrice == null || curPrice < 0.5));
  return {
    wallet: (raw.proxy_wallet ?? raw.proxyWallet ?? "").toLowerCase(),
    tokenId,
    conditionId: raw.condition_id ?? raw.conditionId ?? "",
    size,
    avgPrice: toNumOrNull(raw.avg_price ?? raw.avgPrice),
    curPrice,
    initialValueUsd: toNumOrNull(raw.entry_cost_usdc ?? raw.initialValue),
    currentValueUsd: toNumOrNull(raw.current_value ?? raw.currentValue),
    cashPnlUsd: toNumOrNull(raw.unrealized_pnl ?? raw.cashPnl),
    percentPnl: toNumOrNull(raw.percent_pnl ?? raw.percentPnl),
    redeemable: resolved && !lost,
    lost,
    title: raw.title ?? "(market)",
    slug: raw.slug ?? "",
    outcome: raw.outcome ?? "",
    endDate: raw.end_date ?? raw.endDate ?? null,
    negativeRisk: Boolean(raw.negative_risk ?? raw.negativeRisk),
  };
}

/**
 * Fetch the wallet's current positions. `sizeThreshold` filters out dust; we
 * keep anything with a positive size by default. Resolved-but-redeemable
 * positions are included so recovery can surface them for manual redemption.
 */
export type PositionStatus = "OPEN" | "REDEEMABLE" | "REDEEMABLE_LOST";

/** Max positions read per status (cursor pages of up to 500). */
const MAX_POSITIONS_PER_STATUS = 2000;

/**
 * Fetch a wallet's positions from Data API v2 (`/v2/positions`), following the
 * cursor so wallets with more than one page are read completely (a truncated
 * read would make a leader look like they exited when they did not).
 *
 * `statuses` defaults to OPEN only. The bot's own account also reads
 * REDEEMABLE (won, unclaimed) so winnings to claim are surfaced.
 */
export async function fetchUserPositions(
  wallet: string,
  limit = 500,
  statuses: PositionStatus[] = ["OPEN"],
): Promise<AccountPosition[]> {
  const out: AccountPosition[] = [];
  for (const status of statuses) {
    let cursor: string | undefined;
    let read = 0;
    for (let page = 0; page < 10; page += 1) {
      const res = await dataRequest<{ data?: RawPosition[] | null; pagination?: { next_cursor?: string | null } }>(
        "/v2/positions",
        { query: { user: wallet, status, limit: Math.min(500, Math.max(1, limit)), cursor } },
      );
      const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? (res as RawPosition[]) : [];
      for (const r of list) {
        const p = normalizePosition(r);
        if (p && p.size > 0) out.push(p);
      }
      read += list.length;
      const next = res && !Array.isArray(res) ? res.pagination?.next_cursor : null;
      if (!next || read >= MAX_POSITIONS_PER_STATUS) break;
      cursor = next;
    }
  }
  return out;
}

/**
 * A wallet's open positions in ONE market. Exact and cheap even for wallets
 * holding tens of thousands of positions (the full list is paged and capped).
 */
export async function fetchUserMarketPositions(wallet: string, conditionId: string): Promise<AccountPosition[]> {
  const res = await dataRequest<{ data?: RawPosition[] | null }>("/v2/positions", {
    query: { user: wallet, condition_id: conditionId, status: "OPEN", limit: 50 },
  });
  const list = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? (res as RawPosition[]) : [];
  return list.map(normalizePosition).filter((p): p is AccountPosition => p != null && p.size > 0);
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
