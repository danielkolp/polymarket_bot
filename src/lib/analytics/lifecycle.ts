/**
 * Lifecycle analytics:
 *   - {@link buildCompletedTrades}: round-trip (entry→exit) copied trades derived
 *     from the decision log and enriched with max unrealized gain/loss from the
 *     position-snapshot timeline. Pure derivation — computed on read, persisted
 *     incrementally nowhere, so it adds no runtime overhead to the trading loop.
 *   - {@link updateMissedOpportunities}: resolves skipped BUYs ("would this have
 *     been profitable?") in small bounded batches, persisting results to NDJSON.
 */
import type { Market } from "@/lib/polymarket/types";
import { ANALYTICS_FILES, appendNdjson, readNdjson, readResolvedSet, writeResolvedSet } from "./store";
import type { CompletedTrade, DecisionRecord, MissedOpportunity, PositionSnapshot } from "./types";

interface OpenLot {
  shares: number;
  price: number; // effective entry price/share
  ts: number;
  slippageCents: number | null;
}

/**
 * Reconstruct completed round-trip trades per token by FIFO-matching filled SELL
 * decisions against filled BUY lots. `decisions` may be passed in (caller already
 * loaded them) or loaded here.
 */
export async function buildCompletedTrades(
  decisions?: DecisionRecord[],
  exits?: DecisionRecord[],
): Promise<CompletedTrade[]> {
  // Entries + leader-copy SELLs come from the decision log; bot-autonomous exits
  // (auto-exit / leader-exit / flatten / redeem / settlement) come from the exits
  // stream. Merging both is what lets real-mode round-trips actually close.
  const decisionRows = decisions ?? (await readNdjson<DecisionRecord>(ANALYTICS_FILES.decisions));
  const exitRows = exits ?? (await readNdjson<DecisionRecord>(ANALYTICS_FILES.exits));
  const filled = [...decisionRows, ...exitRows]
    .filter((d) => d.status === "simulated" || d.status === "copied")
    .sort((a, b) => a.ts - b.ts);

  const snapshots = await readNdjson<PositionSnapshot>(ANALYTICS_FILES.snapshots);
  const snapsByToken = new Map<string, PositionSnapshot[]>();
  for (const s of snapshots) {
    const arr = snapsByToken.get(s.tokenId) ?? [];
    arr.push(s);
    snapsByToken.set(s.tokenId, arr);
  }

  const openByToken = new Map<string, OpenLot[]>();
  const completed: CompletedTrade[] = [];

  for (const d of filled) {
    const entryPrice = d.effectivePrice ?? d.ourFillPrice ?? d.leaderFillPrice ?? 0;
    if (d.side === "BUY") {
      if (d.copiedShares <= 0) continue;
      const lots = openByToken.get(d.tokenId) ?? [];
      lots.push({ shares: d.copiedShares, price: entryPrice || 0, ts: d.ts, slippageCents: d.slippageCents });
      openByToken.set(d.tokenId, lots);
      continue;
    }

    // SELL: consume open lots FIFO.
    let remaining = d.copiedShares;
    const exitPrice = entryPrice || (d.copyAmountUsd > 0 && d.copiedShares > 0 ? d.copyAmountUsd / d.copiedShares : 0);
    const lots = openByToken.get(d.tokenId) ?? [];
    while (remaining > 1e-9 && lots.length > 0) {
      const lot = lots[0];
      const matched = Math.min(remaining, lot.shares);
      const costBasisUsd = matched * lot.price;
      const proceedsUsd = matched * exitPrice;
      const realizedPnlUsd = proceedsUsd - costBasisUsd;
      const tokenSnaps = (snapsByToken.get(d.tokenId) ?? []).filter((s) => s.ts >= lot.ts && s.ts <= d.ts);
      const unreal = tokenSnaps.map((s) => (s.markPrice - lot.price) * matched);
      const leaderHeldDuring = tokenSnaps.map((s) => s.leaderHolds);
      const leaderExitedFirst = leaderHeldDuring.includes("no") ? true : leaderHeldDuring.includes("yes") ? false : null;

      completed.push({
        tokenId: d.tokenId,
        conditionId: d.market.conditionId,
        marketTitle: d.market.title,
        category: d.market.category,
        outcome: d.market.outcome,
        copiedWallet: d.copiedWallet,
        entryTs: lot.ts,
        exitTs: d.ts,
        holdMs: d.ts - lot.ts,
        entryPrice: lot.price,
        exitPrice,
        shares: matched,
        costBasisUsd,
        proceedsUsd,
        realizedPnlUsd,
        roi: costBasisUsd > 0 ? realizedPnlUsd / costBasisUsd : 0,
        maxUnrealizedGainUsd: unreal.length ? Math.max(0, ...unreal) : null,
        maxUnrealizedLossUsd: unreal.length ? Math.min(0, ...unreal) : null,
        ourRoi: costBasisUsd > 0 ? realizedPnlUsd / costBasisUsd : 0,
        entrySlippageCents: lot.slippageCents,
        exitReason: d.reason,
        leaderExitedFirst,
        marketOutcome: exitPrice >= 0.9 ? "won" : exitPrice <= 0.1 ? "lost" : "unknown",
      });

      lot.shares -= matched;
      remaining -= matched;
      if (lot.shares <= 1e-9) lots.shift();
    }
    openByToken.set(d.tokenId, lots);
  }

  return completed;
}

