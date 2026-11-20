/**
 * ⚠️  LIVE POLYMARKET EXECUTION — REAL MONEY.  ⚠️
 *
 * Talks to Polymarket's CLOB V2 (production since 2026-04-28) through
 * @polymarket/clob-client-v2 for EVERY wallet type, using an ethers v5 Wallet
 * as the EIP-712 signer. The legacy V1 client no longer works against
 * production and has been removed. Everything here is gated:
 *
 *   1. config.enableRealTrading must be true (ENABLE_REAL_TRADING=true), AND
 *   2. POLYMARKET_PRIVATE_KEY must be set (+ funder/signature type for proxy,
 *      safe or deposit wallets).
 *
 * Orders are FAK ("fill and kill") marketable orders WITH an explicit worst
 * price: a BUY never pays more than its limit and a SELL never accepts less than
 * its floor. Unfilled remainders are cancelled by the exchange.
 *
 * Every network call is wrapped in a timeout so a hung request can never freeze
 * the bot loop.
 *
 * SERVER-ONLY. Never import this into a client component.
 */
import { Wallet } from "ethers";
import {
  AssetType,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type ApiKeyCreds,
  type Chain,
} from "@polymarket/clob-client-v2";
import { config } from "@/lib/config";
import { getTokenMarketMeta, roundToTick } from "@/lib/polymarket/clobMeta";
import { withTimeout } from "@/lib/util/withTimeout";

const CLOB_CALL_TIMEOUT_MS = 15_000;
const COLLATERAL_DECIMALS = 6;

// Polymarket USD (pUSD) collateral for Deposit Wallet accounts. The v5 CLOB
// client still reports the legacy USDC.e collateral balance through
// balance-allowance; pUSD accounts are read from cash-only public/on-chain
// sources so sizing never treats portfolio value as spendable balance.
const PUSD_TOKEN_ADDRESS = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const PUSD_DECIMALS = 6;
const FALLBACK_POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon.llamarpc.com",
  "https://1rpc.io/matic",
  "https://polygon.drpc.org",
  "https://polygon-rpc.com",
  "https://rpc.ankr.com/polygon",
];

const BALANCE_OF_SELECTOR = "0x70a08231";

function encodeBalanceOf(ownerAddress: string): string {
  const clean = ownerAddress.toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(clean)) {
    throw new LiveTradingError("Invalid ERC20 balance owner address.");
  }
  return BALANCE_OF_SELECTOR + clean.padStart(64, "0");
}

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(6000),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("non-json RPC response: " + text.slice(0, 160));
  }
  const body = parsed as { result?: unknown; error?: { message?: string; code?: number } };
  if (body.error) throw new Error(body.error.message ?? "RPC error " + String(body.error.code ?? "unknown"));
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]*$/.test(body.result)) {
    throw new Error("invalid RPC result: " + JSON.stringify(body.result));
  }
  return body.result;
}

function normalizeErc20Balance(rawHex: string, decimals: number): number {
  const units = BigInt(rawHex === "0x" ? "0x0" : rawHex);
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = (units % divisor).toString().padStart(decimals, "0");
  const normalized = Number(whole.toString() + "." + fraction);
  if (!Number.isFinite(normalized) || normalized > Number.MAX_SAFE_INTEGER) {
    throw new LiveTradingError("ERC20 balance is too large to normalize safely.");
  }
  return normalized;
}

async function fetchErc20Balance(rpcUrl: string, tokenAddress: string, walletAddress: string, decimals: number): Promise<number> {
  const rawHex = await ethCall(rpcUrl, tokenAddress, encodeBalanceOf(walletAddress));
  return normalizeErc20Balance(rawHex, decimals);
}

const CASH_BALANCE_FIELDS = ["cashBalance", "cash", "availableBalance", "availableCash", "balance"];

