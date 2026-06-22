/**
 * EngineCtx is the mutable working state threaded through a single tick. The
 * engine seeds it from the persisted snapshot, the strategy / fills / portfolio
 * helpers mutate it, and the engine reads it back out at the end.
 */
import type { Executor } from "@/lib/execution/executor";
import type { RiskSettings, SimOrder, SimPosition, TradeLogEntry } from "./types";
import type { TokenView } from "./marketView";

export interface EngineCtx {
  now: number;
  settings: RiskSettings;
  executor: Executor;

  cash: number;
  positionsByToken: Map<string, SimPosition>;
  orders: SimOrder[]; // open/partial orders only
  newTrades: TradeLogEntry[]; // appended this tick (most recent last)
  wins: number;
  losses: number;

  views: Map<string, TokenView>; // tokenId -> view (only for markets in universe)
  priceHistory: Record<string, number[]>; // rolling mids per tracked token
}

let logSeq = 0;
export function logId(now: number): string {
  logSeq = (logSeq + 1) % 1_000_000;
  return `t_${now.toString(36)}_${logSeq.toString(36)}`;
}
