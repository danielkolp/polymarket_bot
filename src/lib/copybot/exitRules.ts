/**
 * Pure exit-rule evaluation shared by simulation and real mode.
 *
 * Previously take-profit / stop-loss / max-hold only ran during a *running*
 * session in real mode (and only during "drain" in simulation), so simulated
 * results never reflected how the live bot would actually exit. Both modes now
 * evaluate the same rules every poll.
 */
import { clampPrice } from "./accounting";
import type { BotPosition, BotSettings } from "./types";

export type ExitRuleSettings = Pick<
  BotSettings,
  "autoExitTakeProfitPercent" | "autoExitStopLossPercent" | "autoExitMaxHoldMinutes" | "autoExitTrailingStopPercent"
>;

export function anyExitRuleEnabled(settings: ExitRuleSettings): boolean {
  return (
    settings.autoExitTakeProfitPercent > 0 ||
    settings.autoExitStopLossPercent > 0 ||
    settings.autoExitMaxHoldMinutes > 0 ||
    (settings.autoExitTrailingStopPercent ?? 0) > 0
  );
}

/** Highest mark seen since entry (falls back to entry price / current mark). */
export function positionPeakPrice(position: Pick<BotPosition, "peakMarkPrice" | "avgPrice" | "markPrice">): number {
  return Math.max(position.peakMarkPrice ?? 0, position.avgPrice, position.markPrice);
}

/** Track the running peak mark so the trailing stop can measure the giveback. */
export function withUpdatedPeak<T extends BotPosition>(position: T): T {
  const peak = positionPeakPrice(position);
  return peak === position.peakMarkPrice ? position : { ...position, peakMarkPrice: peak };
}

/**
 * Returns a human-readable exit reason when a rule fires, else null.
 *
 * Trailing stop: once a position has traded ABOVE its entry, exit if the mark
 * gives back `autoExitTrailingStopPercent` of the peak price. It never fires on
 * a position that was never in profit — that's the stop-loss's job — so it
 * locks in gains without acting as a second, tighter stop.
 */
export function evaluateAutoExit(position: BotPosition, settings: ExitRuleSettings, now: number): string | null {
  if (position.shares <= 0) return null;
  const price = clampPrice(position.markPrice);
  const costBasis = position.avgPrice * position.shares;
  const pnlPct = costBasis > 0 ? ((price - position.avgPrice) * position.shares * 100) / costBasis : 0;

  const tp = settings.autoExitTakeProfitPercent;
  const sl = settings.autoExitStopLossPercent;
  const trail = settings.autoExitTrailingStopPercent ?? 0;
  const maxHoldMs = settings.autoExitMaxHoldMinutes * 60 * 1000;

  if (tp > 0 && pnlPct >= tp) return `take-profit ${pnlPct.toFixed(1)}% >= ${tp}%`;
  if (sl > 0 && pnlPct <= -sl) return `stop-loss ${pnlPct.toFixed(1)}% <= -${sl}%`;
  if (trail > 0) {
    const peak = positionPeakPrice(position);
    if (peak > position.avgPrice + 1e-9 && peak > 0) {
      const givebackPct = ((peak - price) / peak) * 100;
      if (givebackPct >= trail) {
        return `trailing-stop: ${(price * 100).toFixed(1)}c is ${givebackPct.toFixed(1)}% below peak ${(peak * 100).toFixed(1)}c (trail ${trail}%)`;
      }
    }
  }
  const heldMs = now - position.openedAt;
  if (maxHoldMs > 0 && heldMs >= maxHoldMs) {
    return `max-hold ${Math.floor(heldMs / 60000)}m >= ${settings.autoExitMaxHoldMinutes}m`;
  }
  return null;
}
