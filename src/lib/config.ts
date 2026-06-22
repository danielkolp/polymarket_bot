/**
 * Centralized configuration. Server-only values are read from process.env here
 * so the rest of the codebase never reaches into process.env directly.
 *
 * NOTE: This module is imported by server code (API routes / lib). Do not import
 * it into client components — use the values returned by API routes instead.
 */

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Like num(), but allows zero (for thresholds where 0 is meaningful). */
function numNonNeg(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function bool(value: string | undefined, fallback = false): boolean {
  if (value == null) return fallback;
  return value.trim().toLowerCase() === "true";
}

export const config = {
  appName: process.env.NEXT_PUBLIC_APP_NAME ?? "Bonk",

  gammaUrl: (process.env.POLYMARKET_GAMMA_URL ?? "https://gamma-api.polymarket.com").replace(/\/+$/, ""),
  clobUrl: (process.env.POLYMARKET_CLOB_URL ?? "https://clob.polymarket.com").replace(/\/+$/, ""),
  lbApiUrl: (process.env.POLYMARKET_LB_URL ?? "https://lb-api.polymarket.com").replace(/\/+$/, ""),
  dataApiUrl: (process.env.POLYMARKET_DATA_URL ?? "https://data-api.polymarket.com").replace(/\/+$/, ""),

  requestTimeoutMs: num(process.env.POLY_REQUEST_TIMEOUT_MS, 8000),

  /**
   * Master switch for real-money trading. Defaults to FALSE. When false, no real
   * order can be placed regardless of any other setting. This flag exists so the
   * live path is explicit and impossible to flip by accident.
   */
  enableRealTrading: bool(process.env.ENABLE_REAL_TRADING, false),

  /**
   * Live execution config (Polymarket CLOB). Only read when enableRealTrading is
   * true. SERVER-ONLY — never expose the private key to the client.
   */
  // EIP-712 signing key for the trading wallet. ethers v5 wallet.
  livePrivateKey: process.env.POLYMARKET_PRIVATE_KEY ?? "",
  // Address that actually holds the USDC. For an EOA leave blank (defaults to the
  // signer). For a Polymarket proxy/email wallet or Gnosis safe, set the proxy
  // address here and the matching signature type below.
  liveFunderAddress: process.env.POLYMARKET_FUNDER_ADDRESS ?? "",
  // 0 = EOA, 1 = Polymarket proxy wallet, 2 = Polymarket Gnosis safe.
  liveSignatureType: ((): 0 | 1 | 2 => {
    const n = Number(process.env.POLYMARKET_SIGNATURE_TYPE);
    return n === 1 || n === 2 ? n : 0;
  })(),
  // Polygon mainnet = 137, Amoy testnet = 80002.
  liveChainId: num(process.env.POLYMARKET_CHAIN_ID, 137),
  // Hard per-order USD backstop. Every live BUY is clamped to this regardless of
  // the percentage sizing / exposure caps. Start tiny; raise deliberately.
  liveMaxOrderUsd: num(process.env.LIVE_MAX_ORDER_USD, 5),

  /**
   * On-chain redemption of resolved (won) positions. Redeeming is NOT part of the
   * CLOB API — it is a direct ConditionalTokens contract call — so it needs a
   * Polygon JSON-RPC endpoint. Detection/manual redeem works without these (and is
   * the default); fully-automatic redeem additionally requires enableAutoRedeem.
   */
  // Polygon JSON-RPC URL used ONLY to submit redeemPositions transactions.
  liveRpcUrl: process.env.POLYMARKET_RPC_URL ?? "",
  /**
   * Master switch for FULLY-AUTOMATIC redemption on each real-mode poll. Defaults
   * to FALSE. When false, resolved winnings are detected and surfaced but only
   * redeemed via an explicit, confirmed operator action. Requires enableRealTrading.
   */
  enableAutoRedeem: bool(process.env.ENABLE_AUTO_REDEEM, false),
  // Warn when locally tracked equity and authoritative live USDC diverge by more
  // than this amount. This does not mutate local PnL/accounting history.
  liveBalanceWarningThresholdUsd: num(process.env.LIVE_BALANCE_WARNING_THRESHOLD_USD, 5),

  // When true (default), a persisted panic stop is NOT cleared automatically on
  // restart — the operator must explicitly resume. This prevents a crash/restart
  // from silently re-enabling live trading after an emergency stop.
  liveRequireManualResumeAfterPanic: bool(process.env.LIVE_REQUIRE_MANUAL_RESUME_AFTER_PANIC, true),

  // Block placing new live orders once this many previously-placed live orders
  // remain unreconciled against authoritative CLOB fills. Keeps the local ledger
  // from drifting from on-chain truth. 0 disables the guard.
  liveMaxUnreconciledOrders: numNonNeg(process.env.LIVE_MAX_UNRECONCILED_ORDERS, 5),

  // A real BUY still `pending` reconciliation after this many seconds blocks new
  // BUYs — we will not pile on orders while a prior fill is unconfirmed.
  livePendingStaleSeconds: num(process.env.LIVE_PENDING_STALE_SECONDS, 60),

  // Allow heuristic (non-order-id) reconciliation matching. OFF by default: in
  // real-money mode only exact order-id matches are trusted; everything else is
  // surfaced as unmatched for manual review rather than guessed.
  liveAllowFuzzyReconcile: bool(process.env.LIVE_ALLOW_FUZZY_RECONCILE, false),

  // How many pages of CLOB trade history to walk when reconciling (safety cap).
  liveReconcileMaxPages: num(process.env.LIVE_RECONCILE_MAX_PAGES, 10),

  // Treat the live-position snapshot as stale (and block BUYs) once it is older
  // than this many seconds.
  livePositionsStaleSeconds: num(process.env.LIVE_POSITIONS_STALE_SECONDS, 120),

  // Optional shared secret protecting every MUTATING API route (start/stop/reset/
  // settings/traders/panic/...). When set, requests must present it via the
  // `x-dashboard-token` header or `dashboard_token` cookie. Leave blank only for
  // trusted localhost dev. Same-origin (CSRF) checks apply regardless.
  dashboardAuthToken: process.env.DASHBOARD_AUTH_TOKEN ?? "",
} as const;

export type AppConfig = typeof config;
