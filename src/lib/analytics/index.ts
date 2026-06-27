/**
 * Public surface of the analytics layer.
 *
 * The `analytics` object is the ONLY thing the trading loop touches. Every method
 * is self-guarding (best-effort, never throws), so wiring analytics into the bot
 * can never alter or break a trading decision. All work is observational.
 */
import { fetchMarketById } from "@/lib/polymarket/gamma";
import type { BotPosition, BotSettings } from "@/lib/copybot/types";
import type { Market } from "@/lib/polymarket/types";
import { recordDecision, recordExit, recordPositionSnapshots, type RecordDecisionInput } from "./recorder";
import { updateMissedOpportunities } from "./lifecycle";
import { ANALYTICS_FILES, compactIfLarge } from "./store";
import type { CopyTradeRecord } from "@/lib/copybot/types";
import type { DecisionRecord } from "./types";

export * from "./types";
export { recordDecision, recordExit, recordPositionSnapshots } from "./recorder";
export { buildCompletedTrades, updateMissedOpportunities } from "./lifecycle";
export { loadAnalyticsBundle, buildDashboardSummary } from "./aggregate";
export { buildAnalyticsExport } from "./export";
export { ANALYTICS_FILES, readNdjson } from "./store";

/**
 * Periodic maintenance, safe to call once per poll. Resolves a bounded batch of
 * missed opportunities (network-light) and compacts oversized NDJSON files.
 * Never throws.
 */
async function runMaintenance(): Promise<void> {
  try {
    await updateMissedOpportunities({
      fetchMarket: (tokenId: string): Promise<Market | null> => fetchMarketById(tokenId),
    });
    await Promise.all([
      compactIfLarge(ANALYTICS_FILES.decisions),
      compactIfLarge(ANALYTICS_FILES.exits),
      compactIfLarge(ANALYTICS_FILES.snapshots),
      compactIfLarge(ANALYTICS_FILES.missed),
    ]);
  } catch (err) {
    if (process.env.NODE_ENV !== "test") console.warn("[analytics] runMaintenance failed:", err);
  }
}

export const analytics = {
  /** Record one BUY/SELL/SKIP/FAIL decision with full context. Never throws. */
  recordDecision: (input: RecordDecisionInput): Promise<void> => recordDecision(input),
  /** Record a bot-autonomous exit so round-trips can close. Never throws. */
  recordExit: (
    record: CopyTradeRecord,
    exitSource: NonNullable<DecisionRecord["exitSource"]>,
    sourceWallets?: string[],
  ): Promise<void> => recordExit(record, exitSource, sourceWallets),
  /** Snapshot the open-position timeline. Never throws. */
  recordPositionSnapshots: (
    positions: BotPosition[],
    mode: BotSettings["mode"],
    markets?: Map<string, Market | null>,
  ): Promise<void> => recordPositionSnapshots(positions, mode, markets),
  /** Per-poll maintenance (missed-opp resolution + compaction). Never throws. */
  runMaintenance,
};
