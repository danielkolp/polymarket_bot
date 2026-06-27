/**
 * Aggregations over the analytics streams: trader, market, portfolio, and
 * correlation analytics plus the dashboard summary. All derived on read from the
 * NDJSON streams (+ live positions/equity passed in), so producing them never
 * touches the trading loop.
 */
import type { BotPosition } from "@/lib/copybot/types";
import { positionExposure } from "@/lib/copybot/accounting";
import { inferCorrelationKeys } from "./categorize";
import { ANALYTICS_FILES, readNdjson } from "./store";
import { buildCompletedTrades } from "./lifecycle";
import type {
  CompletedTrade,
  DecisionRecord,
  MarketCategory,
  MissedOpportunity,
  PositionSnapshot,
} from "./types";

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

// ── Trader analytics (req 4) ────────────────────────────────────────────────
export interface TraderAnalytics {
  wallet: string;
  name: string;
  copiedTrades: number;
  completedTrades: number;
  realizedCopyRoi: number;
  realizedPnlUsd: number;
  winRate: number;
  avgRoi: number;
  avgHoldMs: number;
  avgSlippageCents: number;
  avgPositionSizeUsd: number;
  /** Sharpe-like: mean ROI / stdev ROI across completed trades. */
  sharpeLike: number;
  bestCategories: Array<{ category: MarketCategory; pnlUsd: number }>;
  worstCategories: Array<{ category: MarketCategory; pnlUsd: number }>;
  /** Net realized P&L by weekday (0=Sun..6=Sat) and hour (0..23), by exit time. */
  pnlByWeekday: number[];
  pnlByHour: number[];
}

export function buildTraderAnalytics(decisions: DecisionRecord[], completed: CompletedTrade[]): TraderAnalytics[] {
  const wallets = new Map<string, { name: string }>();
  for (const d of decisions) wallets.set(d.copiedWallet, { name: d.trader?.name ?? d.copiedWallet });

  const out: TraderAnalytics[] = [];
  for (const [wallet, { name }] of wallets) {
    const wDecisions = decisions.filter((d) => d.copiedWallet === wallet);
    const filledBuys = wDecisions.filter((d) => d.side === "BUY" && (d.status === "copied" || d.status === "simulated"));
    const wTrades = completed.filter((t) => t.copiedWallet === wallet);

    const rois = wTrades.map((t) => t.roi);
    const totalCost = wTrades.reduce((s, t) => s + t.costBasisUsd, 0);
    const totalPnl = wTrades.reduce((s, t) => s + t.realizedPnlUsd, 0);
    const wins = wTrades.filter((t) => t.realizedPnlUsd > 0).length;

    const byCategory = new Map<MarketCategory, number>();
    for (const t of wTrades) byCategory.set(t.category, (byCategory.get(t.category) ?? 0) + t.realizedPnlUsd);
    const sortedCats = [...byCategory.entries()].map(([category, pnlUsd]) => ({ category, pnlUsd }));
    sortedCats.sort((a, b) => b.pnlUsd - a.pnlUsd);

    const pnlByWeekday = new Array(7).fill(0);
    const pnlByHour = new Array(24).fill(0);
    for (const t of wTrades) {
      const d = new Date(t.exitTs);
      pnlByWeekday[d.getDay()] += t.realizedPnlUsd;
      pnlByHour[d.getHours()] += t.realizedPnlUsd;
    }

    const sd = stdev(rois);
    out.push({
      wallet,
      name,
      copiedTrades: filledBuys.length,
      completedTrades: wTrades.length,
      realizedCopyRoi: totalCost > 0 ? totalPnl / totalCost : 0,
      realizedPnlUsd: totalPnl,
      winRate: wTrades.length ? wins / wTrades.length : 0,
      avgRoi: mean(rois),
      avgHoldMs: mean(wTrades.map((t) => t.holdMs)),
      avgSlippageCents: mean(filledBuys.map((d) => d.slippageCents ?? 0)),
      avgPositionSizeUsd: mean(filledBuys.map((d) => d.copyAmountUsd)),
      sharpeLike: sd > 0 ? mean(rois) / sd : 0,
      bestCategories: sortedCats.slice(0, 3),
      worstCategories: sortedCats.slice(-3).reverse(),
      pnlByWeekday,
      pnlByHour,
    });
  }
  out.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  return out;
}

