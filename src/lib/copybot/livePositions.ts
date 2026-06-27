/**
 * Authoritative live-position reconciliation (real mode).
 *
 * Simulation positions are local. Real positions must come from the live
 * account, so before any live copy trade the bot loads the account's current
 * positions, cross-references them against the local ledger, and classifies each
 * one. The reconciled set becomes the authoritative basis for exposure caps so
 * the bot can never buy into a market while ignoring an existing live position.
 *
 * READ-ONLY against Polymarket — this fetches positions, it never trades.
 */
import { getLiveAccountAddress } from "@/lib/execution/liveClob";
import { fetchUserPositions, type AccountPosition } from "@/lib/polymarket/positions";
import { clampPrice } from "./accounting";
import type {
  BotPosition,
  FollowedTrader,
  LivePositionClassification,
  LivePositionEntry,
  LivePositionReconciliation,
} from "./types";

const DUST = 1e-6;

export interface LivePositionResult {
  snapshot: LivePositionReconciliation;
  /** Authoritative positions for real-mode exposure/marks (derived from the account). */
  positions: BotPosition[];
}

export function emptyLiveReconciliation(error: string | null, now = Date.now()): LivePositionReconciliation {
  return {
    fetchedAt: now,
    ok: error == null,
    error,
    entries: [],
    totalLiveExposureUsd: 0,
    unattributedExposureUsd: 0,
    unknownPositionCount: 0,
    stalePositionCount: 0,
    redeemableCount: 0,
  };
}

/**
 * Fetch the live account positions and reconcile against the local ledger.
 * Returns a classification snapshot plus authoritative BotPositions. Account
 * size/mark/cost basis come from Polymarket; local data is only used for
 * metadata and source-wallet attribution when a matching position exists.
 */
export async function reconcileLivePositions(
  localPositions: BotPosition[],
  traders: FollowedTrader[],
  now = Date.now(),
): Promise<LivePositionResult> {
  const address = getLiveAccountAddress();
  const account = await fetchUserPositions(address);
  return reconcileAccountPositions(account, localPositions, traders, now);
}

export function reconcileAccountPositions(
  account: AccountPosition[],
  localPositions: BotPosition[],
  traders: FollowedTrader[],
  now = Date.now(),
): LivePositionResult {
  const localByToken = new Map(localPositions.map((p) => [p.tokenId, p]));
  const followed = new Set(traders.map((t) => t.wallet.toLowerCase()));
  const accountTokens = new Set(account.map((p) => p.tokenId));

  const entries: LivePositionEntry[] = [];
  const positions: BotPosition[] = [];

  let totalLiveExposureUsd = 0;
  let unattributedExposureUsd = 0;
  let unknownPositionCount = 0;
  let redeemableCount = 0;

  for (const accPos of account) {
    if (accPos.size <= DUST) continue;
    const local = localByToken.get(accPos.tokenId);
    const attributionKnown = Boolean(local && local.sourceWallets.some((w) => followed.has(w.toLowerCase())));

    // Resolved/redeemable positions are NOT open, tradeable risk: the market has
    // settled, Polymarket auto-redeems winners to cash, and losers sit at ~$0.
    // We still surface them in `entries` (and the redeemables plan), but never
    // adopt them into the authoritative open-positions book or count them as open
    // exposure — otherwise a resolved market lingers forever in "Open Positions".
    const resolved = accPos.redeemable;

    let classification: LivePositionClassification;
    if (local && local.shares > DUST) classification = "known-bot-position";
    else classification = "unknown-existing-position";
    // A resolved position is not an actionable "unknown live position", so it must
    // not count toward the unknown-position BUY block.
    if (classification === "unknown-existing-position" && !resolved) unknownPositionCount += 1;
    if (resolved) redeemableCount += 1;

    // Mark price: prefer the account's current price, fall back to local mark or
    // cost basis.
    const markPrice = clampPrice(accPos.curPrice ?? local?.markPrice ?? accPos.avgPrice ?? 0);
    const exposureUsd = Math.max(0, accPos.size * markPrice);
    if (!resolved) {
      totalLiveExposureUsd += exposureUsd;
      if (!attributionKnown) unattributedExposureUsd += exposureUsd;
    }

    entries.push({
      tokenId: accPos.tokenId,
      conditionId: accPos.conditionId || local?.conditionId || "",
      marketTitle: local?.marketTitle || accPos.title,
      outcome: local?.outcome || accPos.outcome,
      liveShares: accPos.size,
      localShares: local?.shares ?? 0,
      markPrice,
      exposureUsd,
      classification,
      attributionKnown,
      redeemable: accPos.redeemable,
      negativeRisk: accPos.negativeRisk,
    });

    if (resolved) continue; // surfaced above; not an open position

    // Authoritative position: account avg price is the source of truth for
    // real-mode P&L; local cost basis is only a fallback when the API omits it.
    const avgPrice = clampPrice(accPos.avgPrice ?? local?.avgPrice ?? markPrice);
    positions.push({
      tokenId: accPos.tokenId,
      conditionId: accPos.conditionId || local?.conditionId || "",
      marketSlug: local?.marketSlug || accPos.slug,
      marketTitle: local?.marketTitle || accPos.title,
      outcome: local?.outcome || accPos.outcome,
      shares: accPos.size,
      avgPrice,
      markPrice,
      realizedPnlUsd: local?.realizedPnlUsd ?? 0,
      openedAt: local?.openedAt ?? now,
      updatedAt: now,
      sourceWallets: local?.sourceWallets ?? [],
    });
  }

  // Local positions the account no longer reports are stale (resolved, redeemed,
  // or manually closed). They are surfaced but dropped from authoritative state.
  let stalePositionCount = 0;
  for (const local of localPositions) {
    if (local.shares <= DUST) continue;
    if (accountTokens.has(local.tokenId)) continue;
    stalePositionCount += 1;
    entries.push({
      tokenId: local.tokenId,
      conditionId: local.conditionId,
      marketTitle: local.marketTitle,
      outcome: local.outcome,
      liveShares: 0,
      localShares: local.shares,
      markPrice: clampPrice(local.markPrice),
      exposureUsd: 0,
      classification: "stale-local-position",
      attributionKnown: local.sourceWallets.some((w) => followed.has(w.toLowerCase())),
      redeemable: false,
      negativeRisk: false,
    });
  }

  const snapshot: LivePositionReconciliation = {
    fetchedAt: now,
    ok: true,
    error: null,
    entries,
    totalLiveExposureUsd,
    unattributedExposureUsd,
    unknownPositionCount,
    stalePositionCount,
    redeemableCount,
  };

  return { snapshot, positions };
}
