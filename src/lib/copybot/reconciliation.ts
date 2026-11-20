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
import { fetchLiveOrder, fetchLiveTrades, type LiveOrderState, type LiveTradeFill } from "@/lib/execution/liveClob";
import { tradeIsAuthoritative } from "./ledger";
import type { CopyTradeRecord, ReconciliationStatus } from "./types";

export interface ReconciliationSummary {
  ran: boolean;
  fetchedFills: number;
  matched: number;
  partial: number;
  unmatched: number;
  errored: number;
  /** Orders the exchange confirmed never filled (cleared so they stop blocking). */
  voided: number;
  error: string | null;
}

/** After this long without any trace on the exchange, an order is treated as never filled. */
export const UNKNOWN_ORDER_VOID_MS = 10 * 60 * 1000;
/** Max per-order status lookups per reconciliation pass (rate-limit friendly). */
const MAX_ORDER_LOOKUPS = 6;
const DEAD_ORDER_STATUSES = new Set(["CANCELED", "CANCELLED", "UNMATCHED", "CANCELED_MARKET_RESOLVED", "EXPIRED", "KILLED"]);

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
  voided: 0,
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
 * Mark a copied live order as having never filled: it becomes a `failed`
 * record (no fill, excluded from accounting) so it stops blocking trading.
 */
export function voidLiveRecord(record: CopyTradeRecord, why: string, now = Date.now()): CopyTradeRecord {
  return {
    ...record,
    status: "failed",
    reconciliationStatus: "matched",
    reconciledAt: now,
    actualFilledShares: 0,
    actualNotionalUsd: 0,
    reason: `${record.reason} [No fill: ${why}]`,
  };
}

/**
 * Decide what to do with a still-unconfirmed order given its exchange state.
 * Pure — exported for tests.
 *  - "void": the exchange says it never filled (or it is unknown for too long)
 *  - "fill": the exchange reports a matched size we can record
 *  - "wait": still inconclusive
 */
export function classifyUnconfirmedOrder(
  record: CopyTradeRecord,
  order: LiveOrderState | null,
  now = Date.now(),
): { action: "void"; why: string } | { action: "fill"; shares: number; price: number } | { action: "wait" } {
  if (!record.txOrOrderId) return { action: "void", why: "no order id was returned" };
  const age = now - record.processedAt;
  if (order && order.sizeMatched > 0) {
    const price = order.price > 0 ? order.price : record.effectivePrice ?? record.price;
    return { action: "fill", shares: order.sizeMatched, price };
  }
  if (order && DEAD_ORDER_STATUSES.has(order.status)) {
    return { action: "void", why: `exchange status ${order.status}` };
  }
  if (age > UNKNOWN_ORDER_VOID_MS) {
    return { action: "void", why: order ? `still ${order.status || "unknown"} after 10 minutes` : "order unknown to the exchange after 10 minutes" };
  }
  return { action: "wait" };
}

/**
 * Reconcile real-mode copy records against authoritative CLOB fills, then ask
 * the exchange directly about any order that still has no trace. Orders that
 * never filled are voided so a single stuck record can no longer block trading
 * indefinitely. A failed history fetch leaves records as they were (it never
 * escalates them) and is reported in the summary.
 */
export async function reconcileLiveTrades(
  records: CopyTradeRecord[],
  now = Date.now(),
): Promise<{ records: CopyTradeRecord[]; summary: ReconciliationSummary }> {
  const unresolved = records.filter((r) => isReconcilable(r) && !tradeIsAuthoritative(r));
  if (unresolved.length === 0) return { records, summary: { ...emptySummary } };

  // Only walk trade history newer than the oldest unresolved order (minus slack).
  const sinceMs = Math.min(...unresolved.map((r) => r.processedAt)) - 60 * 60 * 1000;
  let fills: LiveTradeFill[] = [];
  let fetchError: string | null = null;
  try {
    fills = await fetchLiveTrades({ sinceMs });
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  let working = records;
  let matched = 0;
  let partial = 0;
  let unmatched = 0;
  if (!fetchError) {
    const res = matchLiveFills(records, fills, { allowFuzzy: config.liveAllowFuzzyReconcile }, now);
    working = res.records;
    matched = res.matched;
    partial = res.partial;
    unmatched = res.unmatched;
  }

  // Ask the exchange about orders still without a confirmed fill.
  let voided = 0;
  let lookups = 0;
  const out: CopyTradeRecord[] = [];
  for (const record of working) {
    if (!isReconcilable(record) || tradeIsAuthoritative(record)) {
      out.push(record);
      continue;
    }
    let order: LiveOrderState | null = null;
    let lookedUp = false;
    if (record.txOrOrderId && lookups < MAX_ORDER_LOOKUPS) {
      lookups += 1;
      try {
        order = await fetchLiveOrder(record.txOrOrderId);
        lookedUp = true;
      } catch {
        lookedUp = false;
      }
    }
    if (!lookedUp && record.txOrOrderId) {
      out.push(record);
      continue;
    }
    const verdict = classifyUnconfirmedOrder(record, order, now);
    if (verdict.action === "void") {
      voided += 1;
      if (unmatched > 0) unmatched -= 1;
      out.push(voidLiveRecord(record, verdict.why, now));
    } else if (verdict.action === "fill") {
      const shares = record.copiedShares > 0 ? Math.min(verdict.shares, record.copiedShares * 1.0001) : verdict.shares;
      partial += 1;
      if (unmatched > 0) unmatched -= 1;
      out.push({
        ...record,
        reconciliationStatus: "partial-match",
        reconciledAt: now,
        actualFilledShares: shares,
        actualAvgPrice: verdict.price,
        actualNotionalUsd: shares * verdict.price,
      });
    } else {
      out.push(record);
    }
  }

  return {
    records: out,
    summary: {
      ...emptySummary,
      ran: true,
      fetchedFills: fills.length,
      matched,
      partial,
      unmatched,
      voided,
      error: fetchError,
    },
  };
}
