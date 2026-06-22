/**
 * Authoritative ledger helpers.
 *
 * Live copy records are first written from a local *mirror estimate* at order
 * time (copyAmountUsd / copiedShares / effectivePrice). Reconciliation later
 * annotates them with the REAL fills (actualFilledShares / actualAvgPrice /
 * actualNotionalUsd) and a reconciliationStatus. Accounting, PnL, positions, and
 * wallet scoring must prefer those authoritative fields once they exist, and must
 * treat a real order whose fills are not yet confirmed as unsafe — never as a
 * settled mirror number.
 *
 * Simulated records are always authoritative for the simulator's own ledger.
 */
import type { CopyTradeRecord } from "./types";

/** A real copied order whose fills are confirmed against the CLOB. */
export function tradeIsAuthoritative(record: CopyTradeRecord): boolean {
  if (record.mode !== "real" || record.status !== "copied") return false;
  return record.reconciliationStatus === "matched" || record.reconciliationStatus === "partial-match";
}

/**
 * A real copied order whose fills are NOT yet trustworthy for accounting:
 * pending (just placed / not reconciled), unmatched (CLOB shows no fill), or
 * error (could not verify). These must reserve cash conservatively and block new
 * BUYs — they must never be reported as final realized results.
 */
export function tradeIsUnsafeForAccounting(record: CopyTradeRecord): boolean {
  if (record.mode !== "real" || record.status !== "copied") return false;
  const status = record.reconciliationStatus;
  return status == null || status === "pending" || status === "unmatched" || status === "error";
}

/** Shares for the record: authoritative fill when reconciled, else mirror estimate. */
export function tradeFilledShares(record: CopyTradeRecord): number {
  if (tradeIsAuthoritative(record) && record.actualFilledShares != null) return record.actualFilledShares;
  return record.copiedShares;
}

/** USD notional for the record: authoritative when reconciled, else mirror estimate. */
export function tradeNotionalUsd(record: CopyTradeRecord): number {
  if (tradeIsAuthoritative(record) && record.actualNotionalUsd != null) return record.actualNotionalUsd;
  return record.copyAmountUsd;
}

/** Per-share price for the record: authoritative when reconciled, else best local estimate. */
export function tradeAvgPrice(record: CopyTradeRecord): number {
  if (tradeIsAuthoritative(record) && record.actualAvgPrice != null) return record.actualAvgPrice;
  return record.effectivePrice ?? record.price;
}

/** Provenance of a record's numbers, for display + confidence reporting. */
export type RealizedPnlSource = "simulated" | "local-mirror" | "authoritative-clob";

export function realizedPnlSource(record: CopyTradeRecord): RealizedPnlSource {
  if (record.mode !== "real") return "simulated";
  return tradeIsAuthoritative(record) ? "authoritative-clob" : "local-mirror";
}

export function isFilled(record: CopyTradeRecord): boolean {
  return record.status === "simulated" || record.status === "copied";
}