// ── Market / category analytics (req 5) ─────────────────────────────────────
export interface CategoryAnalytics {
  category: MarketCategory;
  decisions: number;
  copiedTrades: number;
  completedTrades: number;
  avgLiquidityUsd: number;
  avgVolumeUsd: number;
  avgSpreadCents: number;
  avgCopyRoi: number;
  realizedPnlUsd: number;
  avgSlippageCents: number;
  /** Realized-ROI volatility across completed trades in the category. */
  roiVolatility: number;
}

export function buildCategoryAnalytics(decisions: DecisionRecord[], completed: CompletedTrade[]): CategoryAnalytics[] {
  const cats = new Set<MarketCategory>();
  for (const d of decisions) cats.add(d.market.category);
  for (const t of completed) cats.add(t.category);

  const out: CategoryAnalytics[] = [];
  for (const category of cats) {
    const cDecisions = decisions.filter((d) => d.market.category === category);
    const cFilled = cDecisions.filter((d) => d.status === "copied" || d.status === "simulated");
    const cTrades = completed.filter((t) => t.category === category);
    const rois = cTrades.map((t) => t.roi);
    const totalCost = cTrades.reduce((s, t) => s + t.costBasisUsd, 0);
    const totalPnl = cTrades.reduce((s, t) => s + t.realizedPnlUsd, 0);
    out.push({
      category,
      decisions: cDecisions.length,
      copiedTrades: cFilled.filter((d) => d.side === "BUY").length,
      completedTrades: cTrades.length,
      avgLiquidityUsd: mean(cDecisions.map((d) => d.market.liquidityUsd ?? 0)),
      avgVolumeUsd: mean(cDecisions.map((d) => d.market.volumeUsd ?? 0)),
      avgSpreadCents: mean(cDecisions.map((d) => (d.market.spread ?? 0) * 100)),
      avgCopyRoi: totalCost > 0 ? totalPnl / totalCost : 0,
      realizedPnlUsd: totalPnl,
      avgSlippageCents: mean(cFilled.map((d) => d.slippageCents ?? 0)),
      roiVolatility: stdev(rois),
    });
  }
  out.sort((a, b) => b.realizedPnlUsd - a.realizedPnlUsd);
  return out;
}

// ── Portfolio analytics (req 6) ─────────────────────────────────────────────
export interface PortfolioAnalytics {
  cashUsd: number;
  totalExposureUsd: number;
  totalAccountValueUsd: number;
  openPositions: number;
  /** Largest single-market exposure as a fraction of total exposure (0..1). */
  maxConcentration: number;
  exposureByCategory: Array<{ category: MarketCategory; exposureUsd: number }>;
  exposureByTrader: Array<{ wallet: string; exposureUsd: number }>;
  exposureByResolutionDate: Array<{ date: string; exposureUsd: number }>;
  exposureByEvent: Array<{ conditionId: string; title: string; exposureUsd: number }>;
  exposureByMarket: Array<{ tokenId: string; title: string; exposureUsd: number }>;
}

