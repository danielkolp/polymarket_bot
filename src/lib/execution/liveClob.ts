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
