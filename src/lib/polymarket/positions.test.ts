import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchUserPositions } from "./positions";

afterEach(() => vi.unstubAllGlobals());

function stubPositions(rows: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ data: rows, pagination: { next_cursor: null } }), { status: 200 })),
  );
}

describe("fetchUserPositions (Data API v2)", () => {
  it("treats a REDEEMABLE row priced at $0 as a loss, not winnings", async () => {
    stubPositions([
      { token_id: "lost", condition_id: "c1", current_size: 600, current_price: 0, status: "REDEEMABLE", redeemable: true },
      { token_id: "won", condition_id: "c2", current_size: 10, current_price: 1, status: "REDEEMABLE", redeemable: true },
      { token_id: "open", condition_id: "c3", current_size: 5, current_price: 0.4, status: "OPEN", redeemable: false },
    ]);
    const rows = await fetchUserPositions("0xabc", 500, ["OPEN"]);
    const byToken = Object.fromEntries(rows.map((r) => [r.tokenId, r]));
    expect(byToken.lost.redeemable).toBe(false);
    expect(byToken.lost.lost).toBe(true);
    expect(byToken.won.redeemable).toBe(true);
    expect(byToken.won.lost).toBe(false);
    expect(byToken.open.redeemable).toBe(false);
    expect(byToken.open.lost).toBe(false);
  });
});
