/**
 * Pure BUY entry planner. Given the leader's fill, the OUTCOME-SPECIFIC book and
 * the market's CLOB parameters, decide whether a copy BUY is worth placing and
 * at what size / worst price:
 *
 *  1. Price cap: never pay more than `leaderPrice + maxAdverseEntryMoveCents`.
 *     The order is a FAK limit at that price, so it can never sweep a thin book.
 *  2. Cost check: what copying costs on top of the trader's own entry — the
 *     taker fee at the ask plus any premium paid over the trader's price — must
 *     stay under `maxEntryCostPercent`. (Exit liquidity is handled separately by
 *     the max-spread filter; positions held to resolution pay no exit fee.)
 *  3. Sellable size: the order must buy at least the market's minimum order
 *     size (usually 5 shares), otherwise the position could never be sold. If
 *     the strategy size is smaller, it is bumped up to the minimum — but only
 *     when every cap still allows it; otherwise the trade is skipped.
 */
import { minSellableBuyUsd, roundToTick, takerFeeFraction } from "@/lib/polymarket/clobMeta";

export interface EntryQuote {
  bestBid: number | null;
  bestAsk: number | null;
  midpoint: number | null;
}

export interface EntryMarketParams {
  minOrderSize: number;
  tickSize: number;
  feeRate: number;
  feeExponent: number;
}

export interface EntryPlanInput {
  leaderPrice: number;
  quote: EntryQuote | null;
  params: EntryMarketParams;
  /** Strategy size after the usual caps (USD). */
  requestedUsd: number;
  /** The largest order every cap/reserve still allows (USD). */
  maxAllowedUsd: number;
  /** Which limit sets maxAllowedUsd, for skip messages (e.g. "per-market cap"). */
  limitedBy?: string;
  maxAdverseEntryMoveCents: number;
  maxEntryCostPercent: number;
}

export type EntryPlan =
  | {
      ok: true;
      usd: number;
      limitPrice: number;
      bestAsk: number;
      /** Taker fee + premium over the trader's price, as a fraction of the ask (0.03 = 3%). */
      entryCostFraction: number;
      feeFraction: number;
      bumpedToMinimum: boolean;
      minimumUsd: number;
    }
  | { ok: false; reason: string };

const cents = (p: number) => (p * 100).toFixed(1) + "c";

export function planEntry(input: EntryPlanInput): EntryPlan {
  const { quote, params } = input;
  const ask = quote?.bestAsk ?? null;
  if (ask == null || !(ask > 0) || ask >= 1) {
    return { ok: false, reason: "Skipped BUY: no sellers in this outcome's order book right now." };
  }

  const tick = params.tickSize > 0 ? params.tickSize : 0.01;
  const adverse = Math.max(0, input.maxAdverseEntryMoveCents) / 100;
  // Worst price we'll pay: the leader's price plus the allowed chase, but never
  // below the current ask (otherwise nothing could fill) — the adverse check
  // below rejects asks that are already past the cap.
  const capPrice = adverse > 0 ? input.leaderPrice + adverse : ask + 2 * tick;
  if (ask > capPrice + 1e-9) {
    return {
      ok: false,
      reason: `Skipped BUY: price already moved to ${cents(ask)}, more than ${(adverse * 100).toFixed(0)}c above the trader's ${cents(input.leaderPrice)}.`,
    };
  }
  const limitPrice = roundToTick(Math.max(ask, capPrice), tick, "down");

  // Extra cost of copying vs. the trader's own fill: Polymarket's taker fee at
  // the price we pay plus whatever we pay above the trader's price. (The old
  // half-spread term double-counted the adverse cap and rejected nearly every
  // 20-50c entry once fees were added.)
  const premiumFraction = ask > input.leaderPrice ? (ask - input.leaderPrice) / ask : 0;
  const feeFraction = takerFeeFraction(params, ask);
  const entryCostFraction = premiumFraction + feeFraction;
  if (input.maxEntryCostPercent > 0 && entryCostFraction * 100 > input.maxEntryCostPercent + 1e-9) {
    return {
      ok: false,
      reason: `Skipped BUY: too costly to copy — fee ${(feeFraction * 100).toFixed(1)}% + ${(premiumFraction * 100).toFixed(1)}% above the trader's price is over the ${input.maxEntryCostPercent}% limit.`,
    };
  }

  const minimumUsd = minSellableBuyUsd(params.minOrderSize, limitPrice);
  const maxAllowed = Math.floor(Math.max(0, input.maxAllowedUsd) * 100) / 100;
  let usd = Math.floor(Math.max(0, input.requestedUsd) * 100) / 100;
  let bumpedToMinimum = false;
  if (usd < minimumUsd) {
    if (minimumUsd <= maxAllowed) {
      usd = minimumUsd;
      bumpedToMinimum = true;
    } else {
      return {
        ok: false,
        reason: `Skipped BUY: this market needs at least $${minimumUsd.toFixed(2)} (${params.minOrderSize} shares minimum) but your limits allow $${maxAllowed.toFixed(2)} right now${input.limitedBy ? ` (${input.limitedBy})` : ""}.`,
      };
    }
  }
  usd = Math.min(usd, maxAllowed);
  if (usd < minimumUsd) {
    return {
      ok: false,
      reason: `Skipped BUY: your limits allow $${maxAllowed.toFixed(2)}${input.limitedBy ? ` (${input.limitedBy})` : ""}, below this market's $${minimumUsd.toFixed(2)} minimum.`,
    };
  }

  return { ok: true, usd, limitPrice, bestAsk: ask, entryCostFraction, feeFraction, bumpedToMinimum, minimumUsd };
}

/**
 * Shares to sell when copying a leader's partial exit: the same FRACTION of our
 * position that the leader sold of theirs. If the remainder would be below the
 * market minimum (unsellable dust), sell everything instead.
 */
export function proportionalSellShares(opts: {
  heldShares: number;
  leaderSoldShares: number;
  /** Leader's position size BEFORE this sale, when known. */
  leaderSharesBefore: number | null;
  minOrderSize: number;
}): number {
  const { heldShares, leaderSoldShares, leaderSharesBefore, minOrderSize } = opts;
  if (!(heldShares > 0)) return 0;
  if (!(leaderSharesBefore && leaderSharesBefore > 0) || !(leaderSoldShares > 0)) return heldShares;
  const fraction = Math.min(1, leaderSoldShares / leaderSharesBefore);
  if (fraction >= 0.95) return heldShares;
  const shares = heldShares * fraction;
  const remainder = heldShares - shares;
  const min = Math.max(1, minOrderSize);
  if (shares < min || remainder < min) return heldShares;
  return Math.floor(shares * 100) / 100;
}
