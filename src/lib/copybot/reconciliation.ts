/**
 * Authoritative live-fill reconciliation.
 *
 * Real-mode copy records are created from a local mirror estimate at order time
 * (see liveClob.placeLiveMarketOrder). That estimate is fine for instant UI, but
 * it is NOT the truth. This module pulls the account's authoritative CLOB trade
 * history and matches it back onto the local ledger so each live order carries
 * the REAL filled shares / average price / notional / tx hashes — or is flagged
 * `unmatched` when the CLOB reports no fill at all.
 *
 * It never mutates positions and never places orders; it only annotates records.
 * Position truth in real mode comes from the live account positions reconciler.
 */
import { fetchLiveTrades, type LiveTradeFill } from "@/lib/execution/liveClob";
import type { CopyTradeRecord, ReconciliationStatus } from "./types";

export interface ReconciliationSummary {
  ran: boolean;
  fetchedFills: number;
  matched: number;
  partial: number;
  unmatched: number;
  errored: number;
  error: string | null;
}

/** Fuzzy match window when no order id is available to tie a fill to a record. */
const MATCH_TIME_WINDOW_MS = 15 * 60 * 1000;

function isReconcilable(record: CopyTradeRecord): boolean {
  return record.mode === "real" && record.status === "copied";
}

/** Count live orders not yet authoritatively reconciled (matched/partial-match). */
export function countUnreconciledLiveOrders(records: CopyTradeRecord[]): number {
  return records.filter(
    (r) =>
      isReconcilable(r) &&
      r.reconciliationStatus !== "matched" &&
      r.reconciliationStatus !== "partial-match",
  ).length;
}

const emptySummary: ReconciliationSummary = {
  ran: false,
  fetchedFills: 0,
  matched: 0,
  partial: 0,
  unmatched: 0,
  errored: 0,
  error: null,
};

/**
 * Reconcile real-mode copy records against authoritative CLOB fills. Returns a
 * new records array (already-`matched` records are left untouched) plus a summary.
 */
export async function reconcileLiveTrades(
  records: CopyTradeRecord[],
  now = Date.now(),
): Promise<{ records: CopyTradeRecord[]; summary: ReconciliationSummary }> {
  const targets = records.filter(isReconcilable);
  if (targets.length === 0) return { records, summary: { ...emptySummary } };

  let fills: LiveTradeFill[];
  try {
    fills = await fetchLiveTrades();
  } catch (err) {
    // Couldn't verify against the CLOB. Flag unverified records as `error` so the
    // dashboard surfaces the gap, but don't fabricate or drop fill data.
    const updated = records.map((record) =>
      isReconcilable(record) && record.reconciliationStatus !== "matched"
        ? { ...record, reconciliationStatus: "error" as ReconciliationStatus, reconciledAt: now }
        : record,
    );
    return {
      records: updated,
      summary: {
        ...emptySummary,
        ran: true,
        errored: targets.length,
        error: err instanceof Error ? err.message : String(err),
      },
    };
  }

  const byOrder = new Map<string, LiveTradeFill[]>();
  for (const fill of fills) {
    if (!fill.orderId) continue;
    const arr = byOrder.get(fill.orderId) ?? [];
    arr.push(fill);
    byOrder.set(fill.orderId, arr);
  }

  // A given CLOB fill must not be counted toward more than one local record.
  const usedFillIds = new Set<string>();
  let matched = 0;
  let partial = 0;
  let unmatched = 0;

  const updated = records.map((record) => {
    if (!isReconcilable(record)) return record;
    if (record.reconciliationStatus === "matched") return record;

    let group: LiveTradeFill[] = [];
    let status: ReconciliationStatus = "unmatched";

    // 1) Authoritative match by taker order id.
    if (record.txOrOrderId && byOrder.has(record.txOrOrderId)) {
      group = byOrder.get(record.txOrOrderId)!.filter((fill) => !usedFillIds.has(fill.id));
      if (group.length > 0) status = "matched";
    }

    // 2) Heuristic fallback: same token + side within a time window.
    if (group.length === 0) {
      group = fills.filter(
        (fill) =>
          !usedFillIds.has(fill.id) &&
          fill.tokenId === record.tokenId &&
          fill.side === record.side &&
          (fill.matchTimeMs == null || Math.abs(fill.matchTimeMs - record.processedAt) <= MATCH_TIME_WINDOW_MS),
      );
      if (group.length > 0) status = "partial-match";
    }

    if (group.length === 0) {
      unmatched += 1;
      return { ...record, reconciliationStatus: "unmatched" as ReconciliationStatus, reconciledAt: now };
    }

    for (const fill of group) usedFillIds.add(fill.id);
    const shares = group.reduce((sum, fill) => sum + fill.shares, 0);
    const notional = group.reduce((sum, fill) => sum + fill.notionalUsd, 0);
    const txHashes = [...new Set(group.flatMap((fill) => fill.txHashes))];
    if (status === "matched") matched += 1;
    else partial += 1;

    return {
      ...record,
      reconciliationStatus: status,
      reconciledAt: now,
      actualFilledShares: shares,
      actualAvgPrice: shares > 0 ? notional / shares : 0,
      actualNotionalUsd: notional,
      txHashes: txHashes.length > 0 ? txHashes : record.txHashes,
    };
  });

  return {
    records: updated,
    summary: { ...emptySummary, ran: true, fetchedFills: fills.length, matched, partial, unmatched },
  };
}
