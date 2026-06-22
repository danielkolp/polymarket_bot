import { fetchLiveUsdcBalance, type LiveUsdcBalance } from "./liveClob";

const LIVE_BALANCE_CACHE_TTL_MS = 5_000;

let cachedBalance: { balance: LiveUsdcBalance; cachedAt: number } | null = null;

export async function getLiveUsdcBalance(options: { forceRefresh?: boolean } = {}): Promise<LiveUsdcBalance> {
  const now = Date.now();
  if (
    !options.forceRefresh &&
    cachedBalance &&
    now - cachedBalance.cachedAt <= LIVE_BALANCE_CACHE_TTL_MS
  ) {
    return cachedBalance.balance;
  }

  const balance = await fetchLiveUsdcBalance();
  cachedBalance = { balance, cachedAt: now };
  return balance;
}

export function clearLiveBalanceCache(): void {
  cachedBalance = null;
}