function numericField(obj: Record<string, unknown>, field: string): number | null {
  const val = obj[field];
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) return val;
  if (typeof val === "string") {
    const n = Number(val);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function readCashBalance(obj: Record<string, unknown>): number | null {
  for (const field of CASH_BALANCE_FIELDS) {
    const balance = numericField(obj, field);
    if (balance !== null) return balance;
  }

  return null;
}

/** Try Polymarket's public REST APIs for the user's cash/pUSD balance. */
async function fetchPusdBalanceFromApi(funderAddress: string): Promise<number | null> {
  // lb-api and Data API v1 were retired; v2 /value is positions value, not cash.
  const candidates = [`${config.gammaUrl}/profiles?id=${funderAddress}`];
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) continue;
      const data: unknown = await res.json();
      const rows = Array.isArray(data) ? data : [data];
      for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const balance = readCashBalance(row as Record<string, unknown>);
        if (balance !== null) return balance;
      }
    } catch {
      // try next endpoint
    }
  }
  return null;
}

/** Try on-chain ERC20 balanceOf via public Polygon RPCs. */
async function fetchPusdBalance(walletAddress: string): Promise<number | null> {
  const rpcs = config.liveRpcUrl
    ? [config.liveRpcUrl, ...FALLBACK_POLYGON_RPCS]
    : FALLBACK_POLYGON_RPCS;
  for (const rpcUrl of rpcs) {
    try {
      const balance = await fetchErc20Balance(rpcUrl, PUSD_TOKEN_ADDRESS, walletAddress, PUSD_DECIMALS);
      if (Number.isFinite(balance) && balance >= 0) return balance;
    } catch {
      // try next RPC
    }
  }
  return null;
}

/** Polymarket CLOB rejects market BUY orders below this notional (USD). */
export const CLOB_MIN_MARKET_BUY_USD = 1;

export class LiveTradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTradingError";
  }
}

/**
 * Thrown when the account uses pUSD and no server-accessible source can return
 * the cash balance. Real mode treats this as a hard stop; simulation may still
 * use paper/local accounting.
 */
export class PusdBalanceUnavailableError extends LiveTradingError {
  constructor() {
    super(
      "pUSD cash balance is not readable via CLOB, Polymarket cash APIs, or on-chain RPC. " +
      "Configure POLYMARKET_FUNDER_ADDRESS and POLYMARKET_RPC_URL, then retry before real trading.",
    );
    this.name = "PusdBalanceUnavailableError";
  }
}
export interface LiveOrderResult {
  success: boolean;
  orderId: string | null;
  status: string | null;
  /** Estimated shares filled (mirror only — authoritative fills are on-chain). */
  filledShares: number;
  /** Estimated effective per-share price used for the local mirror (0..1). */
  effectivePrice: number;
  /** USDC spent (BUY) or received (SELL), estimated for the mirror. */
  notionalUsd: number;
  txHashes: string[];
  raw: unknown;
  error: string | null;
  /** The worst price the order was allowed to fill at. */
  limitPrice?: number;
  /** Accepted but delayed by the exchange: fill unknown, check via getOrder. */
  pending?: boolean;
}

export interface LiveUsdcBalance {
  usdcBalance: number;
  usdcAllowance?: number;
  raw: unknown;
  updatedAt: string;
}

/** True when real trading is both enabled and minimally configured. */
export function isLiveConfigured(): boolean {
  return config.enableRealTrading && config.livePrivateKey.trim().length > 0;
}

/**
 * Throws unless real trading is enabled AND a signing key is configured. Call
 * before any order attempt so a misconfiguration fails loudly, never silently.
 */
export function assertLiveTradingAllowed(): void {
  if (!config.enableRealTrading) {
    throw new LiveTradingError("ENABLE_REAL_TRADING is false. Refusing to place real orders.");
  }
  if (!config.livePrivateKey.trim()) {
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set. Cannot sign live orders.");
  }
  // sig type 3 (POLY_1271) is routed through @polymarket/clob-client-v2 — allowed here
}

/**
 * The address that actually holds the account's positions/collateral: the funder
 * (proxy/safe) when configured, otherwise the EOA derived from the signing key.
 * Used to fetch authoritative live positions. Throws unless live is configured.
 */
