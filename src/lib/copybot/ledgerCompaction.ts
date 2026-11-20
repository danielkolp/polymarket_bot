/**
 * P&L-preserving trade-ledger compaction.
 *
 * Cash/equity are derived from `startingBalance + Σ realizedPnl(filled trades)
 * − open cost basis`. The ledger used to be truncated to the newest N rows, and
 * most rows are *skipped* decisions, so filled trades (and their realized P&L)
 * silently fell off the end. That shifted cash/equity, and a dropped winner
 * looked like a same-day loss — enough to trip the daily-loss lockout.
 *
 * Compaction now:
 *  - never touches live orders that are still unsafe for accounting (pending /
 *    unmatched / error) — reconciliation needs them;
 *  - trims non-filled rows (skipped/failed/dry-run) first;
 *  - folds the oldest filled rows into one "carry" record per (wallet, mode)
 *    that holds their summed realized P&L, so Σ realizedPnl is exactly preserved.
 */
import { isFilled, tradeIsUnsafeForAccounting } from "./ledger";
import type { CopyTradeRecord } from "./types";

export const LEDGER_CARRY_TRADER = "ledger-carry";

export const DEFAULT_MAX_FILLED_TRADES = 2500;
export const DEFAULT_MAX_OTHER_TRADES = 500;

export function isCarryRecord(record: CopyTradeRecord): boolean {
  return record.traderName === LEDGER_CARRY_TRADER;
}

function carryKey(record: Pick<CopyTradeRecord, "traderWallet" | "mode">): string {
  return `${record.traderWallet.toLowerCase()}|${record.mode}`;
}

function makeCarry(wallet: string, mode: CopyTradeRecord["mode"], realizedPnlUsd: number, folded: number, oldestTs: number): CopyTradeRecord {
  return {
    id: `carry_${mode}_${wallet || "none"}`,
    sourceTradeId: `ledger-carry:${mode}:${wallet}`,
    status: mode === "real" ? "copied" : "simulated",
    mode,
    traderWallet: wallet,
    traderName: LEDGER_CARRY_TRADER,
    side: "SELL",
    tokenId: "",
    conditionId: "",
    marketSlug: "",
    marketTitle: "(archived trades)",
    outcome: "",
    price: 0,
    sourceSize: 0,
    sourceAmountUsd: 0,
    copyAmountUsd: 0,
    copiedShares: 0,
    realizedPnlUsd,
    reason: `Archived realized P&L of ${folded} older filled trade(s).`,
    txOrOrderId: "",
    sourceTimestamp: oldestTs,
    processedAt: oldestTs,
    // Real-mode carries are authoritative summaries, never "pending".
    ...(mode === "real" ? { reconciliationStatus: "matched" as const } : {}),
    foldedTradeCount: folded,
  };
}

/**
 * Compact a newest-first trade ledger. Returns the input unchanged when it is
 * within limits. Σ realizedPnlUsd over filled rows is invariant.
 */
export function compactTrades(
  trades: CopyTradeRecord[],
  opts: { maxFilled?: number; maxOther?: number } = {},
): CopyTradeRecord[] {
  const maxFilled = opts.maxFilled ?? DEFAULT_MAX_FILLED_TRADES;
  const maxOther = opts.maxOther ?? DEFAULT_MAX_OTHER_TRADES;

  let filledCount = 0;
  let otherCount = 0;
  for (const t of trades) {
    if (isCarryRecord(t) || tradeIsUnsafeForAccounting(t)) continue;
    if (isFilled(t)) filledCount += 1;
    else otherCount += 1;
  }
  if (filledCount <= maxFilled && otherCount <= maxOther) return trades;

  const kept: CopyTradeRecord[] = [];
  const carries = new Map<string, CopyTradeRecord>();
  for (const t of trades) {
    if (isCarryRecord(t)) carries.set(carryKey(t), t);
  }

  let keptFilled = 0;
  let keptOther = 0;
  for (const t of trades) {
    if (isCarryRecord(t)) continue;
    if (tradeIsUnsafeForAccounting(t)) {
      kept.push(t);
      continue;
    }
    if (isFilled(t)) {
      if (keptFilled < maxFilled) {
        keptFilled += 1;
        kept.push(t);
        continue;
      }
      // Fold into the (wallet, mode) carry, preserving realized P&L exactly.
      const key = carryKey(t);
      const prior = carries.get(key);
      const folded = (prior?.foldedTradeCount ?? 0) + 1;
      const pnl = (prior?.realizedPnlUsd ?? 0) + (Number.isFinite(t.realizedPnlUsd) ? t.realizedPnlUsd : 0);
      const oldest = Math.min(prior?.processedAt ?? Number.MAX_SAFE_INTEGER, t.processedAt);
      carries.set(key, makeCarry(t.traderWallet.toLowerCase(), t.mode, pnl, folded, oldest));
      continue;
    }
    if (keptOther < maxOther) {
      keptOther += 1;
      kept.push(t);
    }
    // Excess skipped/failed rows carry no P&L and are simply dropped.
  }

  return [...kept, ...carries.values()];
}
