/**
 * Pure entry-edge guards for copied BUYs.
 *
 * These protect the copy strategy from two failure modes the leader doesn't
 * suffer: (1) buying *after* the price has already moved (adverse entry), and
 * (2) acting on a stale signal. Both are pure (no I/O) so they can be unit-tested
 * exhaustively and reused by the engine and any route.
 */
import type { Market, TraderTrade } from "@/lib/polymarket/types";
import type { BotSettings } from "./types";

/** Hard absolute ceiling on copyable trade age (engine-enforced, 5 minutes). */
export const MAX_COPY_TRADE_AGE_SEC = 300;

function validPrice(p: number | null | undefined): number | null {
  return typeof p === "number" && Number.isFinite(p) && p > 0 && p < 1 ? p : null;
}

/**
 * Current executable BUY price for the token: prefer the live best ask, then the
 * midpoint. Returns null when neither is a valid (0,1) price — callers treat that
 * as "cannot evaluate" rather than guessing a price.
 */
export function currentExecutableAsk(market: Market | null): number | null {
  if (!market) return null;
  return validPrice(market.bestAsk) ?? validPrice(market.midpoint);
}

/**
 * Effective maximum copyable trade age (seconds) for a side+mode. The hard 5-min
 * cap always applies; real-mode BUYs additionally honour the stricter live
 * freshness window (`liveMaxCopyTradeAgeSec`). SELLs keep the looser window so
 * the bot can still react to a leader's exit; simulation stays loose for stress
 * testing.
 */
export function effectiveMaxCopyAgeSec(settings: BotSettings, side: TraderTrade["side"]): number {
  const absolute = Math.min(settings.maxTradeAgeSec, MAX_COPY_TRADE_AGE_SEC);
  if (settings.mode === "real" && side === "BUY") {
    return Math.max(1, Math.min(absolute, settings.liveMaxCopyTradeAgeSec));
  }
  return absolute;
}

export interface AdverseEntry {
  /** Leader's original trade price, 0..1 (or null if unusable). */
  leaderPrice: number | null;
  /** Current executable ask, 0..1 (or null if unusable). */
  botExecPrice: number | null;
  /** botExecPrice − leaderPrice in cents (null when either price is unusable). */
  adverseMoveCents: number | null;
  /** Non-null skip reason when the gate trips; null when the BUY may proceed. */
  reason: string | null;
}

/**
 * Adverse-entry gate. Compares the leader's original BUY price to the bot's
 * current executable ask. It trips (returns a reason) ONLY when both prices are
 * valid AND the ask is more than `maxAdverseEntryMoveCents` above the leader's
 * price — i.e. the price already ran away and we'd be chasing the move. Missing
 * or invalid prices never trip it (other gates handle unverifiable data), and a
 * non-positive cap disables it. Always returns the computed edge metrics so the
 * caller can record them on the trade for dashboard visibility.
 */
export function evaluateAdverseEntry(
  settings: Pick<BotSettings, "maxAdverseEntryMoveCents">,
  trade: Pick<TraderTrade, "price">,
  market: Market | null,
): AdverseEntry {
  const leaderPrice = validPrice(trade.price);
  const botExecPrice = currentExecutableAsk(market);
  const adverseMoveCents =
    leaderPrice != null && botExecPrice != null ? (botExecPrice - leaderPrice) * 100 : null;
  const base: AdverseEntry = { leaderPrice, botExecPrice, adverseMoveCents, reason: null };

  const cap = settings.maxAdverseEntryMoveCents;
  if (!(cap > 0)) return base;
  if (leaderPrice == null || botExecPrice == null) return base;
  if (botExecPrice > leaderPrice + cap / 100 + 1e-9) {
    const moveC = (botExecPrice - leaderPrice) * 100;
    return {
      ...base,
      reason:
        `Skipped BUY: current ask ${(botExecPrice * 100).toFixed(1)}c is ${moveC.toFixed(1)}c worse ` +
        `than leader fill ${(leaderPrice * 100).toFixed(1)}c (max ${cap.toFixed(1)}c).`,
    };
  }
  return base;
}