export function getLiveAccountAddress(): string {
  assertLiveTradingAllowed();
  const funder = config.liveFunderAddress.trim();
  if (funder) return funder.toLowerCase();
  return new Wallet(config.livePrivateKey.trim()).address.toLowerCase();
}

function signatureTypeV2(): SignatureTypeV2 {
  switch (config.liveSignatureType) {
    case 1:
      return SignatureTypeV2.POLY_PROXY;
    case 2:
      return SignatureTypeV2.POLY_GNOSIS_SAFE;
    case 3:
      return SignatureTypeV2.POLY_1271;
    default:
      return SignatureTypeV2.EOA;
  }
}

let clientPromise: Promise<ClobClient> | null = null;

async function buildClient(): Promise<ClobClient> {
  if (!config.livePrivateKey.trim()) {
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set.");
  }
  const host = config.clobUrl;
  const chain = config.liveChainId as Chain;
  const funderAddress = config.liveFunderAddress.trim() || undefined;
  const signatureType = signatureTypeV2();
  // ethers v5 Wallet satisfies the client's signer interface (_signTypedData +
  // getAddress). No RPC provider is needed to sign orders.
  const signer = new Wallet(config.livePrivateKey.trim());

  // L1 (key-signing) client used only to mint/derive the L2 API credentials.
  const l1 = new ClobClient({ host, chain, signer, signatureType, funderAddress, useServerTime: true });
  let creds: ApiKeyCreds;
  try {
    creds = await withTimeout(l1.createOrDeriveApiKey(), CLOB_CALL_TIMEOUT_MS, "Polymarket API key derivation");
  } catch (err) {
    throw new LiveTradingError(`Failed to derive Polymarket API credentials: ${errorMessage(err)}`);
  }
  if (!creds?.key || !creds?.secret || !creds?.passphrase) {
    throw new LiveTradingError("Polymarket returned incomplete API credentials.");
  }
  return new ClobClient({ host, chain, signer, creds, signatureType, funderAddress, useServerTime: true });
}

/** Lazily construct and cache the authenticated CLOB V2 client. */
export async function getLiveClobClient(): Promise<ClobClient> {
  if (!clientPromise) {
    clientPromise = buildClient().catch((err) => {
      clientPromise = null; // allow a retry after a transient failure
      throw err;
    });
  }
  return clientPromise;
}

/** Drop the cached client (e.g. after changing credentials). */
export function resetLiveClobClient(): void {
  clientPromise = null;
}

/** Run a CLOB client call with a hard timeout. */
function clob<T>(promise: Promise<T>, label: string, ms = CLOB_CALL_TIMEOUT_MS): Promise<T> {
  return withTimeout(promise, ms, label);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeCollateralAmount(value: unknown, field: string): number {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new LiveTradingError("Polymarket balance response is missing numeric " + field + ".");
  }
  const raw = String(value).trim();
  if (!raw) throw new LiveTradingError("Polymarket balance response returned empty " + field + ".");
  if (/^\d+$/.test(raw)) {
    return normalizeErc20Balance("0x" + BigInt(raw).toString(16), COLLATERAL_DECIMALS);
  }
  if (/^\d+\.\d+$/.test(raw)) {
    const normalized = Number(raw);
    if (!Number.isFinite(normalized)) throw new LiveTradingError("Polymarket balance response " + field + " is invalid.");
    return normalized;
  }
  throw new LiveTradingError("Polymarket balance response " + field + " has an unsupported format.");
}

