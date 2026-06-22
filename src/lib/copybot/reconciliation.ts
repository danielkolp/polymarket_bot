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
 * Matching is conservative by design (see `matchLiveFills`):
 *   - exact taker-order-id matches are authoritative (`matched`);
 *   - heuristic (token/side/time) matching is OFF unless explicitly enabled, and
 *     even then can only ever produce a cautious `partial-match`;
 *   - a single CLOB fill is never counted toward more than one local record.
 *
 * It never mutates positions and never places orders; it only annotates records.
 */
import { config } from "@/lib/config";
import { fetchLiveTrades, type LiveTradeFill } from "@/lib/execution/liveClob";
import { tradeIsAuthoritative } from "./ledger";
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

export interface MatchOptions {
  /** Allow heuristic token/side/time matching. Default false (order-id only). */
  allowFuzzy?: boolean;
  /** Fuzzy match window in ms. */
  fuzzyWindowMs?: number;
}

const DEFAULT_FUZZY_WINDOW_MS = 15 * 60 * 1000;

function isReconcilable(record: CopyTradeRecord): boolean {
  return record.mode === "real" && record.status === "copied";
}

/** Count live orders not yet authoritatively reconciled (matched/partial-match). */
export function countUnreconciledLiveOrders(records: CopyTradeRecord[]): number {
  return records.filter((r) => isReconcilable(r) && !tradeIsAuthoritative(r)).length;
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
 * Pure matcher: annotate `records` with authoritative fills from `fills`.
 * Already-authoritative records are left untouched. Returns new records + counts.
 * Exported for direct unit testing without any network access.
 */
export function matchLiveFills(
  records: CopyTradeRecord[],
  fills: LiveTradeFill[],
  options: MatchOptions = {},
  now = Date.now(),
): { records: CopyTradeRecord[]; matched: number; partial: number; unmatched: number } {
  const allowFuzzy = options.allowFuzzy ?? false;
  const fuzzyWindowMs = options.fuzzyWindowMs ?? DEFAULT_FUZZY_WINDOW_MS;

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
    if (tradeIsAuthoritative(record)) return record;

    let group: LiveTradeFill[] = [];
    let status: ReconciliationStatus = "unmatched";

    // 1) Authoritative match by taker order id.
    if (record.txOrOrderId && byOrder.has(record.txOrOrderId)) {
      group = byOrder.get(record.txOrOrderId)!.filter((fill) => !usedFillIds.has(fill.id));
      if (group.length > 0) status = "matched";
    }

    // 2) Optional heuristic fallback — same token + side within a time window.
    //    Only ever yields a cautious `partial-match`, never `matched`. Refuses to
    //    guess when multiple distinct candidate orders exist (ambiguous).
    if (group.length === 0 && allowFuzzy) {
      const candidates = fills.filter(
        (fill) =>
          !usedFillIds.has(fill.id) &&
          fill.tokenId === record.tokenId &&
          fill.side === record.side &&
          (fill.matchTimeMs == null || Math.abs(fill.matchTimeMs - record.processedAt) <= fuzzyWindowMs),
      );
      const distinctOrders = new Set(candidates.map((c) => c.orderId ?? c.id));
      if (candidates.length > 0 && distinctOrders.size <= 1) {
        group = candidates;
        status = "partial-match";
      } else if (distinctOrders.size > 1) {
        // Ambiguous — do not guess. Surface as error for manual review.
        unmatched += 1;
        return { ...record, reconciliationStatus: "error" as ReconciliationStatus, reconciledAt: now };
      }
    }

    if (group.length === 0) {
      unmatched += 1;
      return { ...record, reconciliationStatus: "unmatched" as ReconciliationStatus, reconciledAt: now };
    }

    for (const fill of group) usedFillIds.add(fill.id);
    // Never attribute more shares than the local order intended.
    let shares = group.reduce((sum, fill) => sum + fill.shares, 0);
    let notional = group.reduce((sum, fill) => sum + fill.notionalUsd, 0);
    const intended = record.copiedShares;
    if (intended > 0 && shares > intended * 1.0001) {
      const scale = intended / shares;
      notional *= scale;
      shares = intended;
    }
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

  return { records: updated, matched, partial, unmatched };
}

/**
 * Reconcile real-mode copy records against authoritative CLOB fills. Returns a
 * new records array (already-authoritative records are left untouched) plus a
 * summary. Fetch/parse failures flag unverified records as `error` so the
 * dashboard surfaces the gap and new BUYs block — never fabricates fills.
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
    const updated = records.map((record) =>
      isReconcilable(record) && !tradeIsAuthoritative(record)
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

  const { records: updated, matched, partial, unmatched } = matchLiveFills(
    records,
    fills,
    { allowFuzzy: config.liveAllowFuzzyReconcile },
    now,
  );

  return {
    records: updated,
    summary: { ...emptySummary, ran: true, fetchedFills: fills.length, matched, partial, unmatched },
  };
}
