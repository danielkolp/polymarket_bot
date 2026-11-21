import { describe, expect, it } from "vitest";
import { usesLiveWalletForMetrics } from "./bot";

describe("paper account metrics", () => {
  it("never re-anchor paper numbers to the real wallet", () => {
    expect(usesLiveWalletForMetrics("simulation")).toBe(false);
    expect(usesLiveWalletForMetrics("real")).toBe(true);
  });
});
