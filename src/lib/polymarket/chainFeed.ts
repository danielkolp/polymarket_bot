/**
 * Real-time copy signal: read followed traders' fills straight from Polygon.
 *
 * Polymarket's public trade feed (Data API v2 /trades) publishes fills about
 * four minutes late — long enough for the price to move past the bot's
 * "never pay more than 2c over the trader" cap. Every Polymarket fill is an
 * `OrderFilled` event on one of the exchange contracts, visible on-chain within
 * one or two blocks (~2-4 s). Polling those logs, filtered to the followed
 * wallets, lets the bot copy at (almost) the trader's price.
 *
 * Event (CTF Exchange V2 / Neg Risk Exchange V2 / ExchangeV3):
 *   OrderFilled(bytes32 indexed orderHash, address indexed maker,
 *               address indexed taker, uint8 side, uint256 tokenId,
 *               uint256 makerAmountFilled, uint256 takerAmountFilled,
 *               uint256 fee, bytes32 builder, bytes32 metadata)
 *
 * One OrderFilled is emitted per order filled — including the taker's own
 * order — with `maker` = that order's owner (the trader's proxy / deposit
 * wallet, the same address the Data API reports). Filtering on `maker` therefore
 * catches both a trader's resting limit orders and their market orders, once.
 * `side` is that order's side (0 = BUY, 1 = SELL). Amounts have 6 decimals:
 * BUY  → makerAmount = collateral paid,  takerAmount = shares received;
 * SELL → makerAmount = shares sold,      takerAmount = collateral received.
 *
 * The Data API feed stays on as a fallback; both sources share one dedupe key
 * (tx hash + wallet + token + side), so a fill is acted on once.
 */
import { utils } from "ethers";
import { config } from "@/lib/config";
import { withTimeout } from "@/lib/util/withTimeout";
import type { TraderTrade } from "./types";

export const POLYMARKET_EXCHANGES = [
  "0xE111180000d2663C0091e4f400237545B87B996B", // CTF Exchange (V2)
  "0xe2222d279d744050d28e00520010520000310F59", // Neg Risk CTF Exchange (V2)
  "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa", // ExchangeV3 (Polymarket Protocol V2 positions)
] as const;

/** keccak256("OrderFilled(bytes32,address,address,uint8,uint256,uint256,uint256,uint256,bytes32,bytes32)") */
export const ORDER_FILLED_TOPIC = "0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee";

const PUBLIC_POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.drpc.org",
  "https://1rpc.io/matic",
  "https://polygon-rpc.com",
];
const RPC_TIMEOUT_MS = 6_000;
/** Never look further back than this (≈10 min at ~2 s blocks): older fills are stale signals anyway. */
const MAX_BLOCK_SPAN = 300;
/** On first poll, start a few blocks back so a fill in flight isn't missed. */
const INITIAL_LOOKBACK_BLOCKS = 5;
const MAX_WALLETS_PER_QUERY = 50;
const UNITS = 1_000_000;

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  blockTimestamp?: string;
  removed?: boolean;
}

export interface ChainFill {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  maker: string;
  side: "BUY" | "SELL";
  tokenId: string;
  shares: number;
  collateral: number;
  /** Unix seconds, when the RPC reports it. */
  timestamp: number | null;
}

/** Decode one OrderFilled log; null for anything that isn't a well-formed fill. */
export function decodeOrderFilled(log: RawLog): ChainFill | null {
  if (log.removed) return null;
  if (!log.topics || log.topics[0]?.toLowerCase() !== ORDER_FILLED_TOPIC || log.topics.length < 4) return null;
  try {
    const [side, tokenId, makerAmount, takerAmount] = utils.defaultAbiCoder.decode(
      ["uint8", "uint256", "uint256", "uint256", "uint256", "bytes32", "bytes32"],
      log.data,
    );
    const isBuy = Number(side) === 0;
    const maker = ("0x" + log.topics[2].slice(26)).toLowerCase();
    const making = Number(makerAmount.toString()) / UNITS;
    const taking = Number(takerAmount.toString()) / UNITS;
    const shares = isBuy ? taking : making;
    const collateral = isBuy ? making : taking;
    if (!(shares > 0) || !(collateral > 0)) return null;
    return {
      txHash: log.transactionHash.toLowerCase(),
      blockNumber: parseInt(log.blockNumber, 16),
      logIndex: parseInt(log.logIndex, 16),
      maker,
      side: isBuy ? "BUY" : "SELL",
      tokenId: tokenId.toString(),
      shares,
      collateral,
      timestamp: log.blockTimestamp ? parseInt(log.blockTimestamp, 16) : null,
    };
  } catch {
    return null;
  }
}

export interface AggregatedFill {
  txHash: string;
  maker: string;
  side: "BUY" | "SELL";
  tokenId: string;
  shares: number;
  /** Volume-weighted price (collateral / shares), 0..1. */
  price: number;
  timestamp: number | null;
  blockNumber: number;
}

/**
 * One copy signal per (transaction, trader, token, side): a single order that
 * matched several counterparties emits several fills; the copy decision should
 * see it once, at its volume-weighted price.
 */
export function aggregateFills(fills: ChainFill[]): AggregatedFill[] {
  const groups = new Map<string, AggregatedFill & { collateral: number }>();
  for (const f of fills) {
    const key = `${f.txHash}|${f.maker}|${f.tokenId}|${f.side}`;
    const g = groups.get(key);
    if (g) {
      g.shares += f.shares;
      g.collateral += f.collateral;
      g.timestamp = g.timestamp ?? f.timestamp;
    } else {
      groups.set(key, {
        txHash: f.txHash,
        maker: f.maker,
        side: f.side,
        tokenId: f.tokenId,
        shares: f.shares,
        collateral: f.collateral,
        price: 0,
        timestamp: f.timestamp,
        blockNumber: f.blockNumber,
      });
    }
  }
  return [...groups.values()]
    .map(({ collateral, ...g }) => ({ ...g, price: Math.min(0.999, Math.max(0.001, collateral / g.shares)) }))
    .filter((g) => g.price > 0 && g.price < 1)
    .sort((a, b) => a.blockNumber - b.blockNumber);
}

