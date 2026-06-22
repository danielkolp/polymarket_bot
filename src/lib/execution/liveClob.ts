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
import { config } from "@/lib/config";

export class LiveTradingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveTradingError";
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
  assertLiveTradingAllowed();
  const host = config.clobUrl;
  const chainId = config.liveChainId;
  const signatureType = config.liveSignatureType;
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

/**
 * Fetch the authoritative USDC collateral balance/allowance from the live CLOB.
 * Values are normalized from collateral base units (6 decimals) into USD.
 */
export async function fetchLiveUsdcBalance(): Promise<LiveUsdcBalance> {
  assertLiveTradingAllowed();

  try {
    const client = await getLiveClobClient();
    const resp = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    const raw = (resp ?? {}) as unknown as Record<string, unknown>;
    if (raw.error) {
      throw new LiveTradingError("Polymarket balance endpoint returned an error: " + String(raw.error));
    }

    return {
      usdcBalance: normalizeCollateralAmount(raw.balance, "balance"),
      usdcAllowance: normalizeOptionalCollateralAmount(raw.allowance, "allowance"),
      raw: resp,
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
  const client = await getLiveClobClient();
  try {
    await client.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
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
 * Fetch recent authoritative trade fills for the trading account from the CLOB.
 * This is the source of truth for reconciling local live-order estimates against
 * what actually filled on-chain. Returns [] on a soft failure.
 */
export async function fetchLiveTrades(): Promise<LiveTradeFill[]> {
  assertLiveTradingAllowed();
  const client = await getLiveClobClient();
  let resp: unknown;
  try {
    // The clob-client exposes getTrades() for the authenticated account.
    resp = await (client as unknown as { getTrades: (...args: unknown[]) => Promise<unknown> }).getTrades();
  } catch (err) {
    throw new LiveTradingError("Failed to fetch live trade history from Polymarket CLOB: " + errorMessage(err));
  }

  // The client may return an array directly or a paginated { data: [...] } shape.
  const list = Array.isArray(resp)
    ? resp
    : Array.isArray((resp as { data?: unknown[] } | null)?.data)
      ? (resp as { data: unknown[] }).data
      : [];

  const out: LiveTradeFill[] = [];
  for (const item of list) {
    if (item && typeof item === "object") {
      const fill = normalizeLiveTrade(item as Record<string, unknown>);
      if (fill && fill.shares > 0 && fill.price > 0) out.push(fill);
    }
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
  const client = await getLiveClobClient();

  const side = params.side === "BUY" ? Side.BUY : Side.SELL;
  const amount = params.side === "BUY" ? params.usdAmount ?? 0 : params.shares ?? 0;
  if (!(amount > 0)) {
    throw new LiveTradingError(`Live ${params.side} amount must be positive (got ${amount}).`);
  }

  // Let the client resolve tick size, neg-risk, and the marketable price from the
  // live book (options omitted). FAK allows partial fills instead of rejecting.
  const resp = await client.createAndPostMarketOrder(
    { tokenID: params.tokenId, amount, side, orderType: OrderType.FAK },
    undefined,
    OrderType.FAK,
  );

  const r = (resp ?? {}) as Record<string, unknown>;
  const orderIdRaw = r.orderID ?? r.orderId ?? null;
  const orderId = orderIdRaw ? String(orderIdRaw) : null;
  const status = r.status != null ? String(r.status) : null;
  const errorMsg = r.errorMsg ? String(r.errorMsg) : null;
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
