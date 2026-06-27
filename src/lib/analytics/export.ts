/**
 * Export bundle: collapses every analytics stream + aggregation into a single
 * JSON document suitable for download and upload into an LLM for strategy
 * analysis. Also offers raw NDJSON passthrough for the individual streams.
 */
import type { BotPosition } from "@/lib/copybot/types";
import { loadAnalyticsBundle } from "./aggregate";

export interface AnalyticsExport {
  schemaVersion: number;
  generatedAt: number;
  account: { cashUsd: number; openPositions: number };
  dashboard: Awaited<ReturnType<typeof loadAnalyticsBundle>>["dashboard"];
  traders: Awaited<ReturnType<typeof loadAnalyticsBundle>>["traders"];
  categories: Awaited<ReturnType<typeof loadAnalyticsBundle>>["categories"];
  portfolio: Awaited<ReturnType<typeof loadAnalyticsBundle>>["portfolio"];
  correlation: Awaited<ReturnType<typeof loadAnalyticsBundle>>["correlation"];
  completedTrades: Awaited<ReturnType<typeof loadAnalyticsBundle>>["completed"];
  missedOpportunities: Awaited<ReturnType<typeof loadAnalyticsBundle>>["missed"];
  /** Full decision log, optionally capped for size. */
  decisions: Awaited<ReturnType<typeof loadAnalyticsBundle>>["decisions"];
  /** Bot-autonomous exit log. */
  exits: Awaited<ReturnType<typeof loadAnalyticsBundle>>["exits"];
}

export interface ExportOptions {
  /** Cap on raw decisions included (most recent kept). 0 = all. */
  maxDecisions?: number;
  /** Include the full decision log (default true). */
  includeDecisions?: boolean;
}

export async function buildAnalyticsExport(
  positions: BotPosition[],
  cashUsd: number,
  opts: ExportOptions = {},
): Promise<AnalyticsExport> {
  const bundle = await loadAnalyticsBundle(positions, cashUsd);
  const includeDecisions = opts.includeDecisions !== false;
  // The raw decision + exit logs are the only unbounded streams. When omitted
  // (compact mode, e.g. the daily public digest) drop both — the aggregations,
  // completed trades, and missed opportunities already summarize them.
  let decisions = includeDecisions ? bundle.decisions : [];
  const exits = includeDecisions ? bundle.exits : [];
  if (opts.maxDecisions && decisions.length > opts.maxDecisions) {
    decisions = decisions.slice(decisions.length - opts.maxDecisions);
  }

  return {
    schemaVersion: 1,
    generatedAt: Date.now(),
    account: { cashUsd, openPositions: positions.length },
    dashboard: bundle.dashboard,
    traders: bundle.traders,
    categories: bundle.categories,
    portfolio: bundle.portfolio,
    correlation: bundle.correlation,
    completedTrades: bundle.completed,
    missedOpportunities: bundle.missed,
    decisions,
    exits,
  };
}
