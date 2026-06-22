/**
 * Server-side orchestration for portfolio recovery: read the connected account's
 * current positions, enrich them with live market data + price history, fill in
 * cost basis (API -> reconstructed -> unknown), cross-reference the local bot's
 * own positions, then run the pure analysis engine.
 *
 * READ-ONLY. This never signs or places an order. Real execution stays gated by
 * config.enableRealTrading and is not implemented here.
 */
import { config } from "@/lib/config";
import { loadPositions, loadTrades } from "@/lib/copybot/store";
import type { BotSettings } from "@/lib/copybot/types";
import { fetchBooks } from "@/lib/polymarket/clob";
import { fetchMarketById } from "@/lib/polymarket/gamma";
import { fetchUserPositions, fetchPricesHistory, type AccountPosition } from "@/lib/polymarket/positions";
import { fetchUserTrades } from "@/lib/polymarket/traderTrades";
import type { Market, TraderTrade } from "@/lib/polymarket/types";
import { analyzePositionSignals, summarizePriceHistory, type PositionSignalInput } from "./analyze";
import type {
  CostBasisSource,
  MarketStatus,
  PortfolioSnapshot,
  PortfolioTotals,
  RecoveredPosition,
  RecoveryThresholds,
} from "./types";

const MAX_POSITIONS = 50;
const NEAR_RESOLUTION_MS = 24 * 60 * 60 * 1000;
const WIDE_SPREAD_ABS = 0.05;
const ENRICH_CONCURRENCY = 6;
const PRICE_HISTORY_INTERVAL = "1w";

/** Walk a wallet's trade history oldest->newest to reconstruct per-token cost basis. */
function reconstructCostBasis(trades: TraderTrade[]): Map<string, number> {
  const acc = new Map<string, { shares: number; cost: number }>();
  const sorted = [...trades].sort((a, b) => a.timestamp - b.timestamp);
  for (const tr of sorted) {
    if (!tr.tokenId) continue;
    const cur = acc.get(tr.tokenId) ?? { shares: 0, cost: 0 };
    if (tr.side === "BUY") {
      cur.shares += tr.size;
      cur.cost += tr.size * tr.price;
    } else {
      const avg = cur.shares > 0 ? cur.cost / cur.shares : 0;
      const sellShares = Math.min(cur.shares, tr.size);
      cur.shares -= sellShares;
      cur.cost -= sellShares * avg;
      if (cur.shares < 1e-9) {
        cur.shares = 0;
        cur.cost = 0;
      }
    }
    acc.set(tr.tokenId, cur);
  }
  const out = new Map<string, number>();
  for (const [token, v] of acc) {
    if (v.shares > 1e-9 && v.cost > 0) out.set(token, v.cost / v.shares);
  }
  return out;
}

/** Tokens the local bot has touched, so recovery can flag positions from prior sessions. */
async function loadBotTokenSet(): Promise<Set<string>> {
  const set = new Set<string>();
  try {
    const [positions, trades] = await Promise.all([loadPositions(), loadTrades()]);
    for (const p of positions) set.add(p.tokenId);
    for (const t of trades) set.add(t.tokenId);
  } catch {
    // Local bot state is optional context; ignore failures.
  }
  return set;
}

async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += limit) {
    await Promise.allSettled(items.slice(i, i + limit).map(fn));
  }
}

function deriveStatus(market: Market | null, redeemable: boolean, timeToResolutionMs: number | null): MarketStatus {
  if (redeemable || market?.closed) return "resolved";
  if (timeToResolutionMs != null && timeToResolutionMs <= NEAR_RESOLUTION_MS) return "near-resolution";
  if (market?.active) return "open";
  return "unknown";
}

interface Enriched {
  base: Omit<RecoveredPosition, "classification" | "recommendedAction" | "actionRationale" | "riskFlags">;
  signal: PositionSignalInput;
}

