import { describe, expect, it } from "vitest";
import {
  realizedPnlSource,
  tradeAvgPrice,
  tradeFilledShares,
  tradeIsAuthoritative,
  tradeIsUnsafeForAccounting,
  tradeNotionalUsd,
} from "./ledger";
import { makeTrade } from "./testFixtures";

describe("ledger authoritative helpers", () => {
  it("simulated records are authoritative for the sim ledger and use mirror fields", () => {
    const t = makeTrade({ mode: "simulation", copyAmountUsd: 5, copiedShares: 10, effectivePrice: 0.5 });
    expect(tradeIsAuthoritative(t)).toBe(false); // only real+reconciled is "authoritative-clob"
    expect(tradeIsUnsafeForAccounting(t)).toBe(false);
    expect(tradeNotionalUsd(t)).toBe(5);
    expect(tradeFilledShares(t)).toBe(10);
    expect(tradeAvgPrice(t)).toBe(0.5);
    expect(realizedPnlSource(t)).toBe("simulated");
  });

  it("real pending records are unsafe and fall back to mirror estimates", () => {
    const t = makeTrade({ mode: "real", reconciliationStatus: "pending", copyAmountUsd: 3, copiedShares: 6 });
    expect(tradeIsAuthoritative(t)).toBe(false);
    expect(tradeIsUnsafeForAccounting(t)).toBe(true);
    expect(tradeNotionalUsd(t)).toBe(3);
    expect(realizedPnlSource(t)).toBe("local-mirror");
  });

  it("real unmatched and error records are unsafe for accounting", () => {
    expect(tradeIsUnsafeForAccounting(makeTrade({ mode: "real", reconciliationStatus: "unmatched" }))).toBe(true);
    expect(tradeIsUnsafeForAccounting(makeTrade({ mode: "real", reconciliationStatus: "error" }))).toBe(true);
  });

  it("real matched records drive the ledger off authoritative fills", () => {
    const t = makeTrade({
      mode: "real",
      reconciliationStatus: "matched",
      copyAmountUsd: 5,
      copiedShares: 10,
      effectivePrice: 0.5,
      actualNotionalUsd: 4.2,
      actualFilledShares: 7,
      actualAvgPrice: 0.6,
    });
    expect(tradeIsAuthoritative(t)).toBe(true);
    expect(tradeIsUnsafeForAccounting(t)).toBe(false);
    expect(tradeNotionalUsd(t)).toBe(4.2);
    expect(tradeFilledShares(t)).toBe(7);
    expect(tradeAvgPrice(t)).toBe(0.6);
    expect(realizedPnlSource(t)).toBe("authoritative-clob");
  });

  it("partial-match counts as authoritative", () => {
    const t = makeTrade({ mode: "real", reconciliationStatus: "partial-match", actualNotionalUsd: 1, actualFilledShares: 2 });
    expect(tradeIsAuthoritative(t)).toBe(true);
    expect(tradeIsUnsafeForAccounting(t)).toBe(false);
  });
});