function maxAllowance(raw: Record<string, unknown>): number | undefined {
  const allowances = raw.allowances;
  if (allowances && typeof allowances === "object") {
    let best: number | undefined;
    for (const v of Object.values(allowances as Record<string, unknown>)) {
      try {
        const n = normalizeCollateralAmount(v, "allowance");
        best = best == null ? n : Math.max(best, n);
      } catch {
        // ignore malformed allowance entries
      }
    }
    return best;
  }
  if (raw.allowance != null) {
    try {
      return normalizeCollateralAmount(raw.allowance, "allowance");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function syncClobBalanceAllowance(client: ClobClient): Promise<unknown> {
  try {
    return await clob(client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL }), "balance-allowance sync");
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

async function fetchPusdBalanceSnapshot(
  funderAddress: string,
  rawContext: Record<string, unknown> = {},
): Promise<LiveUsdcBalance> {
  const apiBalance = await fetchPusdBalanceFromApi(funderAddress);
  if (apiBalance !== null) {
    return {
      usdcBalance: apiBalance,
      usdcAllowance: undefined,
      raw: { ...rawContext, balanceSource: "pusd-api", pusdApiBalance: apiBalance },
      updatedAt: new Date().toISOString(),
    };
  }

  const onChainBalance = await fetchPusdBalance(funderAddress);
  if (onChainBalance !== null) {
    return {
      usdcBalance: onChainBalance,
      usdcAllowance: undefined,
      raw: { ...rawContext, balanceSource: "pusd-on-chain", pusdOnChainBalance: onChainBalance },
      updatedAt: new Date().toISOString(),
    };
  }

  throw new PusdBalanceUnavailableError();
}
/**
 * Fetch the authoritative live cash balance. Uses authenticated CLOB V2
 * balance-allowance; deposit-wallet (type 3) accounts and empty CLOB reads fall
 * back to cash-only public/on-chain pUSD sources by funder address.
 */
export async function fetchLiveUsdcBalance(options: { syncAllowance?: boolean } = {}): Promise<LiveUsdcBalance> {
  const privateKey = config.livePrivateKey.trim();
  const funder = config.liveFunderAddress.trim();

  if (config.liveSignatureType === 3) {
    if (!funder) {
      throw new LiveTradingError("POLYMARKET_FUNDER_ADDRESS is required for deposit-wallet balance reads.");
    }
    return fetchPusdBalanceSnapshot(funder, { signatureType: 3, skippedClob: "deposit-wallet pUSD cash path" });
  }

  if (!privateKey) {
    if (funder) return fetchPusdBalanceSnapshot(funder, { skippedClob: "POLYMARKET_PRIVATE_KEY not set" });
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set. Cannot fetch live balance.");
  }

  try {
    const client = await getLiveClobClient();
    let syncResult: unknown = null;
    if (options.syncAllowance) syncResult = await syncClobBalanceAllowance(client);

    const read = async () => {
      const resp = await clob(client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }), "balance read");
      const raw = (resp ?? {}) as unknown as Record<string, unknown>;
      if (raw.error) throw new LiveTradingError("Polymarket balance endpoint returned an error: " + String(raw.error));
      return { resp, raw, balance: normalizeCollateralAmount(raw.balance, "balance") };
    };

    let r = await read();
    if (r.balance === 0 && !options.syncAllowance) {
      syncResult = await syncClobBalanceAllowance(client);
      r = await read();
    }
    if (r.balance === 0 && funder) {
      try {
        return await fetchPusdBalanceSnapshot(funder, {
          balanceSource: "clob-zero-fallback",
          balanceSync: syncResult,
          balanceAllowance: r.resp,
        });
      } catch {
        // pUSD fallback unavailable: a genuine zero balance is still a valid answer
      }
    }
    return {
      usdcBalance: r.balance,
      usdcAllowance: maxAllowance(r.raw),
      raw: { balanceSource: "clob-v2", balanceSync: syncResult, balanceAllowance: r.resp },
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof LiveTradingError) throw err;
    throw new LiveTradingError("Failed to fetch live balance from Polymarket CLOB: " + errorMessage(err));
  }
}

/**
 * Best-effort: ask the CLOB to refresh its view of the collateral allowance.
 * Proxy/safe wallets are approved by Polymarket; an EOA may need a one-time
 * on-chain approval that this call cannot perform — failures are swallowed.
 */
export async function ensureUsdcAllowance(): Promise<void> {
  try {
    const client = await getLiveClobClient();
    await syncClobBalanceAllowance(client);
  } catch {
    // surfaced elsewhere if an order later fails on allowance
  }
}

/** One authoritative fill from the CLOB trade history (real money). */
export interface LiveTradeFill {
  /** CLOB trade id. */
  id: string;
  /** The taker order id this fill settled, if present. */
  orderId: string | null;
  tokenId: string;
  conditionId: string;
  side: "BUY" | "SELL";
  /** Shares filled. */
  shares: number;
  /** Per-share fill price, 0..1. */
  price: number;
  /** USDC notional (shares * price). */
  notionalUsd: number;
  status: string | null;
  /** Match/settlement time in ms epoch, if available. */
  matchTimeMs: number | null;
  txHashes: string[];
}

function toNum(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function normalizeLiveTrade(raw: Record<string, unknown>): LiveTradeFill | null {
  const tokenId = String(raw.asset_id ?? raw.assetId ?? raw.tokenID ?? raw.token_id ?? "");
  if (!tokenId) return null;
  const idRaw = raw.id ?? raw.trade_id ?? raw.tradeId;
  const orderIdRaw = raw.taker_order_id ?? raw.takerOrderId ?? raw.order_id ?? raw.orderID ?? null;
  const sideRaw = String(raw.side ?? "").toUpperCase();
  const shares = toNum(raw.size ?? raw.matched_amount ?? raw.amount);
  const price = toNum(raw.price);
  const matchRaw = raw.match_time ?? raw.matchTime ?? raw.timestamp;
  const matchSec = toNum(matchRaw);
  // match_time is typically unix seconds; tolerate ms by leaving large values as-is.
  const matchTimeMs = matchSec > 0 ? (matchSec > 1e12 ? matchSec : matchSec * 1000) : null;
  const txField = raw.transaction_hash ?? raw.transactionHash ?? raw.bucket_index;
  const txHashes = Array.isArray(raw.transactionsHashes)
    ? (raw.transactionsHashes as unknown[]).map(String)
    : typeof txField === "string" && txField.startsWith("0x")
      ? [txField]
      : [];

  return {
    id: idRaw ? String(idRaw) : `${tokenId}:${matchSec}:${price}:${shares}`,
    orderId: orderIdRaw ? String(orderIdRaw) : null,
    tokenId,
    conditionId: String(raw.market ?? raw.condition_id ?? raw.conditionId ?? ""),
    side: sideRaw === "SELL" ? "SELL" : "BUY",
    shares,
    price,
    notionalUsd: shares * price,
    status: raw.status != null ? String(raw.status) : null,
    matchTimeMs,
    txHashes,
  };
}

/**
 * Pull one page of CLOB trades and surface its rows + an optional next cursor.
 * Throws on an UNEXPECTED payload shape (so reconciliation errors and BUYs block)
 * — an explicit empty array is a valid "no trades" page and is allowed.
 */
function extractTradePage(resp: unknown): { rows: unknown[]; nextCursor: string | null } {
  if (Array.isArray(resp)) return { rows: resp, nextCursor: null };
  if (resp && typeof resp === "object") {
    const obj = resp as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      const cursorRaw = obj.next_cursor ?? obj.nextCursor;
      const nextCursor = typeof cursorRaw === "string" && cursorRaw && cursorRaw !== "LTE=" ? cursorRaw : null;
      return { rows: obj.data, nextCursor };
    }
  }
  throw new LiveTradingError(
    "Polymarket getTrades() returned an unexpected shape; refusing to assume zero fills.",
  );
}

/**
 * Fetch authoritative trade fills for the trading account from the CLOB.
 *
 * Only walks history newer than `sinceMs` (when given) and stops after
 * config.liveReconcileMaxPages pages, so a long-lived account does not re-read
 * its whole history every poll. Throws on network errors OR an unexpected
 * payload shape — callers turn that into a reconciliation error.
 */
export async function fetchLiveTrades(options: { sinceMs?: number } = {}): Promise<LiveTradeFill[]> {
  assertLiveTradingAllowed();
  const client = await getLiveClobClient();
  const out: LiveTradeFill[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  const maxPages = Math.max(1, config.liveReconcileMaxPages);
  const params = options.sinceMs && options.sinceMs > 0
    ? { after: String(Math.floor(options.sinceMs / 1000)) }
    : undefined;

  for (let page = 0; page < maxPages; page += 1) {
    let resp: unknown;
    try {
      resp = await clob(client.getTradesPaginated(params, cursor), "trade history read");
    } catch (err) {
      throw new LiveTradingError("Failed to fetch live trade history from Polymarket CLOB: " + errorMessage(err));
    }
    const shaped = resp && typeof resp === "object" && Array.isArray((resp as { trades?: unknown }).trades)
      ? { data: (resp as { trades: unknown[] }).trades, next_cursor: (resp as { next_cursor?: string }).next_cursor }
      : resp;
    const { rows, nextCursor } = extractTradePage(shaped);
    for (const item of rows) {
      if (item && typeof item === "object") {
        const fill = normalizeLiveTrade(item as Record<string, unknown>);
        if (fill && fill.shares > 0 && fill.price > 0 && !seen.has(fill.id)) {
          seen.add(fill.id);
          out.push(fill);
        }
      }
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }
  return out;
}

/** Authoritative state of one order (size matched so far, status). */
export interface LiveOrderState {
  orderId: string;
  /** e.g. "MATCHED", "CANCELED", "LIVE", "UNMATCHED", "DELAYED". Upper-cased. */
  status: string;
  sizeMatched: number;
  originalSize: number;
  price: number;
  side: "BUY" | "SELL";
  tokenId: string;
}

/**
 * Read one order from the CLOB. Returns null when the CLOB does not know the
 * order (never accepted) — callers treat that as "no fill".
 */
export async function fetchLiveOrder(orderId: string): Promise<LiveOrderState | null> {
  assertLiveTradingAllowed();
  if (!orderId) return null;
  const client = await getLiveClobClient();
  let raw: unknown;
  try {
    raw = await clob(client.getOrder(orderId), "order status read");
  } catch (err) {
    const msg = errorMessage(err);
    if (/not found|404|does not exist/i.test(msg)) return null;
    throw new LiveTradingError("Failed to read order " + orderId + ": " + msg);
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.error || !(o.id || o.orderID)) return null;
  return {
    orderId: String(o.id ?? o.orderID ?? orderId),
    status: String(o.status ?? "").toUpperCase(),
    sizeMatched: toNum(o.size_matched),
    originalSize: toNum(o.original_size),
    price: toNum(o.price),
    side: String(o.side ?? "").toUpperCase() === "SELL" ? "SELL" : "BUY",
    tokenId: String(o.asset_id ?? ""),
  };
}

export interface LiveMarketOrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  /** USDC to spend — required for BUY. */
  usdAmount?: number;
  /** Shares to sell — required for SELL. */
  shares?: number;
  /** Best ask (BUY) / best bid (SELL) used for the local estimate. */
  referencePrice: number;
  /**
   * Worst acceptable price: BUY never pays above it, SELL never sells below it.
   * Rounded onto the market tick grid (down for BUY, up for SELL).
   */
  limitPrice?: number;
  conditionId?: string | null;
}

function parseAmount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Derive the actual fill from an order response's making/taking amounts.
 * BUY: making = USDC paid, taking = shares received. SELL: the reverse.
 * Amounts may come back as decimals or 6-dp base units; both are handled by
 * sanity-checking against the requested size.
 */
export function fillFromOrderResponse(
  side: "BUY" | "SELL",
  requested: number,
  making: unknown,
  taking: unknown,
): { shares: number; usd: number } | null {
  let m = parseAmount(making);
  let t = parseAmount(taking);
  if (m == null || t == null) return null;
  const scale = (x: number, cap: number) => (x > cap * 1000 ? x / 10 ** COLLATERAL_DECIMALS : x);
  if (side === "BUY") {
    m = scale(m, Math.max(1, requested)); // usd
    t = scale(t, Math.max(1, requested) * 1000); // shares
    const price = m / t;
    if (!(price > 0 && price <= 1.0001)) return null;
    return { shares: t, usd: m };
  }
  m = scale(m, Math.max(1, requested)); // shares
  t = scale(t, Math.max(1, requested)); // usd
  const price = t / m;
  if (!(price > 0 && price <= 1.0001)) return null;
  return { shares: m, usd: t };
}

/**
 * Place a price-protected FAK order and return a normalized result. Throws only
 * on a hard failure (bad config, network, timeout); a rejected order returns
 * success:false. `filledShares` is the MATCHED size (0 when nothing filled).
 */
export async function placeLiveMarketOrder(params: LiveMarketOrderParams): Promise<LiveOrderResult> {
  assertLiveTradingAllowed();

  const side = params.side === "BUY" ? Side.BUY : Side.SELL;
  const amount = params.side === "BUY"
    ? Math.floor((params.usdAmount ?? 0) * 100) / 100
    : Math.floor((params.shares ?? 0) * 100) / 100;
  if (!(amount > 0)) {
    throw new LiveTradingError(`Live ${params.side} amount must be positive (got ${amount}).`);
  }

  const client = await getLiveClobClient();
  const meta = await getTokenMarketMeta(params.tokenId, params.conditionId);
  const tick = meta.tickSize;

  // Worst acceptable price on the tick grid. Without an explicit limit, fall
  // back to the reference price +/- 5 ticks so an order can never sweep a thin
  // book far away from the quote it was sized on.
  const fallbackLimit = params.side === "BUY"
    ? params.referencePrice + 5 * tick
    : params.referencePrice - 5 * tick;
  const rawLimit = params.limitPrice != null && Number.isFinite(params.limitPrice) ? params.limitPrice : fallbackLimit;
  const price = roundToTick(rawLimit, tick, params.side === "BUY" ? "down" : "up");

  const resp: unknown = await clob(
    client.createAndPostMarketOrder(
      { tokenID: params.tokenId, amount, side, price, orderType: OrderType.FAK },
      { tickSize: String(tick) as never, negRisk: meta.negRisk },
      OrderType.FAK,
    ),
    "order placement",
    25_000,
  );

  const r = (resp ?? {}) as Record<string, unknown>;
  const orderIdRaw = r.orderID ?? r.orderId ?? null;
  const orderId = orderIdRaw ? String(orderIdRaw) : null;
  const status = r.status != null ? String(r.status) : null;
  const errorMsg = r.errorMsg ? String(r.errorMsg) : r.error ? String(r.error) : null;
  const accepted = (r.success === true || (r.success == null && orderId != null)) && !errorMsg && orderId != null;
  const rawHashes = (r.transactionsHashes ?? r.transactionHashes) as unknown;
  const txHashes = Array.isArray(rawHashes) ? rawHashes.map(String) : [];

  let fill = fillFromOrderResponse(params.side, amount, r.makingAmount, r.takingAmount);
  if (accepted && !fill && orderId) {
    // Ask the CLOB what actually matched.
    try {
      const state = await fetchLiveOrder(orderId);
      if (state && state.sizeMatched > 0) {
        const px = state.price > 0 ? state.price : price;
        fill = { shares: state.sizeMatched, usd: state.sizeMatched * px };
      }
    } catch {
      // leave unknown; reconciliation resolves it
    }
  }

  const delayed = /delay/i.test(status ?? "");
  const filledShares = fill?.shares ?? 0;
  const notionalUsd = fill?.usd ?? 0;
  const effectivePrice = filledShares > 0 ? notionalUsd / filledShares : 0;
  const success = accepted && (filledShares > 0 || delayed);

  return {
    success,
    orderId,
    status,
    filledShares,
    effectivePrice,
    notionalUsd,
    txHashes,
    raw: resp,
    error: success
      ? null
      : errorMsg ?? (accepted ? "Order was accepted but nothing filled at or better than the limit price." : "Order was not accepted by the CLOB."),
    limitPrice: price,
    pending: accepted && delayed && filledShares === 0,
  };
}
