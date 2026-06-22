/**
 * liveExecutor — the synchronous Executor seam.
 *
 * Real-money execution now lives in `liveClob.ts` (async Polymarket CLOB market
 * orders), invoked directly from the bot loop's real-mode path. CLOB orders are
 * inherently asynchronous, so they do NOT flow through this synchronous
 * place()/cancel() interface — these methods stay intentionally inert and throw
 * if ever called. The SimExecutor remains the only Executor used by the engine.
 *
 * Live trading is still gated: config.enableRealTrading must be true AND a
 * signing key must be configured (see liveClob.assertLiveTradingAllowed).
 */
import type { Executor } from "./executor";
import { config } from "@/lib/config";
import type { OrderIntent, SimOrder } from "@/lib/sim/types";

export class RealTradingDisabledError extends Error {
  constructor(message = "Real trading is disabled. Bonk is simulation-only.") {
    super(message);
    this.name = "RealTradingDisabledError";
  }
}

function guard(confirmLiveTrading: boolean): never {
  if (!config.enableRealTrading) {
    throw new RealTradingDisabledError(
      "ENABLE_REAL_TRADING is false. Refusing to touch real money.",
    );
  }
  if (!confirmLiveTrading) {
    throw new RealTradingDisabledError(
      "Live trading requires an explicit confirmLiveTrading=true at the call site.",
    );
  }
  // Even with both guards passed, the synchronous seam is not the live path.
  throw new RealTradingDisabledError(
    "Synchronous live execution is not supported. Real orders go through liveClob.ts.",
  );
}

/**
 * Not a real Executor you can use — calling place/cancel always throws.
 * Typed loosely so it satisfies the seam without pretending to work.
 */
export const liveExecutor: Executor = {
  mode: "live",
  place(_intent: OrderIntent, _now: number): SimOrder {
    return guard(false);
  },
  cancel(_order: SimOrder, _now: number): SimOrder {
    return guard(false);
  },
};
