/**
 * Portfolio mutations: apply fills, maintain positions/cash, record trade-log
 * entries. All functions mutate the EngineCtx in place.
 */
import type { EngineCtx } from "./engineCtx";
import { logId } from "./engineCtx";
import type { OrderSide, SimOrder, SimPosition, TradeLogEntry, TradeType } from "./types";

export function recordTrade(ctx: EngineCtx, entry: Omit<TradeLogEntry, "id" | "ts">): void {
  ctx.newTrades.push({ id: logId(ctx.now), ts: ctx.now, ...entry });
}

function ensurePosition(ctx: EngineCtx, order: SimOrder): SimPosition {
  let pos = ctx.positionsByToken.get(order.tokenId);
  if (!pos) {
    pos = {
      marketId: order.marketId,
      marketQuestion: order.marketQuestion,
      tokenId: order.tokenId,
      outcomeLabel: order.outcomeLabel,
      shares: 0,
      avgPrice: 0,
      realizedPnl: 0,
      markPrice: order.price,
      updatedAt: ctx.now,
    };
    ctx.positionsByToken.set(order.tokenId, pos);
  }
  return pos;
}

/** Apply a buy fill: spend cash, increase shares, update avg entry. */
export function applyBuyFill(ctx: EngineCtx, order: SimOrder, price: number, size: number, note?: string): void {
  if (size <= 0) return;
  const pos = ensurePosition(ctx, order);
  const cost = price * size;
  const fee = (cost * (ctx.settings.feeBps ?? 0)) / 10_000;
  ctx.cash -= cost + fee;
  const newShares = pos.shares + size;
  pos.avgPrice = newShares > 0 ? (pos.avgPrice * pos.shares + cost) / newShares : price;
  pos.shares = newShares;
  pos.markPrice = price;
  pos.updatedAt = ctx.now;

  recordTrade(ctx, {
    type: "fill",
    side: "buy",
    marketId: order.marketId,
    marketQuestion: order.marketQuestion,
    outcomeLabel: order.outcomeLabel,
    price,
    size,
    message: `Bought ${size.toFixed(0)} ${order.outcomeLabel} @ ${(price * 100).toFixed(1)}¢${note ? ` · ${note}` : ""}`,
  });
}

/** Apply a sell fill: receive cash, reduce shares, realize pnl. */
export function applySellFill(ctx: EngineCtx, order: SimOrder, price: number, size: number, note?: string): void {
  const pos = ctx.positionsByToken.get(order.tokenId);
  if (!pos || pos.shares <= 0 || size <= 0) return;
  const sold = Math.min(size, pos.shares);
  const proceeds = price * sold;
  const fee = (proceeds * (ctx.settings.feeBps ?? 0)) / 10_000;
  const pnl = (price - pos.avgPrice) * sold - fee;
  ctx.cash += proceeds - fee;
  pos.shares -= sold;
  pos.realizedPnl += pnl;
  pos.markPrice = price;
  pos.updatedAt = ctx.now;

  if (pnl >= 0) ctx.wins += 1;
  else ctx.losses += 1;

  recordTrade(ctx, {
    type: "fill",
    side: "sell",
    marketId: order.marketId,
    marketQuestion: order.marketQuestion,
    outcomeLabel: order.outcomeLabel,
    price,
    size: sold,
    pnl,
    message: `Sold ${sold.toFixed(0)} ${order.outcomeLabel} @ ${(price * 100).toFixed(1)}¢ (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})${note ? ` · ${note}` : ""}`,
  });

  if (pos.shares <= 1e-6) ctx.positionsByToken.delete(order.tokenId);
}

/** Market-exit an entire position at `mid` (used for flatten / risk halt). */
export function flattenPosition(
  ctx: EngineCtx,
  tokenId: string,
  mid: number,
  reason: string,
): void {
  const pos = ctx.positionsByToken.get(tokenId);
  if (!pos || pos.shares <= 0) return;
  const size = pos.shares;
  const proceeds = mid * size;
  const fee = (proceeds * (ctx.settings.feeBps ?? 0)) / 10_000;
  const pnl = (mid - pos.avgPrice) * size - fee;
  ctx.cash += proceeds - fee;
  pos.realizedPnl += pnl;
  if (pnl >= 0) ctx.wins += 1;
  else ctx.losses += 1;

  recordTrade(ctx, {
    type: "flatten",
    side: "sell",
    marketId: pos.marketId,
    marketQuestion: pos.marketQuestion,
    outcomeLabel: pos.outcomeLabel,
    price: mid,
    size,
    pnl,
    message: `Flattened ${size.toFixed(0)} ${pos.outcomeLabel} @ ${(mid * 100).toFixed(1)}¢ — ${reason}`,
  });

  ctx.positionsByToken.delete(tokenId);
}

/** Cancel an order (via executor) and drop it from the working list. */
export function cancelOrder(ctx: EngineCtx, order: SimOrder, reason: string): void {
  const cancelled = ctx.executor.cancel(order, ctx.now);
  ctx.orders = ctx.orders.filter((o) => o.id !== order.id);
  recordTrade(ctx, {
    type: "cancel",
    side: cancelled.side,
    marketId: cancelled.marketId,
    marketQuestion: cancelled.marketQuestion,
    outcomeLabel: cancelled.outcomeLabel,
    price: cancelled.price,
    size: cancelled.size - cancelled.filledSize,
    message: `Cancelled ${cancelled.side} @ ${(cancelled.price * 100).toFixed(1)}¢ — ${reason}`,
  });
}

export function positionNotional(pos: SimPosition): number {
  return pos.shares * pos.markPrice;
}

export function openOrderNotional(orders: SimOrder[], side: OrderSide, tokenId?: string): number {
  return orders
    .filter((o) => o.side === side && (tokenId ? o.tokenId === tokenId : true))
    .reduce((s, o) => s + (o.size - o.filledSize) * o.price, 0);
}

export type { TradeType };