function padTopic(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

export interface MarketLabel {
  conditionId: string;
  title: string;
  outcome: string;
}

export interface ChainFeedStatus {
  lastBlock: number | null;
  lastPollAt: number | null;
  lastError: string | null;
  rpc: string | null;
  fillsSeen: number;
}

/**
 * Incremental poller. Remembers the last block it read; each poll fetches new
 * OrderFilled logs for the given wallets and returns them as TraderTrades.
 * Rotates through RPC endpoints on failure; never throws to the caller.
 */
export class ChainTradeFeed {
  private lastBlock: number | null = null;
  private rpcIndex = 0;
  private blockTimes = new Map<number, number>();
  readonly status: ChainFeedStatus = { lastBlock: null, lastPollAt: null, lastError: null, rpc: null, fillsSeen: 0 };

  constructor(
    private readonly labelFor: (tokenId: string) => Promise<MarketLabel | null>,
    private readonly rpcs: string[] = [config.liveRpcUrl, ...PUBLIC_POLYGON_RPCS].filter(
      (u, i, a): u is string => Boolean(u) && a.indexOf(u) === i,
    ),
  ) {}

  private async rpc<T>(method: string, params: unknown[]): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < this.rpcs.length; attempt += 1) {
      const url = this.rpcs[(this.rpcIndex + attempt) % this.rpcs.length];
      try {
        const res = await withTimeout(
          fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          }),
          RPC_TIMEOUT_MS,
          `Polygon RPC ${method}`,
        );
        const body = (await withTimeout(res.json(), RPC_TIMEOUT_MS, "Polygon RPC body")) as { result?: T; error?: { message?: string } };
        if (body.error) throw new Error(body.error.message ?? "RPC error");
        if (body.result === undefined) throw new Error("empty RPC result");
        this.rpcIndex = (this.rpcIndex + attempt) % this.rpcs.length;
        this.status.rpc = new URL(url).host;
        return body.result;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async blockTime(blockNumber: number): Promise<number | null> {
    const cached = this.blockTimes.get(blockNumber);
    if (cached) return cached;
    try {
      const block = await this.rpc<{ timestamp?: string }>("eth_getBlockByNumber", ["0x" + blockNumber.toString(16), false]);
      const ts = block?.timestamp ? parseInt(block.timestamp, 16) : null;
      if (ts) {
        this.blockTimes.set(blockNumber, ts);
        if (this.blockTimes.size > 500) this.blockTimes.delete(this.blockTimes.keys().next().value as number);
      }
      return ts;
    } catch {
      return null;
    }
  }

  /** Start reading from the current head (used when the bot starts: no backfill). */
  async reset(): Promise<void> {
    this.lastBlock = null;
    try {
      const head = parseInt(await this.rpc<string>("eth_blockNumber", []), 16);
      this.lastBlock = head;
      this.status.lastBlock = head;
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /** New fills by `wallets` since the last poll, newest last. Never throws. */
  async poll(wallets: string[], names: Map<string, string>): Promise<TraderTrade[]> {
    this.status.lastPollAt = Date.now();
    if (wallets.length === 0) return [];
    try {
      const head = parseInt(await this.rpc<string>("eth_blockNumber", []), 16);
      if (!Number.isFinite(head)) throw new Error("bad block number");
      let from = this.lastBlock == null ? head - INITIAL_LOOKBACK_BLOCKS : this.lastBlock + 1;
      if (head - from > MAX_BLOCK_SPAN) from = head - MAX_BLOCK_SPAN;
      if (from > head) return [];

      const fills: ChainFill[] = [];
      for (let i = 0; i < wallets.length; i += MAX_WALLETS_PER_QUERY) {
        const chunk = wallets.slice(i, i + MAX_WALLETS_PER_QUERY).map(padTopic);
        const logs = await this.rpc<RawLog[]>("eth_getLogs", [
          {
            fromBlock: "0x" + from.toString(16),
            toBlock: "0x" + head.toString(16),
            address: [...POLYMARKET_EXCHANGES],
            topics: [ORDER_FILLED_TOPIC, null, chunk],
          },
        ]);
        for (const log of Array.isArray(logs) ? logs : []) {
          const fill = decodeOrderFilled(log);
          if (fill) fills.push(fill);
        }
      }
      this.lastBlock = head;
      this.status.lastBlock = head;
      this.status.lastError = null;
      this.status.fillsSeen += fills.length;

      const out: TraderTrade[] = [];
      for (const agg of aggregateFills(fills)) {
        const ts = agg.timestamp ?? (await this.blockTime(agg.blockNumber)) ?? Math.floor(Date.now() / 1000);
        const label = await this.labelFor(agg.tokenId).catch(() => null);
        out.push({
          wallet: agg.maker,
          traderName: names.get(agg.maker) ?? `${agg.maker.slice(0, 6)}…${agg.maker.slice(-4)}`,
          side: agg.side,
          tokenId: agg.tokenId,
          conditionId: label?.conditionId ?? "",
          size: agg.shares,
          price: agg.price,
          timestamp: ts,
          title: label?.title ?? "(market)",
          outcome: label?.outcome ?? "",
          txHash: agg.txHash,
        });
      }
      return out;
    } catch (err) {
      this.status.lastError = err instanceof Error ? err.message : String(err);
      return [];
    }
  }
}
