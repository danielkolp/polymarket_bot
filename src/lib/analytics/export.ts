/**
 * Export bundle: collapses the account state, every analytics stream, and the
 * aggregations into a single JSON document suitable for download and upload into
 * an LLM for strategy analysis.
 */
import type { BotPosition, BotSettings, CopyTradeRecord, EquityPoint } from "@/lib/copybot/types";
import {
  calculateAvailableBalance,
  positionCostBasis,
  positionExposure,
  realizedPnlFromTrades,
  totalExposure,
  totalOpenCostBasis,
} from "@/lib/copybot/accounting";
import { loadAnalyticsBundle } from "./aggregate";
import type { DecisionRecord, MarketCategory } from "./types";

type Bundle = Awaited<ReturnType<typeof loadAnalyticsBundle>>;

export interface AccountSnapshot {
  cashUsd: number;
  totalEquityUsd: number;
  openExposureUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  openPositions: number;
  /** Cash basis note: local accounting (no live-balance fetch in the export). */
  cashBasis: "local-accounting";
}

export interface OpenPositionDetail {
  tokenId: string;
  conditionId: string;
  marketTitle: string;
  category: MarketCategory;
  outcome: string;
  traders: string[];
  shares: number;
  entryPrice: number;
  currentPrice: number;
  costBasisUsd: number;
  exposureUsd: number;
  unrealizedPnlUsd: number;
  roi: number;
  openedAt: number;
  ageMs: number;
  resolvesAt: string | null;
  timeToResolutionMs: number | null;
  leaderHolds: string | null;
}

/** The day's risk/sizing configuration that produced these decisions. */
export interface ConfigSnapshot {
  mode: string;
  riskPreset: string;
  maxTotalExposurePercent: number;
  maxExposurePerMarketPercent: number;
  maxExposurePerWalletPercent: number;
  maxDailyLossPercent: number;
  maxTradeAgeSec: number;
  liveMaxCopyTradeAgeSec: number;
  minBuyTokenPrice: number;
  maxBuyTokenPrice: number;
  maxMarketSpread: number;
  minMarketLiquidityUsd: number;
  minTimeToResolutionMinutes: number;
  maxAdverseEntryMoveCents: number;
  sizingMode: string;
  sizingSignalMode: string;
  fixedCopyAmountUsd: number;
  percentageCopySize: number;
  minTradeAmountUsd: number;
  maxTradeAmountUsd: number;
  sellBehavior: string;
  exitWhenLeaderNoLongerHolds: boolean;
  autoExitTakeProfitPercent: number;
  autoExitStopLossPercent: number;
  autoExitMaxHoldMinutes: number;
  walletTradeCooldownSec: number;
  maxCopiesPerWalletPerCycle: number;
}

export interface AnalyticsExport {
  schemaVersion: number;
  generatedAt: number;
  account: AccountSnapshot;
  config: ConfigSnapshot;
  /** Timestamped cash/equity/exposure points (one per poll, ~1–5 min apart). */
  equityCurve: EquityPoint[];
  openPositions: OpenPositionDetail[];
  dashboard: Bundle["dashboard"];
  traders: Bundle["traders"];
  categories: Bundle["categories"];
  portfolio: Bundle["portfolio"];
  correlation: Bundle["correlation"];
  executionQuality: Bundle["executionQuality"];
  completedTrades: Bundle["completed"];
  missedOpportunities: Bundle["missed"];
  /** Full decision log (BUY/SELL/SKIP/FAIL), optionally capped. */
  decisions: Bundle["decisions"];
  /** Bot-autonomous exit log. */
  exits: Bundle["exits"];
}

export interface ExportInputs {
  settings: BotSettings;
  positions: BotPosition[];
  trades: CopyTradeRecord[];
  equityCurve: EquityPoint[];
}

export interface ExportOptions {
  /** Cap on raw decisions included (most recent kept). 0 = all. */
  maxDecisions?: number;
  /** Include the full decision + exit logs (default true). */
  includeDecisions?: boolean;
  /** Cap on equity-curve points (most recent kept). 0 = all. */
  maxEquityPoints?: number;
}

