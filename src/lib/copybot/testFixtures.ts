/**
 * Shared fixtures for unit tests. Not a test suite itself (no *.test.ts suffix).
 */
import { DEFAULT_BOT_SETTINGS, createInitialBotState } from "./defaults";
import type { BotPosition, BotSettings, BotState, CopyTradeRecord } from "./types";

export function makeSettings(overrides: Partial<BotSettings> = {}): BotSettings {
  return { ...DEFAULT_BOT_SETTINGS, ...overrides };
}

export function makeState(overrides: Partial<BotState> = {}): BotState {
  return { ...createInitialBotState(100, Date.UTC(2026, 5, 1)), ...overrides };
}

let seq = 0;
export function makeTrade(overrides: Partial<CopyTradeRecord> = {}): CopyTradeRecord {
  seq += 1;
  return {
    id: `t${seq}`,
    sourceTradeId: `src${seq}`,
    status: "copied",
    mode: "simulation",
    traderWallet: "0x" + "a".repeat(40),
    traderName: "wallet",
    side: "BUY",
    tokenId: `tok${seq}`,
    conditionId: `cond${seq}`,
    marketSlug: "slug",
    marketTitle: "market",
    outcome: "Yes",
    price: 0.5,
    sourceSize: 10,
    sourceAmountUsd: 5,
    copyAmountUsd: 5,
    copiedShares: 10,
    realizedPnlUsd: 0,
    reason: "test",
    txOrOrderId: "",
    sourceTimestamp: 0,
    processedAt: Date.UTC(2026, 5, 1),
    ...overrides,
  };
}

export function makePosition(overrides: Partial<BotPosition> = {}): BotPosition {
  return {
    tokenId: "tok",
    conditionId: "cond",
    marketSlug: "slug",
    marketTitle: "market",
    outcome: "Yes",
    shares: 10,
    avgPrice: 0.5,
    markPrice: 0.5,
    realizedPnlUsd: 0,
    openedAt: Date.UTC(2026, 5, 1),
    updatedAt: Date.UTC(2026, 5, 1),
    sourceWallets: ["0x" + "a".repeat(40)],
    ...overrides,
  };
}
