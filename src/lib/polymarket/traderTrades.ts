/**
 * Per-trader trade history fetchers (Polymarket Data API v2).
 * https://data-api.polymarket.com/v2/trades?user=<wallet>&limit=N&taker_only=false
 *
 * Data API v1 (`/trades`) was retired on 2026-11-02. `taker_only=false` also
 * returns the leader's MAKER fills (resting limit orders), which v1 hid — many
 * good traders enter with limit orders, so without it their entries are missed.
 */
import { dataRequest } from "./client";
import type { TraderTrade } from "./types";

const DEFAULT_MAX_WALLETS = 100;
const REQUEST_CONCURRENCY = 8;

interface RawTrade {
  proxy_wallet?: string;
  token_id?: string;
  condition_id?: string;
  transaction_hash?: string;
  proxyWallet?: string;
  side?: string;
  asset?: string;
  conditionId?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  outcome?: string;
  name?: string;
  pseudonym?: string;
  transactionHash?: string;
}

function normalize(raw: RawTrade): TraderTrade | null {
  const wallet = (raw.proxy_wallet ?? raw.proxyWallet ?? "").toLowerCase();
  const tokenId = raw.token_id ?? raw.asset ?? "";
  if (!wallet || !tokenId) return null;
  const side = String(raw.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  return {
    wallet,
    traderName: raw.pseudonym || raw.name || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    side,
    tokenId,
    conditionId: raw.condition_id ?? raw.conditionId ?? "",
    size: Number(raw.size) || 0,
    price: Number(raw.price) || 0,
    timestamp: Number(raw.timestamp) || 0,
    title: raw.title ?? "(market)",
    outcome: raw.outcome ?? "",
    txHash: raw.transaction_hash ?? raw.transactionHash ?? "",
  };
}

/** Unwrap a Data API v2 envelope (`{ data: [...] }`), tolerating a bare array. */
export function v2List<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  if (res && typeof res === "object" && Array.isArray((res as { data?: unknown }).data)) {
    return (res as { data: T[] }).data;
  }
  return [];
}

export async function fetchUserTrades(wallet: string, limit = 20): Promise<TraderTrade[]> {
  const res = await dataRequest<unknown>("/v2/trades", {
    query: { user: wallet, limit: Math.min(500, Math.max(1, limit)), taker_only: false },
  });
  const list = v2List<RawTrade>(res);
  const out: TraderTrade[] = [];
  for (const r of list) {
    const t = normalize(r);
    if (t) out.push(t);
  }
  return out;
}

/** Fetch recent trades for several wallets in batches, newest first. */
export async function fetchTradesForWallets(
  wallets: string[],
  perWallet = 15,
  maxWallets = DEFAULT_MAX_WALLETS,
): Promise<TraderTrade[]> {
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()))]
    .filter(Boolean)
    .slice(0, Math.max(0, maxWallets));
  const all: TraderTrade[] = [];
  for (let i = 0; i < unique.length; i += REQUEST_CONCURRENCY) {
    const batch = unique.slice(i, i + REQUEST_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((w) => fetchUserTrades(w, perWallet)));
    for (const r of results) if (r.status === "fulfilled") all.push(...r.value);
  }
  return all.sort((a, b) => b.timestamp - a.timestamp);
}