export function buildPortfolioAnalytics(
  positions: BotPosition[],
  cashUsd: number,
  decisions: DecisionRecord[],
): PortfolioAnalytics {
  // Latest decision per token carries category + resolution date for live
  // positions; fall back to the position itself when no decision exists yet.
  const latestDecision = new Map<string, DecisionRecord>();
  for (const d of decisions) {
    const prev = latestDecision.get(d.tokenId);
    if (!prev || d.ts > prev.ts) latestDecision.set(d.tokenId, d);
  }

  const byCategory = new Map<MarketCategory, number>();
  const byTrader = new Map<string, number>();
  const byDate = new Map<string, number>();
  const byEvent = new Map<string, { title: string; exposureUsd: number }>();
  const byMarket: PortfolioAnalytics["exposureByMarket"] = [];
  let totalExposureUsd = 0;
  let maxMarketExposure = 0;

  for (const p of positions) {
    const exposure = positionExposure(p);
    totalExposureUsd += exposure;
    maxMarketExposure = Math.max(maxMarketExposure, exposure);
    const d = latestDecision.get(p.tokenId);
    const category = d?.market.category ?? "other";
    byCategory.set(category, (byCategory.get(category) ?? 0) + exposure);
    for (const w of p.sourceWallets) byTrader.set(w, (byTrader.get(w) ?? 0) + exposure);
    const resolvesAt = d?.market.resolvesAt ?? null;
    if (resolvesAt) {
      const date = new Date(resolvesAt);
      if (!Number.isNaN(date.getTime())) {
        const key = date.toISOString().slice(0, 10);
        byDate.set(key, (byDate.get(key) ?? 0) + exposure);
      }
    }
    const ev = byEvent.get(p.conditionId) ?? { title: p.marketTitle, exposureUsd: 0 };
    ev.exposureUsd += exposure;
    byEvent.set(p.conditionId, ev);
    byMarket.push({ tokenId: p.tokenId, title: p.marketTitle, exposureUsd: exposure });
  }

  const sortDesc = <T extends { exposureUsd: number }>(xs: T[]) => xs.sort((a, b) => b.exposureUsd - a.exposureUsd);

  return {
    cashUsd,
    totalExposureUsd,
    totalAccountValueUsd: cashUsd + totalExposureUsd,
    openPositions: positions.length,
    maxConcentration: totalExposureUsd > 0 ? maxMarketExposure / totalExposureUsd : 0,
    exposureByCategory: sortDesc([...byCategory.entries()].map(([category, exposureUsd]) => ({ category, exposureUsd }))),
    exposureByTrader: sortDesc([...byTrader.entries()].map(([wallet, exposureUsd]) => ({ wallet, exposureUsd }))),
    exposureByResolutionDate: sortDesc(
      [...byDate.entries()].map(([date, exposureUsd]) => ({ date, exposureUsd })),
    ),
    exposureByEvent: sortDesc(
      [...byEvent.entries()].map(([conditionId, v]) => ({ conditionId, title: v.title, exposureUsd: v.exposureUsd })),
    ),
    exposureByMarket: sortDesc(byMarket),
  };
}

// ── Execution quality (req: leader vs bot fill, slippage, partials, failures) ─
export interface ExecutionQuality {
  filledOrders: number;
  partialFills: number;
  failedOrders: number;
  skippedBuys: number;
  avgSlippageCents: number;
  avgLeaderToBotCents: number;
  avgFrictionUsd: number;
  avgFeeUsd: number;
  /** Mean age (s) of a leader trade when the bot acted — a copy-latency proxy. */
  avgCopyLatencySec: number;
}

export function buildExecutionQuality(decisions: DecisionRecord[], exits: DecisionRecord[]): ExecutionQuality {
  const all = [...decisions, ...exits];
  const filled = all.filter((d) => d.status === "copied" || d.status === "simulated");
  const filledBuys = decisions.filter((d) => d.action === "BUY" && (d.status === "copied" || d.status === "simulated"));
  const leaderVsBot = filledBuys
    .filter((d) => d.leaderFillPrice != null && d.ourFillPrice != null)
    .map((d) => ((d.ourFillPrice as number) - (d.leaderFillPrice as number)) * 100);
  return {
    filledOrders: filled.length,
    partialFills: filled.filter((d) => d.fillStatus === "partial").length,
    failedOrders: decisions.filter((d) => d.action === "FAIL").length,
    skippedBuys: decisions.filter((d) => d.action === "SKIP" && d.side === "BUY").length,
    avgSlippageCents: mean(filledBuys.map((d) => d.slippageCents ?? 0)),
    avgLeaderToBotCents: mean(leaderVsBot),
    avgFrictionUsd: mean(filled.map((d) => d.frictionUsd ?? 0)),
    avgFeeUsd: mean(filled.map((d) => d.feeUsd ?? 0)),
    avgCopyLatencySec: mean(filledBuys.map((d) => d.tradeAgeSec ?? 0)),
  };
}

