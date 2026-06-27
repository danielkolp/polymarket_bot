/**
 * Recorder: turns a completed bot decision (plus the context captured while it
 * was made) into a fully-enriched {@link DecisionRecord} and appends it to the
 * decision log. Also records periodic open-position snapshots.
 *
 * Every function here is best-effort and self-contained: a failure logs a warning
 * and returns — it can never disturb the trading loop that calls it.
 */
import type {
  BotPosition,
  BotSettings,
  BotState,
  CopyTradeRecord,
  FollowedTrader,
} from "@/lib/copybot/types";
import { positionCostBasis, positionExposure, totalExposure } from "@/lib/copybot/accounting";
import type { Market, TraderTrade } from "@/lib/polymarket/types";
import { categorizeMarket } from "./categorize";
import { computeDecisionScore } from "./score";
import { appendNdjson, ANALYTICS_FILES } from "./store";
import type {
  DecisionAction,
  DecisionRecord,
  MarketSnapshot,
  PositionSnapshot,
  TraderQualitySnapshot,
} from "./types";

let counter = 0;
function nextId(prefix: string, now: number): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${now.toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function num(value: number | undefined | null): number | null {
  return value != null && Number.isFinite(value) ? value : null;
}

/**
 * Normalize a free-text skip/fail reason to a stable bucket code, so repeated
 * reasons (which embed live numbers) group cleanly in analytics. Mirrors the
 * spirit of the bot's own skip-bucketing without importing its private helper.
 */
export function reasonCodeOf(reason: string): string {
  const r = reason.toLowerCase();
  if (!r) return "ok";
  if (r.includes("stale") || r.includes("freshness") || r.includes("old")) return "stale";
  if (r.includes("spread")) return "spread";
  if (r.includes("liquidity")) return "liquidity";
  if (r.includes("below the minimum") && r.includes("price")) return "price-too-low";
  if (r.includes("above the maximum") && r.includes("price")) return "price-too-high";
  if (r.includes("resolves within") || r.includes("time to resolution")) return "too-close-to-resolution";
  if (r.includes("adverse") || r.includes("ran past") || r.includes("paying up")) return "adverse-entry";
  if (r.includes("per-market exposure")) return "cap-per-market";
  if (r.includes("total exposure")) return "cap-total";
  if (r.includes("per-wallet exposure")) return "cap-per-wallet";
  if (r.includes("wallet copy cap")) return "cap-wallet-cycle";
  if (r.includes("cooldown")) return "cooldown";
  if (r.includes("daily loss")) return "daily-loss-lockout";
  if (r.includes("panic")) return "panic";
  if (r.includes("readiness")) return "live-readiness";
  if (r.includes("available balance") || r.includes("minimum available")) return "min-balance";
  if (r.includes("below the configured minimum")) return "below-trade-minimum";
  if (r.includes("never copied the original buy") || r.includes("missed entry")) return "no-position-to-sell";
  if (r.includes("malformed")) return "malformed";
  if (r.includes("resolved/closed") || r.includes("market is resolved")) return "market-resolved";
  if (r.includes("could not fetch") || r.includes("blocked") || r.includes("rejected") || r.includes("error")) {
    return "execution-error";
  }
  return "other";
}

function buildTraderSnapshot(trade: TraderTrade, trader: FollowedTrader | null): TraderQualitySnapshot {
  const cs = trader?.copyScore ?? null;
  return {
    wallet: trade.wallet,
    name: trade.traderName || trader?.name || trade.wallet,
    weeklyPnlUsd: num(trader?.weeklyPnlUsd),
    weeklyVolumeUsd: num(trader?.weeklyVolumeUsd),
    weeklyTradeCount: num(trader?.weeklyTradeCount),
    // Polymarket's leaderboard exposes weekly figures here; 1d/7d/30d windows are
    // not in the followed-trader record, so they are recorded as null until a
    // richer trader-stats source is wired in.
    roi1d: null,
    roi7d: null,
    roi30d: null,
    ourCopyRoi: num(cs?.copyRoi),
    winRate: null,
    avgHoldMs: null,
    copyScore: num(cs?.score),
    copiedTradeCount: num(trader?.copiedTradeCount),
  };
}

function buildMarketSnapshot(trade: TraderTrade, market: Market | null): MarketSnapshot {
  const spread =
    market?.bestBid != null && market?.bestAsk != null
      ? Math.max(0, market.bestAsk - market.bestBid)
      : market?.spread != null && market.spread > 0
        ? market.spread
        : null;
  const outcomePrice = market?.outcomes.find((o) => o.tokenId === trade.tokenId)?.price ?? null;
  return {
    conditionId: trade.conditionId,
    tokenId: trade.tokenId,
    title: market?.question ?? trade.title ?? "(market)",
    slug: market?.slug ?? trade.conditionId ?? trade.tokenId,
    category: categorizeMarket(market, trade.title, undefined),
    outcome: trade.outcome,
    liquidityUsd: num(market?.liquidity),
    volumeUsd: num(market?.volume),
    volume24hrUsd: num(market?.volume24hr),
    spread,
    bid: num(market?.bestBid),
    ask: num(market?.bestAsk),
    midpoint: num(market?.midpoint),
    impliedProbability: outcomePrice,
    timeToResolutionMs: num(market?.timeToResolutionMs),
    resolvesAt: market?.endDate ?? null,
  };
}

export interface RecordDecisionInput {
  record: CopyTradeRecord;
  trade: TraderTrade;
  settings: BotSettings;
  state: BotState;
  trader: FollowedTrader | null;
  market: Market | null;
  capture: import("./types").DecisionCapture;
  positionsAfter: BotPosition[];
}

function actionOf(record: CopyTradeRecord): DecisionAction {
  if (record.status === "skipped") return "SKIP";
  if (record.status === "failed") return "FAIL";
  return record.side === "BUY" ? "BUY" : "SELL";
}

/** Build a DecisionRecord from a completed decision. Pure (no I/O). */
export function buildDecisionRecord(input: RecordDecisionInput): DecisionRecord {
  const { record, trade, settings, trader, market, capture, positionsAfter } = input;
  const now = record.processedAt || Date.now();

  const traderSnap = buildTraderSnapshot(trade, trader);
  const marketSnap = buildMarketSnapshot(trade, market);

  const leaderFillPrice = num(record.leaderPrice) ?? num(record.price);
  const ourFillPrice = num(record.botExecPrice) ?? num(record.effectivePrice) ?? num(record.price);
  const slippageCents =
    num(record.adverseMoveCents) ??
    (leaderFillPrice != null && ourFillPrice != null ? (ourFillPrice - leaderFillPrice) * 100 : null);

  const exposureAfterUsd = totalExposure(positionsAfter);

  const score = computeDecisionScore({
    settings,
    traderCopyScore: traderSnap.copyScore,
    traderWeeklyPnlUsd: traderSnap.weeklyPnlUsd,
    liquidityUsd: marketSnap.liquidityUsd,
    spread: marketSnap.spread,
    tradeAgeSec: num(capture.tradeAgeSec),
    slippageCents,
    price: num(record.price),
    volumeUsd: marketSnap.volumeUsd,
    timeToResolutionMs: marketSnap.timeToResolutionMs,
    marketExposureBeforeUsd: num(capture.marketExposureBeforeUsd),
    equityUsd: num(capture.equityUsd),
  });

  return {
    id: nextId("dec", now),
    ts: now,
    mode: record.mode,
    action: actionOf(record),
    status: record.status,
    copyRecordId: record.id,
    sourceTradeId: record.sourceTradeId,
    side: record.side,
    tokenId: trade.tokenId,
    copiedWallet: trade.wallet,
    trader: traderSnap,
    market: marketSnap,
    leaderFillPrice,
    ourFillPrice,
    slippageCents,
    effectivePrice: num(record.effectivePrice),
    feeUsd: num(record.feeUsd),
    frictionUsd: num(record.frictionUsd),
    sourceSizeShares: record.sourceSize,
    sourceAmountUsd: record.sourceAmountUsd,
    copyAmountUsd: record.copyAmountUsd,
    copiedShares: record.copiedShares,
    realizedPnlUsd: record.realizedPnlUsd,
    tradeAgeSec: num(capture.tradeAgeSec),
    exposureBeforeUsd: num(capture.exposureBeforeUsd),
    exposureAfterUsd,
    marketExposureBeforeUsd: num(capture.marketExposureBeforeUsd),
    availableCashUsd: num(capture.availableCashUsd),
    equityUsd: num(capture.equityUsd),
    liveBalanceUsd: capture.liveBalanceUsd ?? null,
    requestedAmountUsd: num(capture.requestedAmountUsd),
    perMarketCapUsd: num(capture.perMarketCapUsd),
    totalCapUsd: num(capture.totalCapUsd),
    dailyPnlUsd: num(capture.dailyPnlUsd),
    reasonCode: reasonCodeOf(record.reason),
    reason: record.reason,
    score,
  };
}

/** Build + append a decision record. Best-effort; never throws. */
export async function recordDecision(input: RecordDecisionInput): Promise<void> {
  try {
    const decision = buildDecisionRecord(input);
    await appendNdjson(ANALYTICS_FILES.decisions, decision);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.warn("[analytics] recordDecision failed:", err);
  }
}

/**
 * Build a SELL DecisionRecord for a bot-autonomous exit (auto-exit, leader-exit,
 * flatten/panic, redemption, settlement) from its CopyTradeRecord. These exits
 * never flow through the normal decision path, so this is how they enter the
 * analytics streams and let round-trips close. Pure (no I/O).
 */
export function buildExitRecord(
  record: CopyTradeRecord,
  exitSource: NonNullable<DecisionRecord["exitSource"]>,
  sourceWallets?: string[],
): DecisionRecord {
  const now = record.processedAt || Date.now();
  const exitPrice = num(record.effectivePrice) ?? num(record.price);
  const wallet = record.traderWallet || sourceWallets?.[0] || "";
  const emptyScore = computeDecisionScore({
    settings: { maxTradeAmountUsd: 0 } as never,
    traderCopyScore: null,
    traderWeeklyPnlUsd: null,
    liquidityUsd: null,
    spread: null,
    tradeAgeSec: null,
    slippageCents: null,
    price: num(record.price),
    volumeUsd: null,
    timeToResolutionMs: null,
    marketExposureBeforeUsd: null,
    equityUsd: null,
  });

  return {
    id: nextId("exit", now),
    ts: now,
    mode: record.mode,
    action: "SELL",
    status: record.status,
    copyRecordId: record.id,
    sourceTradeId: record.sourceTradeId,
    side: "SELL",
    tokenId: record.tokenId,
    copiedWallet: wallet,
    trader: {
      wallet,
      name: record.traderName || wallet || exitSource,
      weeklyPnlUsd: null,
      weeklyVolumeUsd: null,
      weeklyTradeCount: null,
      roi1d: null,
      roi7d: null,
      roi30d: null,
      ourCopyRoi: null,
      winRate: null,
      avgHoldMs: null,
      copyScore: null,
      copiedTradeCount: null,
    },
    market: {
      conditionId: record.conditionId,
      tokenId: record.tokenId,
      title: record.marketTitle,
      slug: record.marketSlug,
      category: categorizeMarket(null, record.marketTitle, record.marketSlug),
      outcome: record.outcome,
      liquidityUsd: null,
      volumeUsd: null,
      volume24hrUsd: null,
      spread: null,
      bid: null,
      ask: null,
      midpoint: null,
      impliedProbability: null,
      timeToResolutionMs: null,
      resolvesAt: null,
    },
    leaderFillPrice: null,
    ourFillPrice: exitPrice,
    slippageCents: null,
    effectivePrice: exitPrice,
    feeUsd: num(record.feeUsd),
    frictionUsd: num(record.frictionUsd),
    sourceSizeShares: record.sourceSize,
    sourceAmountUsd: record.sourceAmountUsd,
    copyAmountUsd: record.copyAmountUsd,
    copiedShares: record.copiedShares,
    realizedPnlUsd: record.realizedPnlUsd,
    tradeAgeSec: null,
    exposureBeforeUsd: null,
    exposureAfterUsd: null,
    marketExposureBeforeUsd: null,
    availableCashUsd: null,
    equityUsd: null,
    liveBalanceUsd: null,
    requestedAmountUsd: null,
    perMarketCapUsd: null,
    totalCapUsd: null,
    dailyPnlUsd: null,
    reasonCode: `exit-${exitSource}`,
    reason: record.reason,
    exitSource,
    score: emptyScore,
  };
}

/** Build + append an exit record to the exits stream. Best-effort; never throws. */
export async function recordExit(
  record: CopyTradeRecord,
  exitSource: NonNullable<DecisionRecord["exitSource"]>,
  sourceWallets?: string[],
): Promise<void> {
  try {
    // Only filled exits matter for round-trip pairing; ignore skipped/failed sells.
    if (record.status !== "copied" && record.status !== "simulated") return;
    if (record.copiedShares <= 0) return;
    const exit = buildExitRecord(record, exitSource, sourceWallets);
    await appendNdjson(ANALYTICS_FILES.exits, exit);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.warn("[analytics] recordExit failed:", err);
  }
}

/**
 * Append a timeline snapshot for each open position. Uses the already-refreshed
 * mark prices on the positions, so it adds no network calls. The optional market
 * map (tokenId -> Market) enriches snapshots with live liquidity/spread when the
 * caller already has it; otherwise those fields are null.
 */
export async function recordPositionSnapshots(
  positions: BotPosition[],
  mode: BotSettings["mode"],
  markets?: Map<string, Market | null>,
): Promise<void> {
  if (positions.length === 0) return;
  try {
    const now = Date.now();
    for (const p of positions) {
      const market = markets?.get(p.tokenId) ?? null;
      const exposureUsd = positionExposure(p);
      const costBasisUsd = positionCostBasis(p);
      const unrealizedPnlUsd = exposureUsd - costBasisUsd;
      const spread =
        market?.bestBid != null && market?.bestAsk != null
          ? Math.max(0, market.bestAsk - market.bestBid)
          : null;
      const snapshot: PositionSnapshot = {
        id: nextId("snap", now),
        ts: now,
        mode,
        tokenId: p.tokenId,
        conditionId: p.conditionId,
        marketTitle: p.marketTitle,
        category: categorizeMarket(market, p.marketTitle, p.marketSlug),
        outcome: p.outcome,
        shares: p.shares,
        avgPrice: p.avgPrice,
        markPrice: p.markPrice,
        exposureUsd,
        costBasisUsd,
        unrealizedPnlUsd,
        roi: costBasisUsd > 0 ? unrealizedPnlUsd / costBasisUsd : 0,
        leaderHolds: p.leaderHolds ?? null,
        liquidityUsd: num(market?.liquidity),
        spread,
        sourceWallets: p.sourceWallets,
      };
      await appendNdjson(ANALYTICS_FILES.snapshots, snapshot);
    }
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.warn("[analytics] recordPositionSnapshots failed:", err);
  }
}
