"use client";

import { useEffect, useRef } from "react";
import { useSimStore } from "@/lib/sim/store";
import type { Market, OrderBook, TraderTrade } from "@/lib/polymarket/types";

/**
 * Drives the engine tick on an interval while the sim is running. Inputs are
 * held in a ref so changing market/book/trade data doesn't reset the timer.
 */
export function useSimTick(
  markets: Market[],
  booksByToken: Record<string, OrderBook>,
  traderTrades: TraderTrade[] = [],
) {
  const running = useSimStore((s) => s.running);
  const intervalSec = useSimStore((s) => s.settings.tickIntervalSec);
  const tick = useSimStore((s) => s.tick);

  const inputsRef = useRef({ markets, booksByToken, traderTrades });
  inputsRef.current = { markets, booksByToken, traderTrades };

  useEffect(() => {
    if (!running) return;
    const ms = Math.max(1000, intervalSec * 1000);
    const fire = () =>
      tick({
        markets: inputsRef.current.markets,
        booksByToken: inputsRef.current.booksByToken,
        traderTrades: inputsRef.current.traderTrades,
      });
    fire(); // immediate tick so the UI reacts without waiting a full interval
    const id = setInterval(fire, ms);
    return () => clearInterval(id);
  }, [running, intervalSec, tick]);
}
