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