// ── Correlation analytics (req 9) ───────────────────────────────────────────
export interface CorrelationCluster {
  kind: "trader" | "event" | "match" | "league" | "election" | "resolution-date";
  key: string;
  positionCount: number;
  exposureUsd: number;
  tokenIds: string[];
}

export function buildCorrelationClusters(
  positions: BotPosition[],
  decisions: DecisionRecord[],
): CorrelationCluster[] {
  // Latest decision per token carries the market title + resolution date needed
  // to infer match/league/election/date correlation keys.
  const latestDecision = new Map<string, DecisionRecord>();
  for (const d of decisions) {
    const prev = latestDecision.get(d.tokenId);
    if (!prev || d.ts > prev.ts) latestDecision.set(d.tokenId, d);
  }

  const clusters = new Map<string, CorrelationCluster>();
  const add = (kind: CorrelationCluster["kind"], key: string | null, p: BotPosition) => {
    if (!key) return;
    const id = `${kind}:${key}`;
    const c = clusters.get(id) ?? { kind, key, positionCount: 0, exposureUsd: 0, tokenIds: [] };
    c.positionCount += 1;
    c.exposureUsd += positionExposure(p);
    c.tokenIds.push(p.tokenId);
    clusters.set(id, c);
  };

  for (const p of positions) {
    for (const w of p.sourceWallets) add("trader", w, p);
    add("event", p.conditionId, p);
    const d = latestDecision.get(p.tokenId);
    const keys = inferCorrelationKeys(
      `${d?.market.title ?? p.marketTitle} ${d?.market.slug ?? p.marketSlug}`,
      p.conditionId,
      d?.market.resolvesAt ?? null,
    );
    add("match", keys.match, p);
    add("league", keys.league, p);
    add("election", keys.election, p);
    add("resolution-date", keys.resolutionDate, p);
  }

  // Only clusters with more than one position represent real correlation.
  return [...clusters.values()].filter((c) => c.positionCount > 1).sort((a, b) => b.exposureUsd - a.exposureUsd);
}

// ── Dashboard summary (req 11) ──────────────────────────────────────────────
export interface SkipReasonStat {
  reasonCode: string;
  count: number;
  wouldHaveWon: number;
  avgRoiIfCopied: number;
}

export interface ScoreBucket {
  bucket: string; // e.g. "0-10"
  count: number;
  filled: number;
  avgRealizedPnlUsd: number;
}

export interface DashboardSummary {
  generatedAt: number;
  totals: {
    decisions: number;
    buys: number;
    sells: number;
    skips: number;
    fails: number;
    completedTrades: number;
  };
  performance: {
    cumulativeRealizedPnlUsd: number;
    cumulativeRoi: number;
    winRate: number;
    avgWinnerUsd: number;
    avgLoserUsd: number;
    expectancyUsd: number;
    avgHoldMs: number;
  };
  copyRoiByTrader: Array<{ wallet: string; name: string; copyRoi: number; pnlUsd: number }>;
  copyRoiByCategory: Array<{ category: MarketCategory; copyRoi: number; pnlUsd: number }>;
  skipReasons: SkipReasonStat[];
  missedThatWouldHaveWon: number;
  missedSummary: {
    resolved: number;
    wouldHaveBeenProfitable: number;
    avgRoiIfCopied: number;
    byReason: SkipReasonStat[];
  };
  scoreDistribution: ScoreBucket[];
  slippageSeries: Array<{ ts: number; slippageCents: number }>;
  equityFromCompleted: Array<{ ts: number; cumulativePnlUsd: number }>;
}

export interface DashboardInputs {
  decisions: DecisionRecord[];
  /** Bot-autonomous exits (auto-exit/leader-exit/flatten/redeem/settlement). */
  exits?: DecisionRecord[];
  completed: CompletedTrade[];
  missed: MissedOpportunity[];
}

