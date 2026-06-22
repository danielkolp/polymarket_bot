/**
 * SimExecutor — the default, always-active executor. Pure paper trading: it
 * just builds order records. Fills are produced separately by the fill model
 * (src/lib/sim/fills.ts) from real polled order-book movement, which in a live
 * system would instead come from exchange fill events via reconcile().
 */
import type { Executor, } from "./executor";
import { nextOrderId } from "./executor";
import type { OrderIntent, SimOrder } from "@/lib/sim/types";

export const simExecutor: Executor = {
  mode: "sim",

  place(intent: OrderIntent, now: number): SimOrder {
    return {
      ...intent,
      id: nextOrderId(now),
      status: "open",
      filledSize: 0,
      createdAt: now,
      updatedAt: now,
    };
  },

  cancel(order: SimOrder, now: number): SimOrder {
    return { ...order, status: "cancelled", updatedAt: now };
  },
};
