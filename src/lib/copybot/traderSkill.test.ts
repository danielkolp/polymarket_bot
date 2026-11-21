import { describe, expect, it } from "vitest";
import type { TraderTrade } from "@/lib/polymarket/types";
import { measureSkill, priceAt, selectSkillBuys, skillScore, SKILL_LAG_SEC, type SkillCache } from "./traderSkill";

const NOW = 1_800_000_000;
const W = "0x" + "a".repeat(40);

function buy(over: Partial<TraderTrade> = {}): TraderTrade {
  return {
    wallet: W,
    traderName: "t",
    side: "BUY",
    tokenId: "tok",
    conditionId: "c",
    size: 20,
    price: 0.4,
    timestamp: NOW - 86_400,
    title: "m",
    outcome: "Yes",
    ...over,
  } as TraderTrade;
}

describe("priceAt", () => {
  it("returns the last price at or before t", () => {
    const h = [{ t: 10, p: 0.1 }, { t: 20, p: 0.2 }, { t: 30, p: 0.3 }];
    expect(priceAt(h, 25)).toBe(0.2);
    expect(priceAt(h, 30)).toBe(0.3);
    expect(priceAt(h, 5)).toBeNull();
  });
});

describe("selectSkillBuys", () => {
  const band = { min: 0.2, max: 0.85 };
  it("keeps in-band buys old enough for a 6-hour move, newest first", () => {
    const trades = [
      buy({ tokenId: "a", timestamp: NOW - 2 * 86_400 }),
      buy({ tokenId: "b", timestamp: NOW - 3600 }), // too recent
      buy({ tokenId: "c", price: 0.95 }), // out of band
      buy({ tokenId: "d", side: "SELL" }),
      buy({ tokenId: "e", size: 1 }), // $0.40: dust
      buy({ tokenId: "f", timestamp: NOW - 40 * 86_400 }), // too old
      buy({ tokenId: "g", timestamp: NOW - 86_400 }),
    ];
    expect(selectSkillBuys(trades, band, NOW).map((t) => t.tokenId)).toEqual(["g", "a"]);
  });

  it("counts one buy per token per 10 minutes (split fills)", () => {
    const trades = [buy({ timestamp: NOW - 86_400 }), buy({ timestamp: NOW - 86_400 + 30 })];
    expect(selectSkillBuys(trades, band, NOW)).toHaveLength(1);
  });
});

describe("skillScore", () => {
  it("shrinks small samples toward zero", () => {
    expect(skillScore([0.05, 0.05]).score).toBeLessThan(skillScore(Array(20).fill(0.05)).score);
    expect(skillScore([]).score).toBe(0);
  });
});

describe("measureSkill", () => {
  it("measures the move 6 hours after each buy against a copy entry, and caches it", async () => {
    const t0 = NOW - 86_400;
    const calls: string[] = [];
    const fetcher = async (tokenId: string) => {
      calls.push(tokenId);
      return [{ t: t0, p: 0.4 }, { t: t0 + SKILL_LAG_SEC - 60, p: 0.5 }];
    };
    const cache: SkillCache = {};
    const s = await measureSkill(W, [buy({ timestamp: t0 })], { min: 0.2, max: 0.85 }, cache, fetcher, NOW);
    expect(s.n).toBe(1);
    expect(s.mean).toBeCloseTo(0.5 - 0.405, 6);
    // Second pass uses the cache.
    await measureSkill(W, [buy({ timestamp: t0 })], { min: 0.2, max: 0.85 }, cache, fetcher, NOW);
    expect(calls).toHaveLength(1);
  });

  it("does not cache failed fetches", async () => {
    const cache: SkillCache = {};
    const s = await measureSkill(W, [buy()], { min: 0.2, max: 0.85 }, cache, async () => null, NOW);
    expect(s.n).toBe(0);
    expect(Object.keys(cache[W.toLowerCase()].samples)).toHaveLength(0);
  });
});
