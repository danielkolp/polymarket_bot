/**
 * Per-trader trade history fetchers.
 * https://data-api.polymarket.com/trades?user=<wallet>&limit=N
 */
import { dataRequest } from "./client";
import type { TraderTrade } from "./types";

const DEFAULT_MAX_WALLETS = 100;
const REQUEST_CONCURRENCY = 8;

interface RawTrade {
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
  const wallet = (raw.proxyWallet ?? "").toLowerCase();
  const tokenId = raw.asset ?? "";
  if (!wallet || !tokenId) return null;
  const side = String(raw.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  return {
    wallet,
    traderName: raw.pseudonym || raw.name || `${wallet.slice(0, 6)}…${wallet.slice(-4)}`,
    side,
    tokenId,
    conditionId: raw.conditionId ?? "",
    size: Number(raw.size) || 0,
    price: Number(raw.price) || 0,
    timestamp: Number(raw.timestamp) || 0,
    title: raw.title ?? "(market)",
    outcome: raw.outcome ?? "",
    txHash: raw.transactionHash ?? "",
  };
}

export async function fetchUserTrades(wallet: string, limit = 20): Promise<TraderTrade[]> {
  const raws = await dataRequest<RawTrade[]>("/trades", { query: { user: wallet, limit } });
  const list = Array.isArray(raws) ? raws : [];
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