export function buildDashboardSummary(inputs: DashboardInputs): DashboardSummary {
  const { decisions, completed, missed } = inputs;
  const exits = inputs.exits ?? [];

  const buys = decisions.filter((d) => d.action === "BUY").length;
  // SELLs = leader-copy exits (decision log) + bot-autonomous exits (exits stream).
  const sells =
    decisions.filter((d) => d.action === "SELL").length +
    exits.filter((d) => d.action === "SELL").length;
  const skips = decisions.filter((d) => d.action === "SKIP").length;
  const fails = decisions.filter((d) => d.action === "FAIL").length;

  const winners = completed.filter((t) => t.realizedPnlUsd > 0);
  const losers = completed.filter((t) => t.realizedPnlUsd < 0);
  const cumulativePnl = completed.reduce((s, t) => s + t.realizedPnlUsd, 0);
  const totalCost = completed.reduce((s, t) => s + t.costBasisUsd, 0);
  const winRate = completed.length ? winners.length / completed.length : 0;
  const avgWin = mean(winners.map((t) => t.realizedPnlUsd));
  const avgLoss = mean(losers.map((t) => t.realizedPnlUsd));
  const expectancy = winRate * avgWin + (1 - winRate) * avgLoss;

  // Copy ROI by trader / category from completed trades.
  const traderAgg = new Map<string, { name: string; pnl: number; cost: number }>();
  const catAgg = new Map<MarketCategory, { pnl: number; cost: number }>();
  for (const t of completed) {
    const tr = traderAgg.get(t.copiedWallet) ?? { name: t.copiedWallet, pnl: 0, cost: 0 };
    tr.pnl += t.realizedPnlUsd;
    tr.cost += t.costBasisUsd;
    traderAgg.set(t.copiedWallet, tr);
    const c = catAgg.get(t.category) ?? { pnl: 0, cost: 0 };
    c.pnl += t.realizedPnlUsd;
    c.cost += t.costBasisUsd;
    catAgg.set(t.category, c);
  }
  // Fill trader names from decisions.
  for (const d of decisions) {
    const tr = traderAgg.get(d.copiedWallet);
    if (tr && tr.name === d.copiedWallet && d.trader?.name) tr.name = d.trader.name;
  }

  // Skip reasons, joined with their missed-opportunity outcomes.
  const missedByDecision = new Map<string, MissedOpportunity>();
  for (const m of missed) missedByDecision.set(m.decisionId, m);
  const skipAgg = new Map<string, { count: number; wouldWin: number; rois: number[] }>();
  for (const d of decisions) {
    if (d.action !== "SKIP" || d.side !== "BUY") continue;
    const agg = skipAgg.get(d.reasonCode) ?? { count: 0, wouldWin: 0, rois: [] };
    agg.count += 1;
    const m = missedByDecision.get(d.id);
    if (m) {
      if (m.wouldHaveBeenProfitable) agg.wouldWin += 1;
      agg.rois.push(m.roiIfCopied);
    }
    skipAgg.set(d.reasonCode, agg);
  }
  const skipReasons: SkipReasonStat[] = [...skipAgg.entries()]
    .map(([reasonCode, a]) => ({
      reasonCode,
      count: a.count,
      wouldHaveWon: a.wouldWin,
      avgRoiIfCopied: mean(a.rois),
    }))
    .sort((a, b) => b.count - a.count);

  // Missed summary.
  const missedProfitable = missed.filter((m) => m.wouldHaveBeenProfitable);
  const missedByReason = new Map<string, { count: number; win: number; rois: number[] }>();
  for (const m of missed) {
    const a = missedByReason.get(m.skipReasonCode) ?? { count: 0, win: 0, rois: [] };
    a.count += 1;
    if (m.wouldHaveBeenProfitable) a.win += 1;
    a.rois.push(m.roiIfCopied);
    missedByReason.set(m.skipReasonCode, a);
  }

  // Decision-score distribution (10 buckets), with realized P&L join via token.
  const pnlByToken = new Map<string, number>();
  for (const t of completed) pnlByToken.set(t.tokenId, (pnlByToken.get(t.tokenId) ?? 0) + t.realizedPnlUsd);
  const buckets: ScoreBucket[] = [];
  for (let b = 0; b < 10; b++) {
    const lo = b * 10;
    const hi = lo + 10;
    const inBucket = decisions.filter((d) => d.score.total >= lo && (b === 9 ? d.score.total <= hi : d.score.total < hi));
    const filled = inBucket.filter((d) => d.status === "copied" || d.status === "simulated");
    buckets.push({
      bucket: `${lo}-${hi}`,
      count: inBucket.length,
      filled: filled.length,
      avgRealizedPnlUsd: mean(filled.map((d) => pnlByToken.get(d.tokenId) ?? 0)),
    });
  }

  const slippageSeries = decisions
    .filter((d) => d.slippageCents != null && (d.status === "copied" || d.status === "simulated") && d.side === "BUY")
    .map((d) => ({ ts: d.ts, slippageCents: d.slippageCents as number }));

  let running = 0;
  const equityFromCompleted = [...completed]
    .sort((a, b) => a.exitTs - b.exitTs)
    .map((t) => {
      running += t.realizedPnlUsd;
      return { ts: t.exitTs, cumulativePnlUsd: running };
    });

  return {
    generatedAt: Date.now(),
    totals: {
      decisions: decisions.length,
      buys,
      sells,
      skips,
      fails,
      completedTrades: completed.length,
    },
    performance: {
      cumulativeRealizedPnlUsd: cumulativePnl,
      cumulativeRoi: totalCost > 0 ? cumulativePnl / totalCost : 0,
      winRate,
      avgWinnerUsd: avgWin,
      avgLoserUsd: avgLoss,
      expectancyUsd: expectancy,
      avgHoldMs: mean(completed.map((t) => t.holdMs)),
    },
    copyRoiByTrader: [...traderAgg.entries()]
      .map(([wallet, a]) => ({ wallet, name: a.name, copyRoi: a.cost > 0 ? a.pnl / a.cost : 0, pnlUsd: a.pnl }))
      .sort((a, b) => b.pnlUsd - a.pnlUsd),
    copyRoiByCategory: [...catAgg.entries()]
      .map(([category, a]) => ({ category, copyRoi: a.cost > 0 ? a.pnl / a.cost : 0, pnlUsd: a.pnl }))
      .sort((a, b) => b.pnlUsd - a.pnlUsd),
    skipReasons,
    missedThatWouldHaveWon: missedProfitable.length,
    missedSummary: {
      resolved: missed.length,
      wouldHaveBeenProfitable: missedProfitable.length,
      avgRoiIfCopied: mean(missed.map((m) => m.roiIfCopied)),
      byReason: [...missedByReason.entries()]
        .map(([reasonCode, a]) => ({
          reasonCode,
          count: a.count,
          wouldHaveWon: a.win,
          avgRoiIfCopied: mean(a.rois),
        }))
        .sort((a, b) => b.count - a.count),
    },
    scoreDistribution: buckets,
    slippageSeries,
    equityFromCompleted,
  };
}

