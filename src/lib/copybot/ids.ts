/** Shared id helpers for ledger records. Kept standalone to avoid import cycles. */
export function recordId(now = Date.now()): string {
  return `copy_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
