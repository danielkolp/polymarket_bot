/**
 * Redeemable Position Manager (pure).
 *
 * Turns an authoritative live-position snapshot into a plan of resolved/winning
 * positions eligible for on-chain redemption, enriched with the expected USDC
 * payout and whether the bot can redeem each one itself. Detection is pure and
 * fully unit-testable; the actual on-chain submission lives in the engine, which
 * combines this plan with @/lib/execution/liveRedeem.
 *
 * Invariants encoded here:
 *  - never include a position already redeemed (de-duped by tokenId);
 *  - never include a position that is not flagged `redeemable` by the account
 *    (i.e. unresolved or untradable-but-not-redeemable positions are excluded);
 *  - label (but still surface) positions the bot cannot redeem itself — proxy/
 *    safe wallets, neg-risk markets — so the operator can redeem them manually.
 */
import { recordId } from "./ids";
import { redeemBlockedReason } from "@/lib/execution/liveRedeem";
import type {
  BotMode,
  CopyTradeRecord,
  LivePositionReconciliation,
  RedeemBook,
  RedeemableItem,
  RedeemablePlan,
} from "./types";

/** Winning positions pay $1/share; expected payout = shares held. */
function expectedPayout(shares: number): number {
  return Math.max(0, shares);
}

/**
 * Build the redeemable plan from a live-position snapshot. Pure: no I/O. Pass the
 * persisted redeem book so already-redeemed positions are excluded.
 */
export function buildRedeemablePlan(
  snapshot: LivePositionReconciliation | null,
  redeemed: RedeemBook,
  mode: BotMode,
  now = Date.now(),
): RedeemablePlan {
  const base: RedeemablePlan = {
    fetchedAt: now,
    mode,
    items: [],
    redeemableCount: 0,
    manualCount: 0,
    totalExpectedPayoutUsd: 0,
    error: null,
  };

  if (mode !== "real") return base;
  if (!snapshot) return { ...base, error: "No live-position snapshot available yet." };
  if (!snapshot.ok) return { ...base, error: snapshot.error ?? "Live-position snapshot is in an error state." };

  const redeemedTokens = new Set(redeemed.entries.map((e) => e.tokenId));

  const items: RedeemableItem[] = [];
  for (const entry of snapshot.entries) {
    if (!entry.redeemable) continue; // only resolved/redeemable winnings
    if (entry.liveShares <= 0) continue;
    if (redeemedTokens.has(entry.tokenId)) continue; // double-redeem guard

    const blockedReason = redeemBlockedReason({ negativeRisk: entry.negativeRisk });
    items.push({
      tokenId: entry.tokenId,
      conditionId: entry.conditionId,
      marketTitle: entry.marketTitle,
      outcome: entry.outcome,
      shares: entry.liveShares,
      expectedPayoutUsd: expectedPayout(entry.liveShares),
      attributionKnown: entry.attributionKnown,
      classification: entry.classification,
      negativeRisk: entry.negativeRisk,
      blockedReason,
    });
  }

  items.sort((a, b) => b.expectedPayoutUsd - a.expectedPayoutUsd);

  return {
    ...base,
    items,
    redeemableCount: items.filter((i) => i.blockedReason == null).length,
    manualCount: items.filter((i) => i.blockedReason != null).length,
    totalExpectedPayoutUsd: items.reduce((sum, i) => sum + i.expectedPayoutUsd, 0),
  };
}

/**
 * Build the ledger record for a successful on-chain redemption. Modeled as a real
 * SELL settled at $1/share and pre-marked authoritative — it carries a real
 * on-chain tx hash, so live-fill reconciliation must leave it untouched (and it
 * must never be treated as an unreconciled order that blocks new BUYs).
 *
 * `costBasisUsd` is the local cost basis of the redeemed shares when known (so
 * realized P&L is payout − cost); pass 0 for unknown/manual positions.
 */
export function makeRedeemRecord(
  item: RedeemableItem,
  payoutUsd: number,
  costBasisUsd: number,
  txHash: string | null,
  now = Date.now(),
): CopyTradeRecord {
  return {
    id: recordId(now),
    sourceTradeId: `redeem:${item.conditionId}:${item.tokenId}`,
    status: "copied",
    mode: "real",
    traderWallet: "",
    traderName: "redeem",
    side: "SELL",
    tokenId: item.tokenId,
    conditionId: item.conditionId,
    marketSlug: "",
    marketTitle: item.marketTitle,
    outcome: item.outcome,
    price: 1,
    sourceSize: item.shares,
    sourceAmountUsd: payoutUsd,
    copyAmountUsd: payoutUsd,
    copiedShares: item.shares,
    realizedPnlUsd: payoutUsd - costBasisUsd,
    reason:
      `Redeemed resolved ${item.outcome} (${item.marketTitle}): ` +
      `${item.shares.toFixed(2)} share(s) → $${payoutUsd.toFixed(2)}` +
      (txHash ? ` [tx ${txHash.slice(0, 10)}…]` : "") +
      ".",
    txOrOrderId: txHash ?? "",
    sourceTimestamp: now,
    processedAt: now,
    // On-chain confirmed → authoritative; keeps it out of CLOB reconciliation.
    reconciliationStatus: "matched",
    reconciledAt: now,
    actualFilledShares: item.shares,
    actualAvgPrice: 1,
    actualNotionalUsd: payoutUsd,
    txHashes: txHash ? [txHash] : [],
  };
}
