/**
 * Spread-capture / market-making strategy.
 *
 * For each eligible market (primary outcome token) we:
 *   - Rest a post-only BUY just inside the best bid to accumulate inventory
 *     cheaply, sized by orderSize and capped by exposure limits.
 *   - Once we hold inventory, rest a post-only SELL to exit for a profit at
 *     max(avg entry + takeProfitOffset, just inside best ask).
 *   - Replace quotes that have drifted from their target price.
 *
 * Risk gating (per-market + total exposure, max open orders) is enforced here
 * before any order is placed. Cancellation of stale orders and flatten-near-
 * resolution are handled by the engine.
 */
import type { EngineCtx } from "../engineCtx";
import type { TokenView } from "../marketView";
import { cancelOrder, openOrderNotional, positionNotional } from "../portfolio";
import { recordTrade } from "../portfolio";
import type { OrderIntent, OrderSide, SimOrder } from "../types";

const TICK = 0.001;
const DRIFT_TOLERANCE = 0.01; // replace a quote if it drifts more than 1 cent

function round(p: number): number {
  return Math.round(p / TICK) * TICK;
}

function clampPrice(p: number): number {
  return Math.min(0.999, Math.max(0.001, round(p)));
}

function findOpenOrder(ctx: EngineCtx, tokenId: string, side: OrderSide): SimOrder | undefined {
  return ctx.orders.find((o) => o.tokenId === tokenId && o.side === side);
}

function place(ctx: EngineCtx, intent: OrderIntent): void {
  const order = ctx.executor.place(intent, ctx.now);
  ctx.orders.push(order);
  recordTrade(ctx, {
    type: "place",
    side: intent.side,
    marketId: intent.marketId,
    marketQuestion: intent.marketQuestion,
    outcomeLabel: intent.outcomeLabel,
    price: intent.price,
    size: intent.size,
    message: `Posted ${intent.side} ${intent.size.toFixed(0)} @ ${(intent.price * 100).toFixed(1)}¢`,
  });
}

function totalCommittedExposure(ctx: EngineCtx): number {
  let total = 0;
  for (const pos of ctx.positionsByToken.values()) total += positionNotional(pos);
  total += openOrderNotional(ctx.orders, "buy");
  return total;
}

/**
 * Buy-low gate: only enter when the current mid is at/below its recent average.
 * This is the core "buy low, sell high" edge — we accumulate on dips and let the
 * take-profit / resting sell capture the rebound. Until enough history exists we
 * allow entry so the bot can start working.
 */
function priceIsLow(ctx: EngineCtx, tokenId: string, mid: number): boolean {
  const hist = ctx.priceHistory[tokenId];
  const lookback = Math.max(2, ctx.settings.dipLookback);
  if (!hist || hist.length < 3) return true; // not enough data yet — allow
  const window = hist.slice(-lookback);
  const avg = window.reduce((s, p) => s + p, 0) / window.length;
  return mid <= avg * (1 + ctx.settings.buyDipThreshold);
}

export function generateQuotes(ctx: EngineCtx, eligibleViews: TokenView[]): void {
  const s = ctx.settings;

  for (const view of eligibleViews) {
    if (view.bestBid == null || view.bestAsk == null || view.mid == null) continue;
    const pos = ctx.positionsByToken.get(view.tokenId);
    const inventory = pos?.shares ?? 0;

    // ---- BUY side: accumulate inventory --------------------------------
    const targetBuy = clampPrice(Math.min(view.bestBid + s.edgeOffset, view.bestAsk - TICK));
    const existingBuy = findOpenOrder(ctx, view.tokenId, "buy");

    if (existingBuy && Math.abs(existingBuy.price - targetBuy) > DRIFT_TOLERANCE) {
      cancelOrder(ctx, existingBuy, "re-quote (price drift)");
    }

    const stillHasBuy = !!findOpenOrder(ctx, view.tokenId, "buy");
    const marketCommitted =
      (pos ? positionNotional(pos) : 0) + openOrderNotional(ctx.orders, "buy", view.tokenId);
    const wantBuyNotional = s.orderSize;

    const underMarketCap = marketCommitted + wantBuyNotional <= s.maxExposurePerMarket;
    const underTotalCap = totalCommittedExposure(ctx) + wantBuyNotional <= s.maxTotalExposure;
    const underOrderCap = ctx.orders.length < s.maxOpenOrders;
    const buyingLow = priceIsLow(ctx, view.tokenId, view.mid);

    if (!stillHasBuy && buyingLow && underMarketCap && underTotalCap && underOrderCap && targetBuy > 0) {
      const size = wantBuyNotional / targetBuy;
      place(ctx, {
        marketId: view.marketId,
        marketQuestion: view.marketQuestion,
        tokenId: view.tokenId,
        outcomeLabel: view.outcomeLabel,
        side: "buy",
        price: targetBuy,
        size,
        postOnly: true,
      });
    }

    // ---- SELL side: exit inventory for profit --------------------------
    if (inventory > 0 && pos) {
      const profitTarget = pos.avgPrice + s.takeProfitOffset;
      const targetSell = clampPrice(Math.max(profitTarget, view.bestAsk - s.edgeOffset, view.bestBid + TICK));
      const existingSell = findOpenOrder(ctx, view.tokenId, "sell");

      if (existingSell && Math.abs(existingSell.price - targetSell) > DRIFT_TOLERANCE) {
        cancelOrder(ctx, existingSell, "re-quote (price drift)");
      }

      const stillHasSell = !!findOpenOrder(ctx, view.tokenId, "sell");
      if (!stillHasSell && ctx.orders.length < s.maxOpenOrders && targetSell < 1) {
        place(ctx, {
          marketId: view.marketId,
          marketQuestion: view.marketQuestion,
          tokenId: view.tokenId,
          outcomeLabel: view.outcomeLabel,
          side: "sell",
          price: targetSell,
          size: inventory,
          postOnly: true,
        });
      }
    }
  }
}
