import type { BotPosition, LivePositionReconciliation } from "./types";

export const LIVE_SELL_SHARE_DECIMALS = 6;
export const LIVE_SELL_DUST = 1e-6;

export interface LiveSellSizeDecision {
  ok: boolean;
  shares: number;
  requestedShares: number;
  liveShares: number | null;
  bookSharesBeforeSell: number;
  clamped: boolean;
  reason: string | null;
  note: string | null;
}

export function floorLiveSellShares(shares: number): number {
  if (!Number.isFinite(shares) || shares <= 0) return 0;
  const scale = 10 ** LIVE_SELL_SHARE_DECIMALS;
  return Math.floor(shares * scale) / scale;
}

export function formatLiveSellShares(shares: number): string {
  return floorLiveSellShares(shares).toFixed(LIVE_SELL_SHARE_DECIMALS).replace(/\.?0+$/, "");
}

export function resolveLiveSellSize(input: {
  position: BotPosition;
  requestedShares: number;
  snapshot: LivePositionReconciliation | null;
  now: number;
  maxSnapshotAgeMs: number;
}): LiveSellSizeDecision {
  const requestedShares = floorLiveSellShares(Math.min(input.position.shares, input.requestedShares));
  const empty = (reason: string, liveShares: number | null = null): LiveSellSizeDecision => ({
    ok: false,
    shares: 0,
    requestedShares,
    liveShares,
    bookSharesBeforeSell: 0,
    clamped: false,
    reason,
    note: null,
  });

  if (requestedShares <= LIVE_SELL_DUST) {
    return empty("calculated sell size was zero");
  }
  if (!input.snapshot || !input.snapshot.ok) {
    return empty("live position snapshot is unavailable");
  }
  if (input.now - input.snapshot.fetchedAt > input.maxSnapshotAgeMs) {
    return empty("live position snapshot is stale");
  }

  const entry = input.snapshot.entries.find((e) => e.tokenId === input.position.tokenId);
  if (!entry) {
    return empty("live account does not report this token as sellable");
  }
  if (entry.redeemable) {
    return empty("position is resolved/redeemable and is not CLOB-sellable", entry.liveShares);
  }

  const liveShares = floorLiveSellShares(entry.liveShares);
  if (liveShares <= LIVE_SELL_DUST) {
    return empty("live account reports zero sellable shares", liveShares);
  }

  const bookSharesBeforeSell = floorLiveSellShares(Math.min(input.position.shares, liveShares));
  const shares = floorLiveSellShares(Math.min(requestedShares, liveShares));
  if (shares <= LIVE_SELL_DUST) {
    return empty("live sell size was below the minimum share precision", liveShares);
  }

  const clamped = shares < requestedShares - LIVE_SELL_DUST;
  return {
    ok: true,
    shares,
    requestedShares,
    liveShares,
    bookSharesBeforeSell,
    clamped,
    reason: null,
    note: clamped
      ? `live account reports ${formatLiveSellShares(liveShares)} sellable shares, clamped from ${formatLiveSellShares(requestedShares)}`
      : null,
  };
}