function buildEnriched(
  p: AccountPosition,
  book: { bestBid: number | null; bestAsk: number | null; midpoint: number | null; spread: number | null } | undefined,
  market: Market | null,
  reconstructedAvg: number | undefined,
  fromBotSession: boolean,
  priceHistory: ReturnType<typeof summarizePriceHistory>,
): Enriched {
  const bestBid = book?.bestBid ?? market?.bestBid ?? null;
  const bestAsk = book?.bestAsk ?? market?.bestAsk ?? null;
  let midPrice = book?.midpoint ?? market?.midpoint ?? null;
  if (midPrice == null && p.curPrice != null) midPrice = p.curPrice;
  let spread = book?.spread ?? null;
  if (spread == null && bestBid != null && bestAsk != null) spread = bestAsk - bestBid;

  const liquidityUsd = market?.liquidity ?? 0;
  const volume24hrUsd = market?.volume24hr ?? 0;

  // Cost basis: prefer the API's avgPrice, fall back to reconstruction, else unknown.
  let avgEntryPrice: number | null = null;
  let costBasisSource: CostBasisSource = "unknown";
  if (p.avgPrice != null && p.avgPrice > 0) {
    avgEntryPrice = p.avgPrice;
    costBasisSource = "api";
  } else if (reconstructedAvg != null && reconstructedAvg > 0) {
    avgEntryPrice = reconstructedAvg;
    costBasisSource = "reconstructed";
  }

  const costBasisUsd = avgEntryPrice != null ? avgEntryPrice * p.size : null;
  const estimatedValueUsd = midPrice != null ? p.size * midPrice : null;
  const unrealizedPnlUsd =
    avgEntryPrice != null && midPrice != null ? (midPrice - avgEntryPrice) * p.size : null;
  const unrealizedPnlPct =
    avgEntryPrice != null && avgEntryPrice > 0 && midPrice != null
      ? ((midPrice - avgEntryPrice) / avgEntryPrice) * 100
      : null;

  let timeToResolutionMs = market?.timeToResolutionMs ?? null;
  if (timeToResolutionMs == null && p.endDate) {
    const ms = Date.parse(p.endDate);
    if (Number.isFinite(ms)) timeToResolutionMs = ms - Date.now();
  }
  const marketStatus = deriveStatus(market, p.redeemable, timeToResolutionMs);

  const base: Enriched["base"] = {
    tokenId: p.tokenId,
    conditionId: p.conditionId,
    marketTitle: market?.question || p.title,
    slug: market?.slug || p.slug,
    outcome: p.outcome,
    shares: p.size,
    costBasisSource,
    avgEntryPrice,
    costBasisUsd,
    bestBid,
    bestAsk,
    midPrice,
    spread,
    liquidityUsd,
    volume24hrUsd,
    estimatedValueUsd,
    unrealizedPnlUsd,
    unrealizedPnlPct,
    endDate: p.endDate ?? market?.endDate ?? null,
    timeToResolutionMs,
    marketStatus,
    redeemable: p.redeemable,
    priceHistory,
    fromBotSession,
  };

  const signal: PositionSignalInput = {
    shares: p.size,
    costBasisSource,
    avgEntryPrice,
    midPrice,
    bestBid,
    bestAsk,
    spread,
    liquidityUsd,
    estimatedValueUsd,
    unrealizedPnlPct,
    timeToResolutionMs,
    marketStatus,
    redeemable: p.redeemable,
    fromBotSession,
  };

  return { base, signal };
}

function buildThresholds(settings: BotSettings, portfolioValueUsd: number): RecoveryThresholds {
  return {
    takeProfitPct: settings.autoExitTakeProfitPercent > 0 ? settings.autoExitTakeProfitPercent : 25,
    stopLossPct: settings.autoExitStopLossPercent > 0 ? settings.autoExitStopLossPercent : 20,
    maxPerMarketPct: settings.maxExposurePerMarketPercent,
    minLiquidityUsd: settings.minMarketLiquidityUsd,
    wideSpreadAbs: WIDE_SPREAD_ABS,
    nearResolutionMs: NEAR_RESOLUTION_MS,
    portfolioValueUsd,
  };
}

function computeTotals(positions: RecoveredPosition[]): PortfolioTotals {
  let estimatedValueUsd = 0;
  let knownCostBasisUsd = 0;
  let unrealizedPnlUsd = 0;
  let unknownCostBasisCount = 0;
  let illiquidCount = 0;
  let nearResolutionCount = 0;
  let fromBotSessionCount = 0;
  let actionableCount = 0;

  for (const p of positions) {
    estimatedValueUsd += p.estimatedValueUsd ?? 0;
    if (p.costBasisUsd != null) knownCostBasisUsd += p.costBasisUsd;
    if (p.unrealizedPnlUsd != null) unrealizedPnlUsd += p.unrealizedPnlUsd;
    if (p.costBasisSource === "unknown") unknownCostBasisCount += 1;
    if (p.classification === "too-illiquid") illiquidCount += 1;
    if (p.classification === "near-resolution") nearResolutionCount += 1;
    if (p.fromBotSession) fromBotSessionCount += 1;
    if (p.recommendedAction !== "hold" && p.recommendedAction !== "manual-review") actionableCount += 1;
  }

  return {
    positionCount: positions.length,
    estimatedValueUsd,
    knownCostBasisUsd,
    unrealizedPnlUsd,
    unknownCostBasisCount,
    illiquidCount,
    nearResolutionCount,
    fromBotSessionCount,
    actionableCount,
  };
}

