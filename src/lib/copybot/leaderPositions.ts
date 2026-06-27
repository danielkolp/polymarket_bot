/**
 * Leader-holdings reconciliation (pure).
 *
 * The bot copies trade *events*, but a leader can exit a position via a trade the
 * bot never sees (outside the poll/age window). To avoid holding a bag after the
 * leader has left, we periodically fetch each followed leader's current positions
 * and check whether the source leader(s) of each copied position still hold the
 * token. This module is pure: the engine does the fetching and the (gated) sale.
 *
 * Invariants:
 *  - a position is "no" (leader exited) ONLY when we positively fetched data for
 *    at least one of its source wallets and none of them still holds the token;
 *  - a fetch failure is "unknown" (never "no") so an API blip can't trigger a sale;
 *  - manual/unknown positions (no source wallet) are always "unknown" and are
 *    never selected for a leader-exit sale.
 */
import type { AccountPosition } from "@/lib/polymarket/positions";
import type { BotPosition, LeaderHoldStatus } from "./types";

const DUST = 1e-6;

/**
 * Map of leader wallet (lowercased) → set of tokenIds currently held, or null
 * when that wallet's positions could not be fetched (no data, not "exited").
 */
export type LeaderHoldings = Map<string, Set<string> | null>;

/** Build a holdings map from per-wallet fetch results (null positions = failed fetch). */
export function buildLeaderHoldings(
  results: { wallet: string; positions: AccountPosition[] | null }[],
): LeaderHoldings {
  const map: LeaderHoldings = new Map();
  for (const { wallet, positions } of results) {
    const key = wallet.toLowerCase();
    if (positions == null) {
      map.set(key, null);
      continue;
    }
    const set = new Set<string>();
    for (const p of positions) if (p.size > DUST) set.add(p.tokenId);
    map.set(key, set);
  }
  return map;
}

/**
 * Whether a position's source leader(s) still hold its token.
 *  - "yes": at least one source wallet (we have data for) still holds it.
 *  - "no":  we have data for ≥1 source wallet and none of those holds it.
 *  - "unknown": no source wallets, or no fetched data for any of them.
 */
export function leaderHoldStatus(position: BotPosition, holdings: LeaderHoldings): LeaderHoldStatus {
  const wallets = position.sourceWallets.map((w) => w.toLowerCase()).filter(Boolean);
  if (wallets.length === 0) return "unknown";
  let haveData = false;
  for (const w of wallets) {
    const set = holdings.get(w);
    if (set == null) continue; // undefined (not fetched) or null (fetch failed)
    haveData = true;
    if (set.has(position.tokenId)) return "yes";
  }
  return haveData ? "no" : "unknown";
}

/** Annotate positions with leaderHolds + leaderCheckedAt from fetched holdings. */
export function reconcileLeaderHoldings(
  positions: BotPosition[],
  holdings: LeaderHoldings,
  now = Date.now(),
): BotPosition[] {
  return positions.map((p) => ({
    ...p,
    leaderHolds: leaderHoldStatus(p, holdings),
    leaderCheckedAt: now,
  }));
}

/**
 * Positions eligible for a leader-exit sale: bot-opened (≥1 source wallet) AND
 * confirmed leaderHolds === "no". Manual/unknown positions are never included.
 * Pure selection — the caller performs the actual (mode-gated) sale.
 */
export function selectLeaderExitedPositions(positions: BotPosition[]): BotPosition[] {
  return positions.filter(
    (p) => p.shares > DUST && p.sourceWallets.length > 0 && p.leaderHolds === "no",
  );
}

/** Unique, lowercased source wallets across the given (bot-opened) positions. */
export function sourceWalletsOf(positions: BotPosition[]): string[] {
  const set = new Set<string>();
  for (const p of positions) {
    for (const w of p.sourceWallets) {
      const lw = w.trim().toLowerCase();
      if (lw) set.add(lw);
    }
  }
  return [...set];
}
