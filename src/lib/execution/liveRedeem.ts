/**
 * ⚠️  LIVE ON-CHAIN REDEMPTION — REAL MONEY.  ⚠️
 *
 * Redeeming a resolved position claims its USDC payout from Polymarket's
 * ConditionalTokens (CTF) contract. This is NOT part of @polymarket/clob-client
 * (which only does order placement / balance / trade history) — it is a direct
 * contract call — so it is implemented here with the already-vendored `ethers`
 * v5 and Polymarket's official Polygon contract addresses. No new dependency and
 * no third-party redemption library is introduced.
 *
 * GATING (same posture as the rest of the live path — see liveClob.ts):
 *   1. config.enableRealTrading must be true, AND
 *   2. POLYMARKET_PRIVATE_KEY must be set, AND
 *   3. POLYMARKET_RPC_URL must be set (a Polygon JSON-RPC endpoint to submit txs).
 * Fully-automatic redemption additionally requires config.enableAutoRedeem.
 *
 * SCOPE (deliberately conservative — this code moves real funds and cannot be
 * exercised here): only EOA accounts (signatureType 0) on Polygon (137) are
 * redeemed directly. Proxy / Gnosis-safe wallets and neg-risk markets are
 * DETECTED and surfaced for MANUAL redemption rather than risking a malformed
 * fund-moving transaction. See `redeemBlockedReason`.
 *
 * SERVER-ONLY. Never import this into a client component.
 */
import { Wallet, Contract, providers } from "ethers";
import { config } from "@/lib/config";
import { LiveTradingError } from "./liveClob";

/** Polygon mainnet. The hardcoded contract addresses below are Polygon-only. */
const POLYGON_CHAIN_ID = 137;

/** Polymarket's ConditionalTokens (Gnosis CTF) framework on Polygon. */
const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
/** USDC.e — the collateral token all Polymarket markets settle in. */
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
/** 32 zero bytes — the root (parent) collection id for a top-level condition. */
const PARENT_COLLECTION_ID = "0x0000000000000000000000000000000000000000000000000000000000000000";
/** Binary market index sets: redeeming both slots pays out whichever side won. */
const BINARY_INDEX_SETS = [1, 2];

const CTF_ABI = [
  "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
];

export interface RedeemTxResult {
  success: boolean;
  txHash: string | null;
  error: string | null;
}

/** True when on-chain redemption is enabled AND minimally configured. */
export function isLiveRedeemConfigured(): boolean {
  return (
    config.enableRealTrading &&
    config.livePrivateKey.trim().length > 0 &&
    config.liveRpcUrl.trim().length > 0
  );
}

/**
 * Throw unless real trading is enabled AND a signing key AND a Polygon RPC URL
 * are configured. Call before any redeem attempt so a misconfiguration fails
 * loudly instead of silently no-op'ing.
 */
export function assertLiveRedeemAllowed(): void {
  if (!config.enableRealTrading) {
    throw new LiveTradingError("ENABLE_REAL_TRADING is false. Refusing to redeem on-chain.");
  }
  if (!config.livePrivateKey.trim()) {
    throw new LiveTradingError("POLYMARKET_PRIVATE_KEY is not set. Cannot sign a redeem transaction.");
  }
  if (!config.liveRpcUrl.trim()) {
    throw new LiveTradingError("POLYMARKET_RPC_URL is not set. Cannot submit a redeem transaction.");
  }
}

/**
 * Return a human-readable reason this position CANNOT be auto-redeemed by the
 * bot, or null when it can. Pure — does not touch the network. Used both to label
 * the dashboard plan and to guard the redeem path. Conservative on purpose: any
 * case we cannot perform safely and verifiably is deferred to manual redemption.
 */
export function redeemBlockedReason(opts: { negativeRisk: boolean }): string | null {
  if (config.liveChainId !== POLYGON_CHAIN_ID) {
    return `On-chain redeem only supports Polygon (137); configured chain is ${config.liveChainId}.`;
  }
  if (config.liveSignatureType !== 0) {
    return "Proxy / Gnosis-safe wallet (signatureType " + config.liveSignatureType + "): redeem on Polymarket manually.";
  }
  if (opts.negativeRisk) {
    return "Neg-risk market: redeem on Polymarket manually (NegRiskAdapter routing not enabled).";
  }
  return null;
}

let cachedProvider: providers.JsonRpcProvider | null = null;
function getProvider(): providers.JsonRpcProvider {
  if (!cachedProvider) {
    cachedProvider = new providers.JsonRpcProvider(config.liveRpcUrl.trim(), config.liveChainId);
  }
  return cachedProvider;
}

/** Drop the cached provider (e.g. after changing the RPC URL). */
export function resetRedeemProvider(): void {
  cachedProvider = null;
}

/**
 * Submit a `redeemPositions` transaction for one resolved binary condition and
 * wait for one confirmation. Returns success + tx hash, or success:false with the
 * error message — it never throws for an on-chain revert, so a caller looping
 * over many positions can continue past a single failure.
 *
 * Caller MUST have already checked `redeemBlockedReason` returns null; this
 * function re-asserts the hard gates but assumes EOA + non-neg-risk.
 */
export async function redeemConditionOnChain(conditionId: string): Promise<RedeemTxResult> {
  try {
    assertLiveRedeemAllowed();
    const blocked = redeemBlockedReason({ negativeRisk: false });
    if (blocked) return { success: false, txHash: null, error: blocked };
    if (!/^0x[0-9a-fA-F]{64}$/.test(conditionId)) {
      return { success: false, txHash: null, error: `Invalid conditionId for redeem: ${conditionId}` };
    }

    const wallet = new Wallet(config.livePrivateKey.trim(), getProvider());
    const ctf = new Contract(CTF_ADDRESS, CTF_ABI, wallet);
    const tx = await ctf.redeemPositions(USDC_ADDRESS, PARENT_COLLECTION_ID, conditionId, BINARY_INDEX_SETS);
    const receipt = await tx.wait(1);
    const ok = receipt?.status === 1;
    return {
      success: ok,
      txHash: receipt?.transactionHash ?? tx.hash ?? null,
      error: ok ? null : "Redeem transaction reverted on-chain.",
    };
  } catch (err) {
    return {
      success: false,
      txHash: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
