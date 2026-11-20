import { describe, expect, it } from "vitest";
import { matchLiveFills } from "./reconciliation";
import type { LiveTradeFill } from "@/lib/execution/liveClob";
import { makeTrade } from "./testFixtures";

function fill(overrides: Partial<LiveTradeFill> = {}): LiveTradeFill {
  return {
    id: Math.random().toString(36).slice(2),
    orderId: "order-1",
    tokenId: "tokA",
    conditionId: "condA",
    side: "BUY",
    shares: 10,
    price: 0.5,
    notionalUsd: 5,
    status: "CONFIRMED",
    matchTimeMs: Date.UTC(2026, 5, 1),
    txHashes: ["0xabc"],
    ...overrides,
  };
}

const realBuy = (overrides = {}) =>
  makeTrade({ mode: "real", side: "BUY", tokenId: "tokA", txOrOrderId: "order-1", copiedShares: 10, ...overrides });

describe("matchLiveFills", () => {
  it("matches by exact order id and records authoritative fill", () => {
    const rec = realBuy();
    const { records, matched } = matchLiveFills([rec], [fill({ shares: 10, notionalUsd: 5 })]);
    expect(matched).toBe(1);
    expect(records[0].reconciliationStatus).toBe("matched");
    expect(records[0].actualFilledShares).toBe(10);
    expect(records[0].actualAvgPrice).toBeCloseTo(0.5);
    expect(records[0].txHashes).toEqual(["0xabc"]);
  });

  it("sums a partial fill spread across multiple CLOB fills for one order", () => {
    const rec = realBuy({ copiedShares: 10 });
    const fills = [
      fill({ id: "f1", shares: 4, notionalUsd: 2 }),
      fill({ id: "f2", shares: 6, notionalUsd: 3.6 }),
    ];
    const { records } = matchLiveFills([rec], fills);
    expect(records[0].reconciliationStatus).toBe("matched");
    expect(records[0].actualFilledShares).toBe(10);
    expect(records[0].actualNotionalUsd).toBeCloseTo(5.6);
  });

  it("marks records with no corresponding fill as unmatched", () => {
    const rec = realBuy({ txOrOrderId: "order-missing" });
    const { records, unmatched } = matchLiveFills([rec], [fill({ orderId: "order-1" })]);
    expect(unmatched).toBe(1);
    expect(records[0].reconciliationStatus).toBe("unmatched");
    expect(records[0].actualFilledShares).toBeUndefined();
  });

  it("does NOT fuzzy-match by default even when token/side/time line up", () => {
    const rec = realBuy({ txOrOrderId: "" }); // no order id
    const f = fill({ orderId: null, tokenId: "tokA", side: "BUY" });
    const { records } = matchLiveFills([rec], [f]); // allowFuzzy defaults false
    expect(records[0].reconciliationStatus).toBe("unmatched");
  });

  it("with fuzzy enabled, a single candidate yields a cautious partial-match", () => {
    const rec = realBuy({ txOrOrderId: "" });
    const f = fill({ orderId: null, tokenId: "tokA", side: "BUY", shares: 10, notionalUsd: 5 });
    const { records, partial } = matchLiveFills([rec], [f], { allowFuzzy: true });
    expect(partial).toBe(1);
    expect(records[0].reconciliationStatus).toBe("partial-match");
  });

  it("with fuzzy enabled, ambiguous duplicates are flagged error, never guessed", () => {
    const rec = realBuy({ txOrOrderId: "" });
    const fills = [
      fill({ id: "f1", orderId: "orderX", tokenId: "tokA", side: "BUY" }),
      fill({ id: "f2", orderId: "orderY", tokenId: "tokA", side: "BUY" }),
    ];
    const { records } = matchLiveFills([rec], fills, { allowFuzzy: true });
    expect(records[0].reconciliationStatus).toBe("error");
    expect(records[0].actualFilledShares).toBeUndefined();
  });

  it("never attributes more shares than the local order intended", () => {
    const rec = realBuy({ copiedShares: 5 });
    const { records } = matchLiveFills([rec], [fill({ shares: 20, notionalUsd: 10 })]);
    expect(records[0].actualFilledShares).toBe(5);
    expect(records[0].actualNotionalUsd).toBeCloseTo(2.5);
  });

  it("never counts one CLOB fill toward two records", () => {
    const a = realBuy({ id: "a", txOrOrderId: "order-1" });
    const b = realBuy({ id: "b", txOrOrderId: "order-1" });
    const { records } = matchLiveFills([a, b], [fill({ id: "only", shares: 10, notionalUsd: 5 })]);
    const statuses = records.map((r) => r.reconciliationStatus).sort();
    expect(statuses).toEqual(["matched", "unmatched"]);
  });

  it("leaves already-authoritative records untouched", () => {
    const rec = realBuy({ reconciliationStatus: "matched", actualFilledShares: 10 });
    const { records, matched } = matchLiveFills([rec], [fill()]);
    expect(matched).toBe(0);
    expect(records[0]).toBe(rec);
  });
});

import { classifyUnconfirmedOrder, UNKNOWN_ORDER_VOID_MS, voidLiveRecord } from "./reconciliation";

describe("classifyUnconfirmedOrder (self-healing)", () => {
  const now = 1_800_000_000_000;
  const rec = (over: Record<string, unknown> = {}) =>
    ({
      id: "r1", sourceTradeId: "s", status: "copied", mode: "real", traderWallet: "0x", traderName: "t",
      side: "BUY", tokenId: "tok", conditionId: "c", marketSlug: "m", marketTitle: "M", outcome: "Yes",
      price: 0.5, sourceSize: 10, sourceAmountUsd: 5, copyAmountUsd: 3, copiedShares: 6, realizedPnlUsd: 0,
      reason: "LIVE BUY", txOrOrderId: "order-1", sourceTimestamp: now - 1000, processedAt: now - 1000,
      reconciliationStatus: "unmatched", ...over,
    }) as never;

  it("voids a record with no order id immediately", () => {
    expect(classifyUnconfirmedOrder(rec({ txOrOrderId: "" }), null, now).action).toBe("void");
  });
  it("voids a cancelled/unmatched order with nothing filled", () => {
    const v = classifyUnconfirmedOrder(rec(), { orderId: "order-1", status: "CANCELED", sizeMatched: 0, originalSize: 6, price: 0.5, side: "BUY", tokenId: "tok" }, now);
    expect(v.action).toBe("void");
  });
  it("records a matched size reported by the exchange", () => {
    const v = classifyUnconfirmedOrder(rec(), { orderId: "order-1", status: "MATCHED", sizeMatched: 5.5, originalSize: 6, price: 0.51, side: "BUY", tokenId: "tok" }, now);
    expect(v).toEqual({ action: "fill", shares: 5.5, price: 0.51 });
  });
  it("waits on an unknown order until the void window passes", () => {
    expect(classifyUnconfirmedOrder(rec(), null, now).action).toBe("wait");
    expect(classifyUnconfirmedOrder(rec({ processedAt: now - UNKNOWN_ORDER_VOID_MS - 1 }), null, now).action).toBe("void");
  });
  it("voided records stop counting as open live orders", () => {
    const voided = voidLiveRecord(rec(), "test", now) as { status: string; actualFilledShares: number };
    expect(voided.status).toBe("failed");
    expect(voided.actualFilledShares).toBe(0);
  });
});
