/**
 * Execution seam.
 *
 * The strategy engine never talks to an exchange (or the fill model) directly.
 * It emits *intents* to an `Executor`. Today the only active implementation is
 * the SimExecutor (pure paper trading). The LiveExecutor is a deliberately
 * inert, guarded stub that marks exactly where real-money execution would plug
 * in later — see liveExecutor.ts.
 *
 * This indirection is the single place you would flip from paper to live, and
 * it is intentionally OFF.
 */
import type { OrderIntent, SimOrder } from "@/lib/sim/types";

export interface Executor {
  readonly mode: "sim" | "live";
  /** Create/submit a resting order from an intent. */
  place(intent: OrderIntent, now: number): SimOrder;
  /** Cancel a resting order; returns the updated (cancelled) record. */
  cancel(order: SimOrder, now: number): SimOrder;
}

let idCounter = 0;
export function nextOrderId(now = Date.now()): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `ord_${now.toString(36)}_${idCounter.toString(36)}`;
}