function configSnapshot(s: BotSettings): ConfigSnapshot {
  return {
    mode: s.mode,
    riskPreset: s.riskPreset,
    maxTotalExposurePercent: s.maxTotalExposurePercent,
    maxExposurePerMarketPercent: s.maxExposurePerMarketPercent,
    maxExposurePerWalletPercent: s.maxExposurePerWalletPercent,
    maxDailyLossPercent: s.maxDailyLossPercent,
    maxTradeAgeSec: s.maxTradeAgeSec,
    liveMaxCopyTradeAgeSec: s.liveMaxCopyTradeAgeSec,
    minBuyTokenPrice: s.minBuyTokenPrice,
    maxBuyTokenPrice: s.maxBuyTokenPrice,
    maxMarketSpread: s.maxMarketSpread,
    minMarketLiquidityUsd: s.minMarketLiquidityUsd,
    minTimeToResolutionMinutes: s.minTimeToResolutionMinutes,
    maxAdverseEntryMoveCents: s.maxAdverseEntryMoveCents,
    sizingMode: s.sizingMode,
    sizingSignalMode: s.sizingSignalMode,
    fixedCopyAmountUsd: s.fixedCopyAmountUsd,
    percentageCopySize: s.percentageCopySize,
    minTradeAmountUsd: s.minTradeAmountUsd,
    maxTradeAmountUsd: s.maxTradeAmountUsd,
    sellBehavior: s.sellBehavior,
    exitWhenLeaderNoLongerHolds: s.exitWhenLeaderNoLongerHolds,
    autoExitTakeProfitPercent: s.autoExitTakeProfitPercent,
    autoExitStopLossPercent: s.autoExitStopLossPercent,
    autoExitMaxHoldMinutes: s.autoExitMaxHoldMinutes,
    walletTradeCooldownSec: s.walletTradeCooldownSec,
    maxCopiesPerWalletPerCycle: s.maxCopiesPerWalletPerCycle,
  };
}

function openPositionDetails(positions: BotPosition[], decisions: DecisionRecord[], now: number): OpenPositionDetail[] {
  const latest = new Map<string, DecisionRecord>();
  for (const d of decisions) {
    const prev = latest.get(d.tokenId);
    if (!prev || d.ts > prev.ts) latest.set(d.tokenId, d);
  }
  return positions.map((p) => {
    const exposureUsd = positionExposure(p);
    const costBasisUsd = positionCostBasis(p);
    const unrealizedPnlUsd = exposureUsd - costBasisUsd;
    const d = latest.get(p.tokenId);
    const resolvesAt = d?.market.resolvesAt ?? null;
    const timeToResolutionMs = resolvesAt ? new Date(resolvesAt).getTime() - now : d?.market.timeToResolutionMs ?? null;
    return {
      tokenId: p.tokenId,
      conditionId: p.conditionId,
      marketTitle: p.marketTitle,
      category: d?.market.category ?? "other",
      outcome: p.outcome,
      traders: p.sourceWallets,
      shares: p.shares,
      entryPrice: p.avgPrice,
      currentPrice: p.markPrice,
      costBasisUsd,
      exposureUsd,
      unrealizedPnlUsd,
      roi: costBasisUsd > 0 ? unrealizedPnlUsd / costBasisUsd : 0,
      openedAt: p.openedAt,
      ageMs: now - p.openedAt,
      resolvesAt,
      timeToResolutionMs: timeToResolutionMs != null && Number.isFinite(timeToResolutionMs) ? timeToResolutionMs : null,
      leaderHolds: p.leaderHolds ?? null,
    };
  });
}

export async function buildAnalyticsExport(inputs: ExportInputs, opts: ExportOptions = {}): Promise<AnalyticsExport> {
  const { settings, positions, trades, equityCurve } = inputs;
  const now = Date.now();
  const cashUsd = calculateAvailableBalance(settings, positions, trades);
  const bundle = await loadAnalyticsBundle(positions, cashUsd);

  const includeDecisions = opts.includeDecisions !== false;
  let decisions = includeDecisions ? bundle.decisions : [];
  const exits = includeDecisions ? bundle.exits : [];
  if (opts.maxDecisions && decisions.length > opts.maxDecisions) {
    decisions = decisions.slice(decisions.length - opts.maxDecisions);
  }

  let equity = equityCurve;
  if (opts.maxEquityPoints && equity.length > opts.maxEquityPoints) {
    equity = equity.slice(equity.length - opts.maxEquityPoints);
  }

  const openExposureUsd = totalExposure(positions);
  const unrealizedPnlUsd = openExposureUsd - totalOpenCostBasis(positions);
  const realizedPnlUsd = realizedPnlFromTrades(trades);

  return {
    schemaVersion: 2,
    generatedAt: now,
    account: {
      cashUsd,
      totalEquityUsd: cashUsd + openExposureUsd,
      openExposureUsd,
      realizedPnlUsd,
      unrealizedPnlUsd,
      openPositions: positions.length,
      cashBasis: "local-accounting",
    },
    config: configSnapshot(settings),
    equityCurve: equity,
    openPositions: openPositionDetails(positions, bundle.decisions, now),
    dashboard: bundle.dashboard,
    traders: bundle.traders,
    categories: bundle.categories,
    portfolio: bundle.portfolio,
    correlation: bundle.correlation,
    executionQuality: bundle.executionQuality,
    completedTrades: bundle.completed,
    missedOpportunities: bundle.missed,
    decisions,
    exits,
  };
}
