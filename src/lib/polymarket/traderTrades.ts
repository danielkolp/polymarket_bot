/**
 * Per-trader trade history fetchers (Data API v2).
 * https://data-api.polymarket.com/v2/trades?user=<wallet>&limit=N
 *
 * v2 defaults to `taker_only=true`, which is what we want for copy trading: a
 * wallet's taker fills are its deliberate directional bets, whereas its maker
 * fills are passive liquidity that can't be profitably copied with a taker order.
 */
import { dataV2List, displayName, toNum, walletOf } from "./dataApi";
import type { TraderTrade } from "./types";

const DEFAULT_MAX_WALLETS = 100;
const REQUEST_CONCURRENCY = 8;

interface RawTradeV2 {
  proxy_wallet?: string;
  side?: string;
  token_id?: string;
  condition_id?: string;
  size?: number | string;
  price?: number | string;
  timestamp?: number | string;
  title?: string;
  slug?: string;
  event_slug?: string;
  outcome?: string;
  outcome_index?: number | string;
  name?: string;
  pseudonym?: string;
  transaction_hash?: string;
}

export function normalizeTradeV2(raw: RawTradeV2): TraderTrade | null {
  const wallet = walletOf(raw.proxy_wallet);
  const tokenId = raw.token_id ?? "";
  if (!wallet || !tokenId) return null;
  const side = String(raw.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY";
  const outcomeIndex = toNum(raw.outcome_index);
  return {
    wallet,
    traderName: displayName(wallet, raw.pseudonym, raw.name),
    side,
    tokenId,
    conditionId: raw.condition_id ?? "",
    size: toNum(raw.size),
    price: toNum(raw.price),
    timestamp: toNum(raw.timestamp),
    title: raw.title ?? "(market)",
    outcome: raw.outcome ?? "",
    txHash: raw.transaction_hash ?? "",
    slug: raw.slug || undefined,
    eventSlug: raw.event_slug || undefined,
    outcomeIndex: outcomeIndex === 999 ? undefined : outcomeIndex,
  };
}

export async function fetchUserTrades(wallet: string, limit = 20): Promise<TraderTrade[]> {
  const raws = await dataV2List<RawTradeV2>("/trades", { user: wallet, limit: Math.min(1000, Math.max(1, limit)) });
  const out: TraderTrade[] = [];
  for (const r of raws) {
    const t = normalizeTradeV2(r);
    if (t) out.push(t);
  }
  return out;
}

export interface WalletTradesResult {
  trades: TraderTrade[];
  /** Wallets whose fetch succeeded. */
  okWallets: number;
  /** Wallets whose fetch failed (network/upstream error). */
  failedWallets: number;
  /** First error message seen, for logging. */
  firstError: string | null;
}

/**
 * Fetch recent trades for several wallets in batches, newest first, and report
 * how many wallet fetches failed. Callers MUST check `failedWallets`: an
 * all-failed poll returns zero trades, which looks identical to "nobody traded"
 * unless the failure is surfaced.
 */
export async function fetchTradesForWalletsDetailed(
  wallets: string[],
  perWallet = 15,
  maxWallets = DEFAULT_MAX_WALLETS,
): Promise<WalletTradesResult> {
  const unique = [...new Set(wallets.map((w) => w.toLowerCase()))]
    .filter(Boolean)
    .slice(0, Math.max(0, maxWallets));
  const all: TraderTrade[] = [];
  let okWallets = 0;
  let failedWallets = 0;
  let firstError: string | null = null;
  for (let i = 0; i < unique.length; i += REQUEST_CONCURRENCY) {
    const batch = unique.slice(i, i + REQUEST_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((w) => fetchUserTrades(w, perWallet)));
    for (const r of results) {
      if (r.status === "fulfilled") {
        okWallets += 1;
        all.push(...r.value);
      } else {
        failedWallets += 1;
        firstError ??= r.reason instanceof Error ? r.reason.message : String(r.reason);
      }
    }
  }
  return { trades: all.sort((a, b) => b.timestamp - a.timestamp), okWallets, failedWallets, firstError };
}

/** Fetch recent trades for several wallets in batches, newest first. */
export async function fetchTradesForWallets(
  wallets: string[],
  perWallet = 15,
  maxWallets = DEFAULT_MAX_WALLETS,
): Promise<TraderTrade[]> {
  return (await fetchTradesForWalletsDetailed(wallets, perWallet, maxWallets)).trades;
}
