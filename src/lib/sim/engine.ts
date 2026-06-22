/**
 * Strategy engine — one deterministic tick.
 *
 * Pipeline per tick:
 *   1. Build per-token views from the market universe + polled books.
 *   2. Simulate fills on resting orders from real book/price movement.
 *   3. Flatten positions inside the no-trade window near resolution.
 *   4. Mark to market; check the daily-loss halt (cancel + flatten if breached).
 *   5. If running, strategy enabled, and not halted: cancel stale / ineligible
 *      orders, then generate fresh spread-capture quotes within risk limits.
 *   6. Recompute metrics, append an equity point, and refresh the watch list.
 *
 * Pure-ish: takes the previous snapshot + inputs, returns the next snapshot.
 */
import type { Market, OrderBook, TraderTrade } from "@/lib/polymarket/types";
import { simExecutor } from "@/lib/execution/simExecutor";
import { buildTokenView, buildViewFromBook, type TokenView } from "./marketView";
import { simulateFills } from "./fills";
import { markPositions, computeMetrics } from "./metrics";
import { cancelOrder, flattenPosition } from "./portfolio";
import { generateQuotes } from "./strategy/spreadCapture";
import { copyTrades } from "./strategy/copyTrade";
import { dailyLossBreached, evaluateEligibility, inNoTradeWindow } from "./risk";
import { recordTrade } from "./portfolio";
import { logId, type EngineCtx } from "./engineCtx";
import type { EquityPoint, SimOrder, SimPosition, SimSnapshot, TradeLogEntry } from "./types";

export interface EngineInputs {
  now: number;
  markets: Market[];
  booksByToken: Record<string, OrderBook>;
  /** Recent trades from followed traders (copy-trading mode). */
  traderTrades?: TraderTrade[];
}

const MAX_TRADES = 500;
const MAX_EQUITY_POINTS = 600;
const MAX_WATCH = 30;
const MAX_PRICE_POINTS = 60;

function attractiveness(v: TokenView): number {
  return (v.spread ?? 0) * (v.liquidity || 0);
}

