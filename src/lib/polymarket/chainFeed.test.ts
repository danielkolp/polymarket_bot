import { describe, expect, it } from "vitest";
import { utils } from "ethers";
import { aggregateFills, decodeOrderFilled, ORDER_FILLED_TOPIC, type RawLog } from "./chainFeed";

const MAKER = "0xa7349eac1895b021443ce742e1bd4586d3b081fd";
const TAKER = "0x1122a4af74156a76b8e30d273857074a3035e47d";
const TOKEN = "45360029122595187807123456789";

function pad(addr: string) {
  return "0x" + addr.replace(/^0x/, "").padStart(64, "0");
}

function log(opts: { side: 0 | 1; maker?: string; makerAmt: number; takerAmt: number; tx?: string; block?: number; logIndex?: number }): RawLog {
  const data = utils.defaultAbiCoder.encode(
    ["uint8", "uint256", "uint256", "uint256", "uint256", "bytes32", "bytes32"],
    [opts.side, TOKEN, Math.round(opts.makerAmt * 1e6), Math.round(opts.takerAmt * 1e6), 0, utils.hexZeroPad("0x0", 32), utils.hexZeroPad("0x0", 32)],
  );
  return {
    address: "0xE111180000d2663C0091e4f400237545B87B996B",
    topics: [ORDER_FILLED_TOPIC, utils.hexZeroPad("0x01", 32), pad(opts.maker ?? MAKER), pad(TAKER)],
    data,
    blockNumber: "0x" + (opts.block ?? 100).toString(16),
    transactionHash: opts.tx ?? "0xabc",
    logIndex: "0x" + (opts.logIndex ?? 0).toString(16),
    blockTimestamp: "0x" + (1_800_000_000).toString(16),
  };
}

describe("decodeOrderFilled", () => {
  it("decodes a SELL fill (live case: 30.6 shares for $29.99 = 98c)", () => {
    const f = decodeOrderFilled(log({ side: 1, makerAmt: 30.602041, takerAmt: 29.99 }));
    expect(f).not.toBeNull();
    expect(f!.side).toBe("SELL");
    expect(f!.maker).toBe(MAKER);
    expect(f!.tokenId).toBe(TOKEN);
    expect(f!.shares).toBeCloseTo(30.602041, 6);
    expect(f!.collateral).toBeCloseTo(29.99, 6);
    expect(f!.timestamp).toBe(1_800_000_000);
  });

  it("decodes a BUY fill: maker pays collateral, receives shares", () => {
    const f = decodeOrderFilled(log({ side: 0, makerAmt: 4.2, takerAmt: 10 }));
    expect(f!.side).toBe("BUY");
    expect(f!.shares).toBeCloseTo(10, 6);
    expect(f!.collateral).toBeCloseTo(4.2, 6);
  });

  it("ignores other events and removed logs", () => {
    const other = { ...log({ side: 0, makerAmt: 1, takerAmt: 2 }), topics: ["0xdeadbeef", "0x0", "0x0", "0x0"] };
    expect(decodeOrderFilled(other)).toBeNull();
    expect(decodeOrderFilled({ ...log({ side: 0, makerAmt: 1, takerAmt: 2 }), removed: true })).toBeNull();
  });
});

describe("aggregateFills", () => {
  it("merges one order's partial fills into one signal at the volume-weighted price", () => {
    const fills = [
      decodeOrderFilled(log({ side: 0, makerAmt: 4, takerAmt: 10, logIndex: 1 }))!,
      decodeOrderFilled(log({ side: 0, makerAmt: 4.4, takerAmt: 10, logIndex: 2 }))!,
    ];
    const agg = aggregateFills(fills);
    expect(agg).toHaveLength(1);
    expect(agg[0].shares).toBeCloseTo(20, 6);
    expect(agg[0].price).toBeCloseTo(0.42, 6);
  });

  it("keeps different traders, transactions and sides apart", () => {
    const fills = [
      decodeOrderFilled(log({ side: 0, makerAmt: 4, takerAmt: 10, tx: "0x1" }))!,
      decodeOrderFilled(log({ side: 0, makerAmt: 4, takerAmt: 10, tx: "0x2" }))!,
      decodeOrderFilled(log({ side: 1, makerAmt: 10, takerAmt: 4, tx: "0x1" }))!,
      decodeOrderFilled(log({ side: 0, makerAmt: 4, takerAmt: 10, tx: "0x1", maker: TAKER }))!,
    ];
    expect(aggregateFills(fills)).toHaveLength(4);
  });
});
