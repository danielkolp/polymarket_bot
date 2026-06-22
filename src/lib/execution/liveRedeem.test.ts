import { describe, expect, it } from "vitest";
import { assertLiveRedeemAllowed, redeemBlockedReason, redeemConditionOnChain } from "./liveRedeem";

// These tests run with the default config (real trading disabled, no RPC URL,
// Polygon chain 137, EOA signatureType 0) — i.e. the safe default posture.

describe("redeemBlockedReason — wallet/market gating", () => {
  it("allows a standard CTF position on an EOA (Polygon, non-neg-risk)", () => {
    expect(redeemBlockedReason({ negativeRisk: false })).toBeNull();
  });

  it("blocks neg-risk markets (manual redemption required)", () => {
    expect(redeemBlockedReason({ negativeRisk: true })).toMatch(/neg-risk/i);
  });
});

describe("assertLiveRedeemAllowed — gating", () => {
  it("throws when real trading / key / RPC are not configured (default)", () => {
    expect(() => assertLiveRedeemAllowed()).toThrow();
  });
});

describe("redeemConditionOnChain — failure handling", () => {
  it("returns success:false instead of throwing when redeem is not configured", async () => {
    const result = await redeemConditionOnChain("0x" + "a".repeat(64));
    expect(result.success).toBe(false);
    expect(result.txHash).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it("never throws — a single failure must not break a redeem loop", async () => {
    await expect(redeemConditionOnChain("not-a-valid-condition-id")).resolves.toMatchObject({
      success: false,
    });
  });
});