export function runTick(prev: SimSnapshot, inputs: EngineInputs): SimSnapshot {
  const { now, markets, booksByToken } = inputs;
  const settings = prev.settings;

  // 1. Build views for the universe.
  const views = new Map<string, TokenView>();
  for (const market of markets) {
    const view = buildTokenView(market, booksByToken[market.outcomes[0]?.tokenId ?? ""], now);
    if (view) views.set(view.tokenId, view);
  }

  const ctx: EngineCtx = {
    now,
    settings,
    executor: simExecutor,
    cash: prev.metrics.cash,
    positionsByToken: new Map(prev.positions.map((p) => [p.tokenId, { ...p }])),
    orders: prev.orders.map((o) => ({ ...o })),
    newTrades: [],
    wins: prev.metrics.wins,
    losses: prev.metrics.losses,
    views,
    priceHistory: { ...prev.priceHistory },
  };

  // 1a. For held/ordered tokens whose market isn't in the scanner universe
  // (e.g. copy-traded positions), synthesize a view from the order book so they
  // can still be marked and risk-managed.
  const orphanTokens = new Set<string>();
  for (const p of ctx.positionsByToken.values()) orphanTokens.add(p.tokenId);
  for (const o of ctx.orders) orphanTokens.add(o.tokenId);
  for (const tokenId of orphanTokens) {
    if (views.has(tokenId)) continue;
    const book = booksByToken[tokenId];
    if (!book) continue;
    const meta =
      ctx.positionsByToken.get(tokenId) ?? ctx.orders.find((o) => o.tokenId === tokenId);
    if (!meta) continue;
    const v = buildViewFromBook(
      tokenId,
      book,
      { marketId: meta.marketId, marketQuestion: meta.marketQuestion, outcomeLabel: meta.outcomeLabel },
      now,
    );
    if (v) views.set(tokenId, v);
  }

  // 1b. Record current mids into rolling price history (powers UI sparklines
  // and the buy-low entry gate).
  for (const view of views.values()) {
    if (view.mid == null) continue;
    const hist = ctx.priceHistory[view.tokenId] ? [...ctx.priceHistory[view.tokenId]] : [];
    hist.push(view.mid);
    ctx.priceHistory[view.tokenId] = hist.length > MAX_PRICE_POINTS ? hist.slice(-MAX_PRICE_POINTS) : hist;
  }

  // 2. Fills on resting orders.
  simulateFills(ctx);

  // 2b. Active position management — take-profit / stop-loss taker exits at mid.
  if (prev.running) {
    for (const pos of [...ctx.positionsByToken.values()]) {
      if (pos.shares <= 0 || pos.avgPrice <= 0) continue;
      const view = views.get(pos.tokenId);
      if (!view || view.mid == null) continue;
      const ret = (view.mid - pos.avgPrice) / pos.avgPrice;
      const hitTP = settings.takeProfitPct > 0 && ret >= settings.takeProfitPct;
      const hitSL = settings.stopLossPct > 0 && ret <= -settings.stopLossPct;
      if (hitTP || hitSL) {
        for (const o of ctx.orders.filter((o) => o.tokenId === pos.tokenId)) {
          cancelOrder(ctx, o, hitTP ? "take-profit exit" : "stop-loss exit");
        }
        const label = hitTP ? `take-profit (+${(ret * 100).toFixed(1)}%)` : `stop-loss (${(ret * 100).toFixed(1)}%)`;
        flattenPosition(ctx, pos.tokenId, view.mid, label);
      }
    }
  }

  // 3. Flatten near resolution (risk: never hold into settlement).
  for (const view of views.values()) {
    if (inNoTradeWindow(view, settings) && view.mid != null) {
      const pos = ctx.positionsByToken.get(view.tokenId);
      if (pos && pos.shares > 0) flattenPosition(ctx, view.tokenId, view.mid, "near resolution");
      for (const o of ctx.orders.filter((o) => o.tokenId === view.tokenId)) {
        cancelOrder(ctx, o, "near resolution");
      }
    }
  }

  // 4. Mark + daily-loss halt.
  let mark = markPositions(ctx);
  let metrics = computeMetrics(prev.metrics, ctx, settings, mark);

  const rolledOver = metrics.dailyDate !== prev.metrics.dailyDate;
  let haltedReason = rolledOver ? null : prev.haltedReason;

  if (!haltedReason && dailyLossBreached(metrics.dailyPnl, settings)) {
    haltedReason = `Daily loss limit hit (${metrics.dailyPnl.toFixed(2)} ≤ -${settings.maxDailyLoss})`;
    recordTrade(ctx, { type: "risk", message: `HALT — ${haltedReason}. Cancelling orders and flattening.` });
    // Cancel everything and flatten all positions at mid.
    for (const o of [...ctx.orders]) cancelOrder(ctx, o, "daily loss halt");
    for (const pos of [...ctx.positionsByToken.values()]) {
      const view = views.get(pos.tokenId);
      const mid = view?.mid ?? pos.markPrice;
      flattenPosition(ctx, pos.tokenId, mid, "daily loss halt");
    }
    mark = markPositions(ctx);
    metrics = computeMetrics(prev.metrics, ctx, settings, mark);
  }

  // 5. Trading logic (only when actively running the strategy).
  const eligibleViews: TokenView[] = [];
  let lastCopiedTs = prev.lastCopiedTs;

  if (prev.running && prev.strategyEnabled && !haltedReason && settings.strategyMode === "copy") {
    // ---- Copy-trading mode: mirror followed traders' recent trades. --------
    const followed = new Set(prev.followedWallets.map((w) => w.toLowerCase()));
    lastCopiedTs = copyTrades(ctx, inputs.traderTrades ?? [], followed, prev.lastCopiedTs);
    mark = markPositions(ctx);
    metrics = computeMetrics(prev.metrics, ctx, settings, mark);
  } else if (prev.running && prev.strategyEnabled && !haltedReason) {
    const eligibleTokens = new Set<string>();
    for (const view of views.values()) {
      if (evaluateEligibility(view, settings, now).eligible) {
        eligibleViews.push(view);
        eligibleTokens.add(view.tokenId);
      }
    }
    eligibleViews.sort((a, b) => attractiveness(b) - attractiveness(a));

    // Cancel stale orders, and buy orders on markets no longer eligible.
    for (const o of [...ctx.orders]) {
      const ageSec = (now - o.createdAt) / 1000;
      if (ageSec > settings.staleOrderTimeoutSec) {
        cancelOrder(ctx, o, "stale order timeout");
      } else if (o.side === "buy" && !eligibleTokens.has(o.tokenId)) {
        cancelOrder(ctx, o, "market no longer eligible");
      }
    }

    const maxMarkets = Math.max(1, Math.floor(settings.maxOpenOrders / 2));
    generateQuotes(ctx, eligibleViews.slice(0, maxMarkets));

    // Re-mark after placing/cancelling (positions unchanged but keep consistent).
    mark = markPositions(ctx);
    metrics = computeMetrics(prev.metrics, ctx, settings, mark);
  }

  // 6. Equity curve + watch list.
  const equityCurve = appendEquityPoint(prev.equityCurve, { ts: now, equity: metrics.equity });

  const watch = new Set<string>();
  for (const v of [...views.values()].sort((a, b) => attractiveness(b) - attractiveness(a))) {
    if (watch.size >= MAX_WATCH) break;
    watch.add(v.tokenId);
  }
  for (const p of ctx.positionsByToken.values()) watch.add(p.tokenId);
  for (const o of ctx.orders) watch.add(o.tokenId);

  // Keep price history only for tracked tokens to bound persisted size.
  const priceHistory: Record<string, number[]> = {};
  for (const tokenId of watch) {
    if (ctx.priceHistory[tokenId]) priceHistory[tokenId] = ctx.priceHistory[tokenId];
  }

  const positions: SimPosition[] = [...ctx.positionsByToken.values()].sort(
    (a, b) => Math.abs(b.shares * b.markPrice) - Math.abs(a.shares * a.markPrice),
  );
  const orders: SimOrder[] = ctx.orders.sort((a, b) => b.createdAt - a.createdAt);
  const trades: TradeLogEntry[] = mergeTrades(prev.trades, ctx.newTrades);

  return {
    ...prev,
    haltedReason,
    orders,
    positions,
    trades,
    equityCurve,
    metrics,
    watchTokenIds: [...watch],
    priceHistory,
    lastCopiedTs,
    lastTickAt: now,
  };
}

function appendEquityPoint(curve: EquityPoint[], point: EquityPoint): EquityPoint[] {
  const next = [...curve, point];
  return next.length > MAX_EQUITY_POINTS ? next.slice(next.length - MAX_EQUITY_POINTS) : next;
}

function mergeTrades(prev: TradeLogEntry[], added: TradeLogEntry[]): TradeLogEntry[] {
  if (added.length === 0) return prev;
  // Newest first; cap length.
  const merged = [...added.reverse(), ...prev];
  return merged.length > MAX_TRADES ? merged.slice(0, MAX_TRADES) : merged;
}

/** A standalone log entry (used by the store for user-initiated events). */
export function makeLog(now: number, type: TradeLogEntry["type"], message: string): TradeLogEntry {
  return { id: logId(now), ts: now, type, message };
}