/** Convenience loader used by the API + export: reads streams and builds everything. */
export async function loadAnalyticsBundle(positions: BotPosition[], cashUsd: number) {
  const [decisions, exits, missed, snapshots] = await Promise.all([
    readNdjson<DecisionRecord>(ANALYTICS_FILES.decisions),
    readNdjson<DecisionRecord>(ANALYTICS_FILES.exits),
    readNdjson<MissedOpportunity>(ANALYTICS_FILES.missed),
    readNdjson<PositionSnapshot>(ANALYTICS_FILES.snapshots),
  ]);
  const completed = await buildCompletedTrades(decisions, exits);
  // Trader/category analytics consider both leader-copy decisions and bot exits
  // (e.g. avg slippage uses entries; ROI uses completed trades).
  const decisionsAndExits = [...decisions, ...exits];
  return {
    decisions,
    exits,
    completed,
    missed,
    snapshots,
    traders: buildTraderAnalytics(decisionsAndExits, completed),
    categories: buildCategoryAnalytics(decisionsAndExits, completed),
    portfolio: buildPortfolioAnalytics(positions, cashUsd, decisions),
    correlation: buildCorrelationClusters(positions, decisions),
    executionQuality: buildExecutionQuality(decisions, exits),
    dashboard: buildDashboardSummary({ decisions, exits, completed, missed }),
  };
}
