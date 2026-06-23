/**
 * Copy-wallet scoring based on the BOT'S OWN copied results, not public
 * leaderboard PnL. Discovery finds candidates; this is what decides survivors.
 *
 * Every metric is derived from the local copy-trade ledger and current positions,
 * so it reflects realistic, post-fill outcomes (slippage, skipped trades, exits).
 * Wallets that score badly past a meaningful sample are auto-disabled unless pinned.
 */
import { positionUnrealizedPnl } from "./accounting";
import { isFilled as ledgerIsFilled, tradeAvgPrice, tradeFilledShares, tradeNotionalUsd } from "./ledger";
import type { BotPosition, CopyScore, CopyTradeRecord, FollowedTrader } from "./types";

/** Minimum filled copies before ROI-based auto-disable can fire. */
const MIN_AUTO_DISABLE_FILLED_COPIES = 40;
/** ROI must be materially negative before a wallet is auto-disabled. */
const NEGATIVE_ROI_AUTO_DISABLE_THRESHOLD = -0.05;
/** Minimum attempts (filled + skipped) before the skip-ratio review rule can fire. */
const MIN_ATTEMPTS = 8;
const HIGH_SKIP_RATIO = 0.85;
const HIGH_PRICE_THRESHOLD = 0.85;

function isFilled(record: CopyTradeRecord): boolean {
  return ledgerIsFilled(record);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Compute a single wallet's copy score from its copied records + open positions. */
export function computeCopyScore(
  wallet: string,
  trades: CopyTradeRecord[],
  positions: BotPosition[],
): CopyScore {
  const lower = wallet.toLowerCase();
  const mine = trades.filter((t) => t.traderWallet.toLowerCase() === lower);
  const filled = mine.filter(isFilled);
  const buys = filled.filter((t) => t.side === "BUY");
  const sells = filled.filter((t) => t.side === "SELL");
  const skippedCount = mine.filter((t) => t.status === "skipped").length;

  const attempts = filled.length + skippedCount;
  const skipRatio = attempts > 0 ? skippedCount / attempts : 0;

  const realizedPnlUsd = filled.reduce((sum, t) => sum + t.realizedPnlUsd, 0);
  const investedUsd = buys.reduce((sum, t) => sum + tradeNotionalUsd(t), 0);

  const openPositions = positions.filter((p) => p.sourceWallets.some((w) => w.toLowerCase() === lower));
  const unrealizedPnlUsd = openPositions.reduce((sum, p) => sum + positionUnrealizedPnl(p), 0);

  const copyRoi = investedUsd > 0 ? (realizedPnlUsd + unrealizedPnlUsd) / investedUsd : 0;

  // Share-weighted entry slippage vs mid, in bps (authoritative price when reconciled).
  let slipShares = 0;
  let slipBpsWeighted = 0;
  for (const t of buys) {
    const eff = tradeAvgPrice(t);
    const ref = t.referencePrice;
    const shares = tradeFilledShares(t);
    if (ref != null && ref > 0 && shares > 0 && Number.isFinite(eff)) {
      slipShares += shares;
      slipBpsWeighted += ((eff - ref) / ref) * 10000 * shares;
    }
  }
  const avgSlippageBps = slipShares > 0 ? slipBpsWeighted / slipShares : 0;

  const highPriceEntryCount = buys.filter((t) => tradeAvgPrice(t) > HIGH_PRICE_THRESHOLD).length;
  const lowLiquidityEntryCount = buys.filter((t) => t.fillStatus === "partial").length;

  // Composite 0..100. Centered at 50, rewarded by realistic ROI, penalized by
  // skip ratio, slippage, and chasing high-price asymmetric entries.
  let score = 50;
  score += clamp(copyRoi * 100, -40, 40);
  score -= skipRatio * 25;
  score -= clamp(avgSlippageBps / 50, 0, 15); // 1pt per 50bps slippage, capped
  score -= buys.length > 0 ? (highPriceEntryCount / buys.length) * 10 : 0;
  score = clamp(score, 0, 100);

  // Auto-disable only after a material losing sample. Early or slight negative
  // ROI, including tiny unrealized drawdowns, stays enabled but under review.
  let autoDisableReason: string | null = null;
  let reviewReason: string | null = null;
  if (filled.length >= MIN_AUTO_DISABLE_FILLED_COPIES && copyRoi <= NEGATIVE_ROI_AUTO_DISABLE_THRESHOLD) {
    autoDisableReason = `Negative copy ROI (${(copyRoi * 100).toFixed(1)}%) after ${filled.length} copied trades.`;
  } else if (filled.length > 0 && copyRoi < 0) {
    const roiText = `${(copyRoi * 100).toFixed(1)}%`;
    if (copyRoi <= NEGATIVE_ROI_AUTO_DISABLE_THRESHOLD) {
      reviewReason = `Under review: negative copy ROI (${roiText}) after ${filled.length}/${MIN_AUTO_DISABLE_FILLED_COPIES} copied trades.`;
    } else {
      reviewReason = `Under review: copy ROI (${roiText}) is negative but above the ${(Math.abs(NEGATIVE_ROI_AUTO_DISABLE_THRESHOLD) * 100).toFixed(0)}% auto-disable threshold.`;
    }
  } else if (attempts >= MIN_ATTEMPTS && skipRatio > HIGH_SKIP_RATIO) {
    reviewReason = `Under review: ${(skipRatio * 100).toFixed(0)}% of this wallet's trades fail risk gates (${skippedCount}/${attempts}).`;
  }

  return {
    wallet: lower,
    copiedBuys: buys.length,
    copiedSells: sells.length,
    filledCopies: filled.length,
    skippedCount,
    skipRatio,
    realizedPnlUsd,
    unrealizedPnlUsd,
    investedUsd,
    copyRoi,
    avgSlippageBps,
    highPriceEntryCount,
    lowLiquidityEntryCount,
    openPositionCount: openPositions.length,
    score,
    autoDisableReason,
    reviewReason,
  };
}

export interface CopyScoreResult {
  traders: FollowedTrader[];
  /** Wallets newly auto-disabled by this pass (for logging). */
  newlyDisabled: { wallet: string; name: string; reason: string }[];
}

/**
 * Recompute copy scores for every followed trader and apply auto-disable rules.
 * Pinned wallets are scored but never auto-disabled. Returns updated traders and
 * the set newly disabled this pass so the caller can log/alert.
 */
export function applyCopyScores(
  traders: FollowedTrader[],
  trades: CopyTradeRecord[],
  positions: BotPosition[],
): CopyScoreResult {
  const newlyDisabled: CopyScoreResult["newlyDisabled"] = [];

  const updated = traders.map((trader) => {
    const copyScore = computeCopyScore(trader.wallet, trades, positions);
    const wasAutoDisabled = Boolean(trader.autoDisabled);

    if (trader.pinned) {
      // Pinned: keep scoring visible, but never auto-disable.
      const pinnedReviewReason = copyScore.reviewReason ?? copyScore.autoDisableReason;
      return {
        ...trader,
        copyScore,
        autoDisabled: false,
        autoDisableReason: null,
        underReview: pinnedReviewReason != null,
        reviewReason: pinnedReviewReason,
      };
    }

    const shouldDisable = copyScore.autoDisableReason != null;
    const shouldReview = !shouldDisable && copyScore.reviewReason != null;
    if (shouldDisable && !wasAutoDisabled) {
      newlyDisabled.push({ wallet: trader.wallet, name: trader.name, reason: copyScore.autoDisableReason! });
    }

    return {
      ...trader,
      copyScore,
      autoDisabled: shouldDisable,
      autoDisableReason: copyScore.autoDisableReason,
      underReview: shouldReview,
      reviewReason: shouldReview ? copyScore.reviewReason : null,
    };
  });

  return { traders: updated, newlyDisabled };
}
