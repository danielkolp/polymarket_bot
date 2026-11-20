import { describe, expect, it } from "vitest";
import { copiedCountForWallet, exclusionReason, profileTrades } from "./discovery";
import { applyRiskPreset } from "./riskPresets";
import { DEFAULT_BOT_SETTINGS } from "./defaults";
import type { TraderTrade } from "@/lib/polymarket/types";

const settings = applyRiskPreset({ ...DEFAULT_BOT_SETTINGS, mode: "simulation", riskPreset: "safe" });
const NOW = 1_800_000_000_000;
const nowSec = NOW / 1000;

function trade(over: Partial<TraderTrade> = {}): TraderTrade {
  return {
    wallet: "0xabc", traderName: "t", side: "BUY", tokenId: "tok", conditionId: "c",
    size: 200, price: 0.5, timestamp: nowSec - 3600, title: "m", outcome: "Yes", txHash: "0x1", ...over,
  };
}

const goodBoard = { monthPnl: 50_000, monthVolume: 400_000, weekPnl: 8_000 };

describe("profileTrades", () => {
  it("measures pace, size and copyability", () => {
    const trades = Array.from({ length: 20 }, (_, i) => trade({ timestamp: nowSec - i * 3 * 3600 }));
    const p = profileTrades(trades, settings, NOW);
    expect(p.avgTradeUsd).toBeCloseTo(100);
    expect(p.tradesPerDay).toBeGreaterThan(7);
    expect(p.tradesPerDay).toBeLessThan(9);
    expect(p.copyableShare).toBe(1);
  });
});

describe("exclusionReason", () => {
  const human = profileTrades(Array.from({ length: 30 }, (_, i) => trade({ timestamp: nowSec - i * 3600 })), settings, NOW);

  it("accepts a profitable, human-paced, directional trader", () => {
    expect(exclusionReason({ ...goodBoard, ...human }, settings, NOW)).toBeNull();
  });
  it("rejects market makers (tiny return on huge volume)", () => {
    expect(exclusionReason({ ...goodBoard, monthVolume: 50_000_000, ...human }, settings, NOW)).toMatch(/market maker/);
  });
  it("rejects bots trading hundreds of times a day", () => {
    const bot = profileTrades(Array.from({ length: 100 }, (_, i) => trade({ timestamp: nowSec - i * 60 })), settings, NOW);
    expect(exclusionReason({ ...goodBoard, ...bot }, settings, NOW)).toMatch(/bot/);
  });
  it("rejects whales", () => {
    const whale = profileTrades(Array.from({ length: 30 }, (_, i) => trade({ size: 40_000, timestamp: nowSec - i * 3600 })), settings, NOW);
    expect(exclusionReason({ ...goodBoard, ...whale }, settings, NOW)).toMatch(/whale/);
  });
  it("rejects wallets losing this week", () => {
    expect(exclusionReason({ ...goodBoard, weekPnl: -1, ...human }, settings, NOW)).toMatch(/losing/);
  });
  it("rejects long-shot traders the price band would filter anyway", () => {
    const longShots = profileTrades(Array.from({ length: 30 }, (_, i) => trade({ price: 0.04, size: 3000, timestamp: nowSec - i * 3600 })), settings, NOW);
    expect(exclusionReason({ ...goodBoard, ...longShots }, settings, NOW)).toMatch(/outside/);
  });
});

describe("copiedCountForWallet", () => {
  it("counts live copies as well as simulated ones", () => {
    const rows = [
      { traderWallet: "0xw", status: "copied" },
      { traderWallet: "0xw", status: "simulated" },
      { traderWallet: "0xw", status: "skipped" },
    ] as never;
    expect(copiedCountForWallet("0xw", rows)).toBe(2);
  });
});