export interface MissedOptions {
  /** Only resolve skips at least this old (default 24h). */
  minAgeMs?: number;
  /** Max skips to resolve per call, to bound network + CPU (default 8). */
  batchSize?: number;
  /** Fetch a market by token id (injected so this module stays I/O-agnostic). */
  fetchMarket: (tokenId: string) => Promise<Market | null>;
}

/**
 * Resolve a bounded batch of previously-skipped BUY decisions into missed-
 * opportunity records. Idempotent via a persisted resolved-id set. Best-effort:
 * any per-item failure is swallowed so a flaky market lookup never blocks others.
 */
export async function updateMissedOpportunities(opts: MissedOptions): Promise<number> {
  const minAgeMs = opts.minAgeMs ?? 24 * 60 * 60 * 1000;
  const batchSize = opts.batchSize ?? 8;
  const now = Date.now();

  const resolved = await readResolvedSet();
  const decisions = await readNdjson<DecisionRecord>(ANALYTICS_FILES.decisions, {
    filter: (d) => d.action === "SKIP" && d.side === "BUY",
  });

  const snapshots = await readNdjson<PositionSnapshot>(ANALYTICS_FILES.snapshots);
  const snapsByToken = new Map<string, PositionSnapshot[]>();
  for (const s of snapshots) {
    const arr = snapsByToken.get(s.tokenId) ?? [];
    arr.push(s);
    snapsByToken.set(s.tokenId, arr);
  }

  const pending = decisions
    .filter((d) => !resolved.has(d.id) && now - d.ts >= minAgeMs)
    .slice(0, batchSize);
  if (pending.length === 0) return 0;

  let count = 0;
  for (const d of pending) {
    try {
      const market = await opts.fetchMarket(d.tokenId);
      const entryPrice = d.leaderFillPrice ?? d.ourFillPrice ?? d.market.impliedProbability ?? 0;
      const settled = marketSettlement(market, d.tokenId);
      const outcomePrice = market?.outcomes.find((o) => o.tokenId === d.tokenId)?.price ?? null;
      const laterPrice = settled != null ? settled : outcomePrice ?? market?.midpoint ?? entryPrice;
      const basis: MissedOpportunity["basis"] = settled != null ? "resolved" : "elapsed";
      const finalOutcome: MissedOpportunity["finalOutcome"] =
        settled != null ? (settled >= 0.5 ? "won" : "lost") : market?.closed ? "unknown" : "open";

      const roiIfCopied = entryPrice > 0 ? (laterPrice - entryPrice) / entryPrice : 0;
      const tokenSnaps = snapsByToken.get(d.tokenId) ?? [];
      const unreal = tokenSnaps.filter((s) => s.ts >= d.ts).map((s) => s.markPrice - entryPrice);

      const missed: MissedOpportunity = {
        decisionId: d.id,
        resolvedAt: now,
        tokenId: d.tokenId,
        conditionId: d.market.conditionId,
        marketTitle: d.market.title,
        category: d.market.category,
        outcome: d.market.outcome,
        copiedWallet: d.copiedWallet,
        skipReasonCode: d.reasonCode,
        skipReason: d.reason,
        entryPrice,
        laterPrice,
        finalOutcome,
        roiIfCopied,
        wouldHaveBeenProfitable: laterPrice > entryPrice,
        maxUnrealizedProfit: unreal.length ? Math.max(0, ...unreal) : null,
        maxUnrealizedLoss: unreal.length ? Math.min(0, ...unreal) : null,
        basis,
      };
      await appendNdjson(ANALYTICS_FILES.missed, missed);
      // Only mark "resolved" permanently once the market actually settled; an
      // elapsed-but-open market is re-evaluated on a later pass so we capture the
      // final outcome rather than a midpoint snapshot.
      if (basis === "resolved") resolved.add(d.id);
      count += 1;
    } catch {
      // Swallow per-item failures; retry on a later pass.
    }
  }

  await writeResolvedSet(resolved);
  return count;
}

/** Settlement payout/share (1 won, 0 lost) for a definitively resolved market. */
function marketSettlement(market: Market | null, tokenId: string): number | null {
  if (!market || market.closed !== true) return null;
  const outcome = market.outcomes.find((o) => o.tokenId === tokenId);
  if (!outcome || outcome.price == null || !Number.isFinite(outcome.price)) return null;
  if (outcome.price >= 0.9) return 1;
  if (outcome.price <= 0.1) return 0;
  return null;
}
