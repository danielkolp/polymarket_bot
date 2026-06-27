/**
 * ⚠️  LIVE POLYMARKET EXECUTION — REAL MONEY.  ⚠️
 *
 * Talks to Polymarket's CLOB through @polymarket/clob-client (v5, viem-based),
 * using an ethers v5 Wallet as the EIP-712 signer. Everything here is gated:
 *
 *   1. config.enableRealTrading must be true (ENABLE_REAL_TRADING=true), AND
 *   2. POLYMARKET_PRIVATE_KEY must be set (+ funder/signature type for proxy/safe
 *      wallets).
 *
 * Orders are placed as FAK ("fill and kill") market orders: they take liquidity
 * from the live book and cancel any unfilled remainder. BUY `amount` is USDC,
 * SELL `amount` is shares — matching the copy-trading flow.
 *
 * NOTE ON ACCOUNTING: the returned `filledShares` / `effectivePrice` are a local
 * mirror estimated from the reference quote so the dashboard stays roughly
 * correct. The authoritative fills live on-chain and in the CLOB trade history;
 * reconciling against `getTrades()` is a documented follow-up.
 *
 * SERVER-ONLY. Never import this into a client component.
 */
import { Wallet } from "ethers";
import {
  ClobClient,
  OrderType,
  Side,
  AssetType,
  COLLATERAL_TOKEN_DECIMALS,
  type ApiKeyCreds,
} from "@polymarket/clob-client";
import {
  ClobClient as ClobClientV2,
  SignatureTypeV2,
  Chain as ChainV2,
  type ApiKeyCreds as ApiKeyCredsV2,
} from "@polymarket/clob-client-v2";
import { config } from "@/lib/config";

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
  const candidates = [
    `${config.dataApiUrl}/value?user=${funderAddress}`,
    `${config.gammaUrl}/profiles?id=${funderAddress}`,
    `${config.lbApiUrl}/portfolio?user=${funderAddress}`,
    `${config.lbApiUrl}/value?user=${funderAddress}`,
  ];
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

let clientPromise: Promise<ClobClient> | null = null;

