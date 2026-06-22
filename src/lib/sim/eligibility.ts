/**
 * Quick eligibility check using Gamma market fields (no order book required).
 * Used by the scanner + strategy-status display. The engine does a stricter
 * book-aware check in risk.ts when actually quoting.
 */
import type { Market } from "@/lib/polymarket/types";
import type { RiskSettings } from "./types";

export function isMarketEligible(m: Market, s: RiskSettings): boolean {
  return (
    m.active &&
    m.acceptingOrders &&
    m.bestBid != null &&
    m.bestAsk != null &&
    m.liquidity >= s.minLiquidity &&
    m.spread >= s.minSpread &&
    !(m.timeToResolutionMs != null && m.timeToResolutionMs <= s.noTradeWindowMinutes * 60_000)
  );
}
