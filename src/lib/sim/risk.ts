/**
 * Risk controls. Eligibility gating for new quotes plus helpers used by the
 * engine for the no-trade window and global halt conditions.
 */
import type { RiskSettings } from "./types";
import type { TokenView } from "./marketView";
import { ageSeconds } from "@/lib/time";

export interface Eligibility {
  eligible: boolean;
  reason: string;
}

export function inNoTradeWindow(view: TokenView, settings: RiskSettings): boolean {
  if (view.timeToResolutionMs == null) return false;
  return view.timeToResolutionMs <= settings.noTradeWindowMinutes * 60_000;
}

export function isDataStale(view: TokenView, settings: RiskSettings, now: number): boolean {
  return ageSeconds(view.fetchedAt, now) > settings.staleDataTimeoutSec;
}

/** Can we open / maintain quotes on this market right now? */
export function evaluateEligibility(
  view: TokenView,
  settings: RiskSettings,
  now: number,
): Eligibility {
  if (!view.active) return { eligible: false, reason: "market inactive" };
  if (!view.acceptingOrders) return { eligible: false, reason: "not accepting orders" };
  if (view.bestBid == null || view.bestAsk == null) return { eligible: false, reason: "no two-sided market" };
  if (view.mid == null) return { eligible: false, reason: "no mid price" };
  if (view.liquidity < settings.minLiquidity) return { eligible: false, reason: "below min liquidity" };
  if (view.spread == null || view.spread < settings.minSpread) return { eligible: false, reason: "spread too tight" };
  if (isDataStale(view, settings, now)) return { eligible: false, reason: "stale data" };
  if (inNoTradeWindow(view, settings)) return { eligible: false, reason: "near resolution" };
  return { eligible: true, reason: "eligible" };
}

/** Global halt: true once the day's loss meets/exceeds the configured limit. */
export function dailyLossBreached(dailyPnl: number, settings: RiskSettings): boolean {
  return dailyPnl <= -Math.abs(settings.maxDailyLoss);
}