async function buildClient(): Promise<ClobClient> {
  if (!config.livePrivateKey.trim()) {
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set.");
  }
  const host = config.clobUrl;
  const chainId = config.liveChainId;
  const signatureType = config.liveSignatureType as ConstructorParameters<typeof ClobClient>[4];
  const funder = config.liveFunderAddress.trim() || undefined;

  // ethers v5 Wallet — satisfies the client's EthersSigner interface
  // (_signTypedData + getAddress). No RPC provider is needed to sign orders.
  const signer = new Wallet(config.livePrivateKey.trim());

  // L1 (key-signing) client used only to mint/derive the L2 API credentials.
  const l1 = new ClobClient(host, chainId, signer, undefined, signatureType, funder);
  let creds: ApiKeyCreds;
  try {
    creds = await l1.createOrDeriveApiKey();
  } catch (err) {
    throw new LiveTradingError(
      `Failed to derive Polymarket API credentials: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // L2 (authenticated) client used for order placement.
  return new ClobClient(host, chainId, signer, creds, signatureType, funder);
}

/** Lazily construct and cache the authenticated CLOB client. */
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

// ── v2 client (POLYMARKET_SIGNATURE_TYPE=3 / POLY_1271) ──────────────────────

let clientV2Promise: Promise<ClobClientV2> | null = null;

async function buildClientV2(): Promise<ClobClientV2> {
  if (!config.livePrivateKey.trim()) {
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set.");
  }
  const host = config.clobUrl;
  // ChainV2 is a numeric enum (137 / 80002) that matches config.liveChainId.
  const chain = config.liveChainId as ChainV2;
  const funder = config.liveFunderAddress.trim() || undefined;
  const signer = new Wallet(config.livePrivateKey.trim());

  const l1 = new ClobClientV2({ host, chain, signer, signatureType: SignatureTypeV2.POLY_1271, funderAddress: funder });
  let creds: ApiKeyCredsV2;
  try {
    creds = await l1.createOrDeriveApiKey();
  } catch (err) {
    throw new LiveTradingError(
      `Failed to derive Polymarket API credentials (v2): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return new ClobClientV2({ host, chain, signer, creds, signatureType: SignatureTypeV2.POLY_1271, funderAddress: funder });
}

export async function getLiveV2ClobClient(): Promise<ClobClientV2> {
  if (!clientV2Promise) {
    clientV2Promise = buildClientV2().catch((err) => {
      clientV2Promise = null;
      throw err;
    });
  }
  return clientV2Promise;
}

export function resetLiveV2ClobClient(): void {
  clientV2Promise = null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeCollateralAmount(value: unknown, field: string): number {
  if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
    throw new LiveTradingError("Polymarket balance response is missing numeric " + field + ".");
  }

  const raw = String(value).trim();
  if (!raw) {
    throw new LiveTradingError("Polymarket balance response returned empty " + field + ".");
  }

  if (/^\d+$/.test(raw)) {
    const units = BigInt(raw);
    const divisor = 10n ** BigInt(COLLATERAL_TOKEN_DECIMALS);
    const whole = units / divisor;
    const fraction = (units % divisor).toString().padStart(COLLATERAL_TOKEN_DECIMALS, "0");
    const normalized = Number(whole.toString() + "." + fraction);
    if (!Number.isFinite(normalized) || normalized > Number.MAX_SAFE_INTEGER) {
      throw new LiveTradingError("Polymarket balance response " + field + " is too large to normalize safely.");
    }
    return normalized;
  }

  if (/^\d+\.\d+$/.test(raw)) {
    const normalized = Number(raw);
    if (!Number.isFinite(normalized) || normalized > Number.MAX_SAFE_INTEGER) {
      throw new LiveTradingError("Polymarket balance response " + field + " is invalid.");
    }
    return normalized;
  }

  throw new LiveTradingError("Polymarket balance response " + field + " has an unsupported format.");
}

function normalizeOptionalCollateralAmount(value: unknown, field: string): number | undefined {
  if (value == null || value === "") return undefined;
  try {
    return normalizeCollateralAmount(value, field);
  } catch {
    return undefined;
  }
}

async function syncClobBalanceAllowance(client: ClobClient): Promise<unknown> {
  try {
    return await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
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
 * Fetch the authoritative live cash balance. For EOA/proxy/safe accounts this
 * uses authenticated CLOB balance-allowance; for deposit-wallet pUSD accounts it
 * reads cash-only public/on-chain sources by funder address.
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
    if (funder) {
      return fetchPusdBalanceSnapshot(funder, { skippedClob: "POLYMARKET_PRIVATE_KEY not set" });
    }
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set. Cannot fetch live balance.");
  }

  try {
    const client = await getLiveClobClient();
    let syncResult: unknown = null;
    if (options.syncAllowance) {
      syncResult = await syncClobBalanceAllowance(client);
    }

    const resp = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const raw = (resp ?? {}) as unknown as Record<string, unknown>;
    if (raw.error) {
      throw new LiveTradingError("Polymarket balance endpoint returned an error: " + String(raw.error));
    }

    const clobBalance = normalizeCollateralAmount(raw.balance, "balance");

    if (clobBalance === 0 && funder) {
      if (!options.syncAllowance) {
        syncResult = await syncClobBalanceAllowance(client);
        const refreshed = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
        const refreshedRaw = (refreshed ?? {}) as unknown as Record<string, unknown>;
        if (refreshedRaw.error) {
          throw new LiveTradingError("Polymarket balance endpoint returned an error: " + String(refreshedRaw.error));
        }
        const refreshedBalance = normalizeCollateralAmount(refreshedRaw.balance, "balance");
        if (refreshedBalance > 0) {
          return {
            usdcBalance: refreshedBalance,
            usdcAllowance: normalizeOptionalCollateralAmount(refreshedRaw.allowance, "allowance"),
            raw: { balanceSource: "clob-after-sync", balanceSync: syncResult, balanceAllowance: refreshed },
            updatedAt: new Date().toISOString(),
          };
        }
      }

      return fetchPusdBalanceSnapshot(funder, {
        balanceSource: "clob-zero-fallback",
        balanceSync: syncResult,
        balanceAllowance: resp,
      });
    }

    return {
      usdcBalance: clobBalance,
      usdcAllowance: normalizeOptionalCollateralAmount(raw.allowance, "allowance"),
      raw: syncResult ? { balanceSource: "clob", balanceSync: syncResult, balanceAllowance: resp } : resp,
      updatedAt: new Date().toISOString(),
    };
  } catch (err) {
    if (err instanceof LiveTradingError) throw err;
    throw new LiveTradingError("Failed to fetch live USDC balance from Polymarket CLOB: " + errorMessage(err));
  }
}
/**
 * Best-effort: make sure the CLOB has a USDC (collateral) allowance. Proxy/safe
 * wallets are handled by Polymarket; an EOA may need a one-time on-chain
 * approval that this call cannot perform — failures are swallowed.
 */
export async function ensureUsdcAllowance(): Promise<void> {
  try {
    if (config.liveSignatureType === 3) {
      const client = await getLiveV2ClobClient();
      // AssetType string value is identical between v1 and v2 ("COLLATERAL").
      await (client as unknown as { updateBalanceAllowance: (p: { asset_type: string }) => Promise<void> })
        .updateBalanceAllowance({ asset_type: "COLLATERAL" });
    } else {
      const client = await getLiveClobClient();
      await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    }
  } catch {
    // ignore — surfaced elsewhere if an order later fails on allowance
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
 * Fetch authoritative trade fills for the trading account from the CLOB. This is
 * the source of truth for reconciling local live-order estimates against what
 * actually filled on-chain.
 *
 * Walks pages (up to config.liveReconcileMaxPages) when the client returns a
 * cursor-paginated shape, so older fills are not missed. Throws on network errors
 * OR on an unexpected payload shape — callers turn that into a reconciliation
 * error that blocks new BUYs. It never silently returns [] on a shape change.
 */
export async function fetchLiveTrades(): Promise<LiveTradeFill[]> {
  assertLiveTradingAllowed();
  const rawClient = config.liveSignatureType === 3
    ? await getLiveV2ClobClient()
    : await getLiveClobClient();
  const getTrades = (rawClient as unknown as { getTrades: (...args: unknown[]) => Promise<unknown> }).getTrades;
  if (typeof getTrades !== "function") {
    throw new LiveTradingError("Polymarket CLOB client does not expose getTrades(); cannot reconcile fills.");
  }
  const client = rawClient;

  const out: LiveTradeFill[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  const maxPages = Math.max(1, config.liveReconcileMaxPages);

  for (let page = 0; page < maxPages; page += 1) {
    let resp: unknown;
    try {
      resp = cursor ? await getTrades.call(client, undefined, false, cursor) : await getTrades.call(client);
    } catch (err) {
      throw new LiveTradingError("Failed to fetch live trade history from Polymarket CLOB: " + errorMessage(err));
    }

    const { rows, nextCursor } = extractTradePage(resp);
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

export interface LiveMarketOrderParams {
  tokenId: string;
  side: "BUY" | "SELL";
  /** USDC to spend — required for BUY. */
  usdAmount?: number;
  /** Shares to sell — required for SELL. */
  shares?: number;
  /** Best ask (BUY) / best bid (SELL); used for mirror accounting, not as a limit. */
  referencePrice: number;
}

/**
 * Place a marketable FAK order and return a normalized result. Throws only on
 * a hard failure (bad config, network); a rejected order returns success:false.
 */
export async function placeLiveMarketOrder(params: LiveMarketOrderParams): Promise<LiveOrderResult> {
  assertLiveTradingAllowed();

  const side = params.side === "BUY" ? Side.BUY : Side.SELL;
  const amount = params.side === "BUY" ? params.usdAmount ?? 0 : params.shares ?? 0;
  if (!(amount > 0)) {
    throw new LiveTradingError(`Live ${params.side} amount must be positive (got ${amount}).`);
  }

  // We compute the marketable price ourselves and clamp it into the market's
  // valid [tick, 1-tick] band before posting. Left to the library, deep books
  // near 0/1 (a best bid of 0.999 with a reported 0.01 tick) make it derive a
  // price its own validator then rejects ("invalid price (0.999)…"), which would
  // strand a position the leader has already exited. A clamped SELL limit still
  // crosses (a 0.99 limit fills against a 0.999 bid); FAK kills any remainder.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client: any =
    config.liveSignatureType === 3 ? await getLiveV2ClobClient() : await getLiveClobClient();

  let tick = 0.01;
  try {
    tick = Number.parseFloat(await client.getTickSize(params.tokenId)) || 0.01;
  } catch {
    // Fall back to a conservative 0.01 tick; the clamp below still applies.
  }

  let marketPrice: number | undefined;
  try {
    marketPrice = await client.calculateMarketPrice(params.tokenId, side, amount, OrderType.FAK);
  } catch {
    // No book / no match — let the library try (and surface its own error).
    marketPrice = undefined;
  }
  if (marketPrice != null && Number.isFinite(marketPrice)) {
    const lo = tick;
    const hi = 1 - tick;
    marketPrice = Math.round(marketPrice / tick) * tick;
    marketPrice = Math.min(hi, Math.max(lo, marketPrice));
  } else {
    marketPrice = undefined;
  }

  // Side and OrderType string values ("BUY"/"SELL", "FAK") are identical in v1 and v2.
  const order = {
    tokenID: params.tokenId,
    amount,
    side,
    orderType: OrderType.FAK,
    ...(marketPrice != null ? { price: marketPrice } : {}),
  };
  const options = { tickSize: String(tick) };
  const resp: unknown = await client.createAndPostMarketOrder(order, options, OrderType.FAK);

  const r = (resp ?? {}) as Record<string, unknown>;
  const orderIdRaw = r.orderID ?? r.orderId ?? null;
  const orderId = orderIdRaw ? String(orderIdRaw) : null;
  const status = r.status != null ? String(r.status) : null;
  // v1 uses errorMsg; v2 client returns { error: string, status: number } on rejection
  const errorMsg = r.errorMsg ? String(r.errorMsg) : r.error ? String(r.error) : null;
  const success = r.success === true || (r.success == null && orderId != null && !errorMsg);
  const rawHashes = (r.transactionsHashes ?? r.transactionHashes) as unknown;
  const txHashes = Array.isArray(rawHashes) ? rawHashes.map(String) : [];

  // Mirror estimate from the reference quote (see file header).
  const price = params.referencePrice > 0 ? params.referencePrice : 0;
  const filledShares =
    params.side === "BUY" ? (price > 0 ? (params.usdAmount ?? 0) / price : 0) : params.shares ?? 0;
  const notionalUsd = params.side === "BUY" ? params.usdAmount ?? 0 : filledShares * price;

  return {
    success,
    orderId,
    status,
    filledShares,
    effectivePrice: price,
    notionalUsd,
    txHashes,
    raw: resp,
    error: success ? null : errorMsg ?? "Order was not accepted by the CLOB.",
  };
}
