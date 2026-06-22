/**
 * Fill model. Resting (post-only/maker) orders fill when *real* order-book or
 * price movement crosses them:
 *
 *   - A BUY at price p fills when the best ask drops to <= p (sellers cross our
 *     bid) or the last trade prints at/below p. As a maker we fill at our limit
 *     price p. Fill size is scaled by the size available at/below p × fillRatio.
 *   - A SELL at price q fills when the best bid rises to >= q or the last trade
 *     prints at/above q. Fill size scaled by size at/above q × fillRatio.
 *
 * When no live book is present we fall back to a lighter model driven by last
 * trade / midpoint crossing with a nominal captured size. This is deliberately
 * "realistic enough" — a working sim beats a perfect one.
 */
import type { EngineCtx } from "./engineCtx";
import { applyBuyFill, applySellFill } from "./portfolio";
import { askSizeAtOrBelow, bidSizeAtOrAbove, type TokenView } from "./marketView";
import type { SimOrder } from "./types";

function fillBuy(ctx: EngineCtx, order: SimOrder, view: TokenView): number {
  const remaining = order.size - order.filledSize;
  if (remaining <= 0) return 0;

  const crossedByBook = view.bestAsk != null && view.bestAsk <= order.price + 1e-9;
  const crossedByPrint = view.last != null && view.last <= order.price + 1e-9;
  if (!crossedByBook && !crossedByPrint) return 0;

  let available: number;
  if (view.hasBook) {
    available = askSizeAtOrBelow(view, order.price);
  } else {
    // No book: assume a modest amount changes hands at the print.
    available = remaining; // allow up to remaining, then scale by fillRatio
  }

  const size = Math.min(remaining, available * ctx.settings.fillRatio);
  if (size <= 1e-6) return 0;
  applyBuyFill(ctx, order, order.price, size);
  return size;
}

function fillSell(ctx: EngineCtx, order: SimOrder, view: TokenView): number {
  const remaining = order.size - order.filledSize;
  if (remaining <= 0) return 0;

  const crossedByBook = view.bestBid != null && view.bestBid >= order.price - 1e-9;
  const crossedByPrint = view.last != null && view.last >= order.price - 1e-9;
  if (!crossedByBook && !crossedByPrint) return 0;

  let available: number;
  if (view.hasBook) {
    available = bidSizeAtOrAbove(view, order.price);
  } else {
    available = remaining;
  }

  const size = Math.min(remaining, available * ctx.settings.fillRatio);
  if (size <= 1e-6) return 0;
  applySellFill(ctx, order, order.price, size);
  return size;
}

/** Walk all open orders, apply any fills, and update order status. */
export function simulateFills(ctx: EngineCtx): void {
  for (const order of ctx.orders) {
    if (order.status !== "open" && order.status !== "partial") continue;
    const view = ctx.views.get(order.tokenId);
    if (!view) continue;

    const filled = order.side === "buy" ? fillBuy(ctx, order, view) : fillSell(ctx, order, view);
    if (filled > 0) {
      order.filledSize += filled;
      order.updatedAt = ctx.now;
      order.status = order.filledSize >= order.size - 1e-6 ? "filled" : "partial";
    }
  }
  // Drop fully-filled orders from the working list (they live on in the log).
  ctx.orders = ctx.orders.filter((o) => o.status === "open" || o.status === "partial");
}
