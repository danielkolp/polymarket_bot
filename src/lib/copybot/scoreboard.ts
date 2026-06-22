import { walletExposure } from "./accounting";
import { RISK_PRESETS } from "./riskPresets";
import type {
  BotMetrics,
  BotPosition,
  BotSettings,
  BotState,
  CopyTradeRecord,
  SessionScoreboard,
  SkipReasonCount,
  WalletCopyStat,
  WalletPnl,
} from "./types";

function isFilled(trade: CopyTradeRecord): boolean {
  return trade.status === "simulated" || trade.status === "copied";
}

/**
 * Collapse the variable parts of a skip message (prices, minutes, dollar
 * amounts) into a placeholder so that otherwise-identical skips bucket together.
 * e.g. "market resolves within 60 minute(s)." -> "market resolves within # minute(s)."
 */
export function normalizeSkipReason(reason: string): string {
  return reason.replace(/-?\d[\d,]*\.?\d*/g, "#").trim();
}

export function buildScoreboard(
  settings: BotSettings,
  state: BotState,
  metrics: BotMetrics,
  positions: BotPosition[],
  trades: CopyTradeRecord[],
  now = Date.now(),
): SessionScoreboard {
  const filled = trades.filter(isFilled);
  const buys = filled.filter((trade) => trade.side === "BUY");
  const sells = filled.filter((trade) => trade.side === "SELL");

  let entryShares = 0;
  let entryCost = 0;
  for (const trade of buys) {
    const price = trade.effectivePrice ?? trade.price;
    if (trade.copiedShares > 0 && Number.isFinite(price)) {
      entryShares += trade.copiedShares;
      entryCost += price * trade.copiedShares;
    }
  }

  let exitShares = 0;
  let exitCost = 0;
  for (const trade of sells) {
    const price = trade.effectivePrice ?? trade.price;
    if (trade.copiedShares > 0 && Number.isFinite(price)) {
      exitShares += trade.copiedShares;
      exitCost += price * trade.copiedShares;
    }
  }

  // Per-wallet copy activity and realized P&L (skip the synthetic session-close /
  // auto-exit pseudo-wallets that have no real address).
  const walletMap = new Map<string, { name: string; pnl: number; buys: number; sells: number }>();
  for (const trade of filled) {
    if (!trade.traderWallet || !/^0x[a-f0-9]{40}$/i.test(trade.traderWallet)) continue;
    const current = walletMap.get(trade.traderWallet) ?? { name: trade.traderName || trade.traderWallet, pnl: 0, buys: 0, sells: 0 };
    current.pnl += trade.realizedPnlUsd;
    if (trade.side === "BUY") current.buys += 1;
    else current.sells += 1;
    if (trade.traderName) current.name = trade.traderName;
    walletMap.set(trade.traderWallet, current);
  }

  const equityUsd = metrics.equityUsd;
  let bestWallet: WalletPnl | null = null;
  let worstWallet: WalletPnl | null = null;
  const copiedTradesByWallet: WalletCopyStat[] = [];
  for (const [wallet, value] of walletMap) {
    const entry: WalletPnl = { wallet, name: value.name, realizedPnlUsd: value.pnl };
    if (!bestWallet || entry.realizedPnlUsd > bestWallet.realizedPnlUsd) bestWallet = entry;
    if (!worstWallet || entry.realizedPnlUsd < worstWallet.realizedPnlUsd) worstWallet = entry;

    const exposureUsd = walletExposure(positions, wallet);
    copiedTradesByWallet.push({
      wallet,
      name: value.name,
      copiedTrades: value.buys + value.sells,
      buys: value.buys,
      sells: value.sells,
      exposureUsd,
      exposurePercent: equityUsd > 0 ? exposureUsd / equityUsd : 0,
      realizedPnlUsd: value.pnl,
    });
  }
  copiedTradesByWallet.sort((a, b) => b.exposureUsd - a.exposureUsd || b.copiedTrades - a.copiedTrades);

  const skipMap = new Map<string, SkipReasonCount>();
  for (const trade of trades) {
    if (trade.status !== "skipped") continue;
    const key = normalizeSkipReason(trade.reason);
    const current = skipMap.get(key) ?? { reason: trade.reason, count: 0 };
    current.count += 1;
    skipMap.set(key, current);
  }
  const skipsByReason = [...skipMap.values()].sort((a, b) => b.count - a.count);

  const running = state.runState === "running" || state.runState === "draining";
  const endTs = running ? now : state.stoppedAt ?? now;
  const runtimeMs = state.startedAt ? Math.max(0, endTs - state.startedAt) : 0;

  return {
    activePreset: settings.riskPreset,
    presetLabel: RISK_PRESETS[settings.riskPreset]?.label ?? settings.riskPreset,
    startedAt: state.startedAt,
    runtimeMs,
    walletsChecked: state.sessionWalletsChecked,
    tradesScanned: state.sessionTradesScanned,
    copiedBuys: buys.length,
    copiedSells: sells.length,
    openPositions: positions.length,
    totalExposurePercent: metrics.totalExposurePercent,
    realizedPnlUsd: metrics.realizedPnlUsd,
    unrealizedPnlUsd: metrics.unrealizedPnlUsd,
    currentEquityUsd: metrics.equityUsd,
    roi: metrics.roi,
    maxDrawdown: metrics.maxDrawdown,
    averageEntryPrice: entryShares > 0 ? entryCost / entryShares : 0,
    averageExitPrice: exitShares > 0 ? exitCost / exitShares : 0,
    bestWallet,
    worstWallet,
    copiedTradesByWallet,
    skipsByReason,
  };
}
