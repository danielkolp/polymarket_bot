/**
 * Copy-trading strategy. Mirrors the recent trades of followed leaderboard
 * traders into the paper portfolio.
 *
 * Realism choices:
 *  - We're LATE: by the time a trade shows in the public feed and we poll it, the
 *    price has moved. We fill at the trader's price worsened by `copySlippageBps`.
 *  - Fixed paper size per copied trade (`copyPerTradeUsd`), not the whale's size.
 *  - BUY trades open/add; SELL trades only reduce what we actually hold.
 *  - Exposure caps still apply; `lastCopiedTs` per wallet prevents re-copying.
 *
 * NOTE: leaderboard copy-trading has real pitfalls the sim will expose —
 * survivorship bias (you see winners after they've won) and adverse fills from
 * being late. That's exactly why we test it on paper first.
 */
import type { EngineCtx } from "../engineCtx";
import { nextOrderId } from "@/lib/execution/executor";
import { applyBuyFill, applySellFill, positionNotional, openOrderNotional } from "../portfolio";
import type { SimOrder } from "../types";
import type { TraderTrade } from "@/lib/polymarket/types";

function clampPrice(p: number): number {
  return Math.min(0.999, Math.max(0.001, p));
}

function pseudoOrder(ctx: EngineCtx, t: TraderTrade, price: number, size: number): SimOrder {
  return {
    id: nextOrderId(ctx.now),
    marketId: t.conditionId,
    marketQuestion: t.title,
    tokenId: t.tokenId,
    outcomeLabel: t.outcome || "—",
    side: t.side === "SELL" ? "sell" : "buy",
    price,
    size,
    postOnly: false,
    status: "filled",
    filledSize: size,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
}

function totalExposure(ctx: EngineCtx): number {
  let total = 0;
  for (const pos of ctx.positionsByToken.values()) total += positionNotional(pos);
  total += openOrderNotional(ctx.orders, "buy");
  return total;
}

/**
 * Mirror new trades from followed wallets. Returns the updated per-wallet
 * last-copied timestamp map.
 */
export function copyTrades(
  ctx: EngineCtx,
  trades: TraderTrade[],
  followed: Set<string>,
  lastCopiedTs: Record<string, number>,
): Record<string, number> {
  const s = ctx.settings;
  const nowSec = ctx.now / 1000;
  const recencyCutoff = nowSec - s.copyRecencyMinutes * 60;
  const next = { ...lastCopiedTs };
  const slip = s.copySlippageBps / 10_000;

  // Oldest first so the per-wallet watermark advances monotonically.
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);

  for (const t of sorted) {
    if (!followed.has(t.wallet)) continue;
    const watermark = next[t.wallet] ?? recencyCutoff;
    if (t.timestamp <= watermark) continue; // already copied (or before our window)
    next[t.wallet] = t.timestamp;
    if (t.timestamp < recencyCutoff) continue; // too stale to act on, but watermark advanced
    if (t.price <= 0 || !t.tokenId) continue;

    const note = `copy ${t.traderName}`;

    if (t.side === "BUY") {
      const price = clampPrice(t.price * (1 + slip));
      const size = s.copyPerTradeUsd / price;
      const pos = ctx.positionsByToken.get(t.tokenId);
      const marketCommitted = (pos ? positionNotional(pos) : 0) + s.copyPerTradeUsd;
      if (marketCommitted > s.maxExposurePerMarket) continue;
      if (totalExposure(ctx) + s.copyPerTradeUsd > s.maxTotalExposure) continue;
      applyBuyFill(ctx, pseudoOrder(ctx, t, price, size), price, size, note);
    } else {
      // SELL: only mirror an exit if we actually hold the token.
      const pos = ctx.positionsByToken.get(t.tokenId);
      if (!pos || pos.shares <= 0) continue;
      const price = clampPrice(t.price * (1 - slip));
      const size = Math.min(pos.shares, s.copyPerTradeUsd / price);
      applySellFill(ctx, pseudoOrder(ctx, t, price, size), price, size, note);
    }
  }

  return next;
}
