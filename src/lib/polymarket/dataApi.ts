/**
 * Polymarket Data API v2 helpers.
 *
 * Data API v1 (bare arrays, camelCase, offset pagination) and lb-api were
 * retired in Nov 2026 and now return HTTP 410. v2 wraps every response in
 * `{ data, pagination }`, uses snake_case fields, and paginates by cursor only
 * (sending `offset` is a 400). These helpers hide that envelope from callers.
 *
 * Docs: https://docs.polymarket.com/api-reference/data-api/overview
 */
import { dataRequest } from "./client";

type Query = Record<string, string | number | boolean | undefined | null>;

interface V2Pagination {
  limit?: number;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface V2Envelope<T> {
  data?: T | null;
  pagination?: V2Pagination;
}

/** GET a v2 endpoint and return its `data` payload (null on an empty miss). */
export async function dataV2<T>(path: string, query: Query = {}): Promise<T | null> {
  const res = await dataRequest<V2Envelope<T>>(`/v2${path.startsWith("/") ? path : `/${path}`}`, { query });
  return res?.data ?? null;
}

/**
 * GET a paginated v2 list endpoint, following `next_cursor` up to `maxPages`.
 * `limit` only applies to the first page (per the v2 contract), and every other
 * filter must be re-sent on each page because the cursor only carries the seek
 * anchor.
 */
export async function dataV2List<T>(path: string, query: Query = {}, maxPages = 1): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | null | undefined;
  for (let page = 0; page < Math.max(1, maxPages); page++) {
    const pageQuery: Query = page === 0 ? query : { ...query, limit: undefined, cursor: cursor ?? undefined };
    const res = await dataRequest<V2Envelope<T[]>>(`/v2${path.startsWith("/") ? path : `/${path}`}`, {
      query: pageQuery,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    out.push(...rows);
    cursor = res?.pagination?.next_cursor;
    if (!cursor || !res?.pagination?.has_more || rows.length === 0) break;
  }
  return out;
}

export function toNum(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function toNumOrNull(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Lowercased wallet, or "" if missing. */
export function walletOf(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** Display name for a wallet: pseudonym > human name > short address. */
export function displayName(wallet: string, pseudonym?: string | null, name?: string | null): string {
  // v2 fills `name` with "<address>-<timestamp>" for users who never set one;
  // treat that as no name.
  const cleanName = name && !/^0x[0-9a-fA-F]{40}(-\d+)?$/.test(name) ? name : "";
  return pseudonym || cleanName || (wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "anon");
}

// ── /v2/user-stats ────────────────────────────────────────────────────────────

export interface UserStats {
  wallet: string;
  /** Distinct markets traded. */
  trades: number;
  joinDate: number | null;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  makerRebateUsd: number;
  takerRebateUsd: number;
  rewardIncomeUsd: number;
}

interface RawUserStats {
  proxy_wallet?: string;
  trades?: number | string;
  join_date?: number | string;
  all_time_pnl?: {
    realized_market_pnl?: number | string;
    realized_pnl?: number | string;
    unrealized_pnl?: number | string;
    maker_rebate?: number | string;
    taker_rebate?: number | string;
    reward_income?: number | string;
  } | null;
}

/**
 * All-time stats for a wallet. Used by discovery to spot market makers: a wallet
 * whose income is mostly maker rebates / liquidity rewards is earning from
 * providing liquidity, not from picking winners, so copying its fills with
 * taker orders just pays the spread it was collecting.
 */
export async function fetchUserStats(wallet: string): Promise<UserStats | null> {
  const raw = await dataV2<RawUserStats>("/user-stats", { user: wallet });
  if (!raw) return null;
  const pnl = raw.all_time_pnl ?? {};
  return {
    wallet: walletOf(raw.proxy_wallet) || wallet.toLowerCase(),
    trades: toNum(raw.trades),
    joinDate: toNumOrNull(raw.join_date),
    realizedPnlUsd: toNum(pnl.realized_market_pnl ?? pnl.realized_pnl),
    unrealizedPnlUsd: toNum(pnl.unrealized_pnl),
    makerRebateUsd: toNum(pnl.maker_rebate),
    takerRebateUsd: toNum(pnl.taker_rebate),
    rewardIncomeUsd: toNum(pnl.reward_income),
  };
}