export async function recoverPortfolio(wallet: string, settings: BotSettings): Promise<PortfolioSnapshot> {
  const notes: string[] = [];
  const realTradingEnabled = config.enableRealTrading;

  let accountPositions = await fetchUserPositions(wallet);

  if (accountPositions.length === 0) {
    return {
      wallet,
      fetchedAt: Date.now(),
      positions: [],
      totals: computeTotals([]),
      realTradingEnabled,
      liveExecutionEnabled: false,
      notes: ["No open positions found for this wallet on Polymarket."],
    };
  }

  if (accountPositions.length > MAX_POSITIONS) {
    notes.push(`Wallet has ${accountPositions.length} positions; analyzing the ${MAX_POSITIONS} largest by current value.`);
    accountPositions = [...accountPositions]
      .sort((a, b) => (b.currentValueUsd ?? 0) - (a.currentValueUsd ?? 0))
      .slice(0, MAX_POSITIONS);
  }

  // Cost-basis reconstruction only if the API left any avgPrice blank.
  let reconstructed = new Map<string, number>();
  if (accountPositions.some((p) => p.avgPrice == null || p.avgPrice <= 0)) {
    try {
      const trades = await fetchUserTrades(wallet, 1000);
      reconstructed = reconstructCostBasis(trades);
    } catch {
      notes.push("Could not reconstruct cost basis from trade history; affected positions are marked unknown.");
    }
  }

  const botTokens = await loadBotTokenSet();

  const tokenIds = accountPositions.map((p) => p.tokenId);
  const books = await fetchBooks(tokenIds).catch(() => []);
  const bookByToken = new Map(books.map((b) => [b.tokenId, b]));

  const marketByToken = new Map<string, Market | null>();
  const historyByToken = new Map<string, ReturnType<typeof summarizePriceHistory>>();
  await mapWithConcurrency(accountPositions, ENRICH_CONCURRENCY, async (p) => {
    const [market, history] = await Promise.all([
      fetchMarketById(p.tokenId).catch(() => null),
      fetchPricesHistory(p.tokenId, PRICE_HISTORY_INTERVAL, 180),
    ]);
    marketByToken.set(p.tokenId, market);
    historyByToken.set(p.tokenId, summarizePriceHistory(history, PRICE_HISTORY_INTERVAL));
  });

  // Pass 1: enrich and total up portfolio value (needed for per-market exposure %).
  const enriched = accountPositions.map((p) =>
    buildEnriched(
      p,
      bookByToken.get(p.tokenId),
      marketByToken.get(p.tokenId) ?? null,
      reconstructed.get(p.tokenId),
      botTokens.has(p.tokenId),
      historyByToken.get(p.tokenId) ?? null,
    ),
  );
  const portfolioValueUsd = enriched.reduce((sum, e) => sum + (e.base.estimatedValueUsd ?? 0), 0);
  const thresholds = buildThresholds(settings, portfolioValueUsd);

  // Pass 2: analyze each position with the now-known portfolio context.
  const positions: RecoveredPosition[] = enriched.map((e) => ({
    ...e.base,
    ...analyzePositionSignals(e.signal, thresholds),
  }));

  const totals = computeTotals(positions);
  if (totals.unknownCostBasisCount > 0) {
    notes.push(`${totals.unknownCostBasisCount} position(s) have unknown cost basis — P&L is not assumed for them.`);
  }
  if (!realTradingEnabled) {
    notes.push("Live order placement is disabled (ENABLE_REAL_TRADING=false). Everything below is a recommendation only.");
  }

  return {
    wallet,
    fetchedAt: Date.now(),
    positions,
    totals,
    realTradingEnabled,
    liveExecutionEnabled: false,
    notes,
  };
}
