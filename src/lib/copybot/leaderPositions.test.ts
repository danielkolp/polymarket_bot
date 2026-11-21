import { describe, expect, it } from "vitest";
import {
  buildLeaderHoldings,
  leaderHoldStatus,
  reconcileLeaderHoldings,
  selectLeaderExitedPositions,
  sourceWalletsOf,
} from "./leaderPositions";
import { makePosition } from "./testFixtures";
import type { AccountPosition } from "@/lib/polymarket/positions";

const LEADER = "0x" + "a".repeat(40);
const OTHER = "0x" + "c".repeat(40);

function acct(tokenId: string, size = 10): AccountPosition {
  return { tokenId, size } as AccountPosition;
}

describe("buildLeaderHoldings", () => {
  it("maps fetched positions to a token set and failed fetches to null (no data)", () => {
    const holdings = buildLeaderHoldings([
      { wallet: LEADER, positions: [acct("tokA"), acct("tokB", 0)] }, // tokB is dust → excluded
      { wallet: OTHER, positions: null }, // fetch failed
    ]);
    expect(holdings.get(LEADER)?.has("tokA")).toBe(true);
    expect(holdings.get(LEADER)?.has("tokB")).toBe(false);
    expect(holdings.get(OTHER)).toBeNull();
  });
});

describe("leaderHoldStatus", () => {
  it("returns 'yes' when a source leader still holds the token", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: [acct("tokA")] }]);
    const pos = makePosition({ tokenId: "tokA", sourceWallets: [LEADER] });
    expect(leaderHoldStatus(pos, holdings)).toBe("yes");
  });

  it("returns 'no' when we have data for a source leader and it no longer holds the token", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: [acct("somethingElse")] }]);
    const pos = makePosition({ tokenId: "tokA", sourceWallets: [LEADER] });
    expect(leaderHoldStatus(pos, holdings)).toBe("no");
  });

  it("returns 'unknown' for manual/unknown positions (no source wallet)", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: [] }]);
    const pos = makePosition({ tokenId: "tokA", sourceWallets: [] });
    expect(leaderHoldStatus(pos, holdings)).toBe("unknown");
  });

  it("returns 'unknown' (never 'no') when the leader fetch failed", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: null }]);
    const pos = makePosition({ tokenId: "tokA", sourceWallets: [LEADER] });
    expect(leaderHoldStatus(pos, holdings)).toBe("unknown");
  });

  it("returns 'yes' if ANY source leader still holds it", () => {
    const holdings = buildLeaderHoldings([
      { wallet: LEADER, positions: [] },
      { wallet: OTHER, positions: [acct("tokA")] },
    ]);
    const pos = makePosition({ tokenId: "tokA", sourceWallets: [LEADER, OTHER] });
    expect(leaderHoldStatus(pos, holdings)).toBe("yes");
  });
});

describe("selectLeaderExitedPositions", () => {
  const OLD = Date.now() - 60 * 60 * 1000;

  it("selects only bot-opened positions whose leader was seen holding and has now exited", () => {
    const before = buildLeaderHoldings([{ wallet: LEADER, positions: [acct("exited"), acct("held")] }]);
    const after = buildLeaderHoldings([{ wallet: LEADER, positions: [acct("held")] }]);
    const seen = reconcileLeaderHoldings(
      [
        makePosition({ tokenId: "exited", sourceWallets: [LEADER], openedAt: OLD }),
        makePosition({ tokenId: "held", sourceWallets: [LEADER], openedAt: OLD }),
      ],
      before,
    );
    const exited = reconcileLeaderHoldings(seen, after);
    const selected = selectLeaderExitedPositions(exited);
    expect(selected.map((p) => p.tokenId)).toEqual(["exited"]);
  });

  it("never exits a position the leader was never seen holding (feed lag / paging gaps)", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: [] }]);
    const annotated = reconcileLeaderHoldings([makePosition({ tokenId: "fresh", sourceWallets: [LEADER], openedAt: OLD })], holdings);
    expect(annotated[0].leaderHolds).toBe("no");
    expect(selectLeaderExitedPositions(annotated)).toHaveLength(0);
  });

  it("never exits a copy younger than 15 minutes, even after a yes -> no flip", () => {
    const now = Date.now();
    const p = makePosition({ tokenId: "t", sourceWallets: [LEADER], openedAt: now - 60_000, leaderSeenHolding: true, leaderHolds: "no" });
    expect(selectLeaderExitedPositions([p], now)).toHaveLength(0);
    expect(selectLeaderExitedPositions([p], now + 20 * 60_000)).toHaveLength(1);
  });

  it("NEVER selects manual/unknown positions even if marked 'no'", () => {
    // Force a manual position (no source wallet) that somehow carries leaderHolds "no".
    const manual = makePosition({ tokenId: "manual", sourceWallets: [], leaderHolds: "no" });
    expect(selectLeaderExitedPositions([manual])).toHaveLength(0);
  });

  it("does not select 'unknown' positions (fetch failed) — avoids selling on an API blip", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: null }]);
    const annotated = reconcileLeaderHoldings([makePosition({ tokenId: "x", sourceWallets: [LEADER] })], holdings);
    expect(annotated[0].leaderHolds).toBe("unknown");
    expect(selectLeaderExitedPositions(annotated)).toHaveLength(0);
  });
});

describe("reconcileLeaderHoldings", () => {
  it("annotates leaderHolds and leaderCheckedAt without mutating other fields", () => {
    const holdings = buildLeaderHoldings([{ wallet: LEADER, positions: [acct("tokA")] }]);
    const [out] = reconcileLeaderHoldings([makePosition({ tokenId: "tokA", sourceWallets: [LEADER], shares: 7 })], holdings, 123);
    expect(out.leaderHolds).toBe("yes");
    expect(out.leaderCheckedAt).toBe(123);
    expect(out.shares).toBe(7);
  });
});

describe("sourceWalletsOf", () => {
  it("returns unique, lowercased source wallets", () => {
    const wallets = sourceWalletsOf([
      makePosition({ sourceWallets: [LEADER.toUpperCase()] }),
      makePosition({ sourceWallets: [LEADER, OTHER] }),
      makePosition({ sourceWallets: [] }),
    ]);
    expect(wallets.sort()).toEqual([LEADER, OTHER].sort());
  });
});
