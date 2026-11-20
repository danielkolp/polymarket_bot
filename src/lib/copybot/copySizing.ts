/**
 * Pure sizing helpers for copied orders.
 */

/**
 * Fraction of their position the leader just sold (0..1), from the SELL size and
 * the leader's remaining holding after it. Returns null when unknown.
 *
 * The old "proportional" mode sold `strategy USD / price` shares, which had no
 * relation to what the leader did: a leader dumping 100% only triggered a ~2%
 * sale, while a leader trimming 5% could trigger a large one.
 */
export function leaderSellFraction(soldShares: number, leaderRemainingShares: number | null): number | null {
  if (!(soldShares > 0) || leaderRemainingShares == null || !Number.isFinite(leaderRemainingShares)) return null;
  const remaining = Math.max(0, leaderRemainingShares);
  const fraction = soldShares / (soldShares + remaining);
  return Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null;
}

/**
 * Shares to sell for a copied SELL. Sells everything when the leader (nearly)
 * fully exited, when the fraction is unknown (exit with the leader rather than
 * guess), or when the leftover would be dust worth less than `minRemainderUsd`.
 */
export function copySellShares(opts: {
  heldShares: number;
  fraction: number | null;
  price: number;
  minRemainderUsd: number;
  fullExitThreshold?: number;
}): { shares: number; full: boolean } {
  const { heldShares, fraction, price, minRemainderUsd } = opts;
  const fullExitThreshold = opts.fullExitThreshold ?? 0.9;
  if (!(heldShares > 0)) return { shares: 0, full: false };
  if (fraction == null || fraction >= fullExitThreshold) return { shares: heldShares, full: true };
  const shares = heldShares * fraction;
  const remainderUsd = (heldShares - shares) * Math.max(0, price);
  if (remainderUsd < minRemainderUsd) return { shares: heldShares, full: true };
  return { shares, full: false };
}

/**
 * Polymarket rejects market BUYs under $1. Small accounts (≈2% of $50 = $1)
 * constantly land just under it. Bump a positive request up to the exchange
 * minimum; the caller's normal cap checks then run on the BUMPED amount, so a
 * bump that would breach a cap is skipped rather than silently placed.
 */
export function bumpToExchangeMinimum(requestedUsd: number, exchangeMinUsd: number): { amountUsd: number; bumped: boolean } {
  if (!(requestedUsd > 0) || !(exchangeMinUsd > 0) || requestedUsd >= exchangeMinUsd) {
    return { amountUsd: requestedUsd, bumped: false };
  }
  return { amountUsd: exchangeMinUsd, bumped: true };
}
