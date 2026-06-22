# Polymarket Copy Bot

Private local Next.js dashboard/bot for discovering active Polymarket traders, tracking their recent trades, simulating copy trades, and keeping real-money execution disabled unless explicitly enabled server-side.

Simulation mode is the default. No private keys are used by the frontend and no secrets are stored in localStorage. Real-money execution is implemented against the Polymarket CLOB but stays **off unless explicitly enabled server-side** (`ENABLE_REAL_TRADING=true` plus a configured signing key).

## What it does

- Discovers active weekly Polymarket traders from the public leaderboard and trade APIs.
- Ranks traders using recent leaderboard PnL, weekly volume, trade count, and simulated copied-trade PnL.
- Lets you manually add/remove and enable/disable wallet addresses.
- Polls followed traders every 30 seconds by default.
- On start, marks existing recent trader trades as seen so old trades are not copied.
- Detects new trades and logs simulated, skipped, failed, and dry-run records.
- Simulates buys/sells with open positions, realized/unrealized PnL, ROI, win rate, drawdown, exposure, equity curve, and trade history.
- Fills copies against the live order book by default (spread, slippage, partial fills, fees) so simulated returns are net of realistic trading costs.
- Persists local bot state in JSON files under `data/`.
- Shows visual equity, exposure, risk-limit, sizing, poll-cycle, and trade-outcome panels.
- Keeps real trading behind `ENABLE_REAL_TRADING=true` and hard risk checks.
- Supports session-only runs: auto-liquidate copied positions on stop or window close, with a stop-time prompt to sell all, keep manually, or drain via auto-exit rules.
- Marks open positions to live Polymarket prices every poll (and on demand via **Update prices**), showing per-position up/down unrealized P&L.
- Lets you **Reset** the simulation back to a clean starting balance at any time.
- **Live Mode Portfolio Recovery**: before any future live session, reads the connected account's existing Polymarket positions, analyzes each (cost basis, live bid/ask/mid, liquidity, spread, time to resolution, price-history trend), classifies them, and recommends an action — without ever placing an order.

## Position sizing

Default sizing is percentage based:

- `sizingMode`: `percentage`
- `percentageCopySize`: `2`
- `$10` available balance -> `$0.20` calculated next buy
- `$100` available balance -> `$2.00` calculated next buy

Supported modes:

- `fixed`: use `fixedCopyAmountUsd`.
- `percentage`: use `percentageCopySize` percent of current available balance.
- `hybrid`: percentage sizing with `minTradeAmountUsd` and `maxTradeAmountUsd` caps.

Simulation does not force oversized trades. If the calculated buy amount is below `minTradeAmountUsd`, the trade is skipped and logged.

Simulation mode uses local/fake accounting: available balance is derived from `startingBalance`, copied trade records, realized P&L, and open simulated positions. Real mode does not use that simulated cash for order sizing. Before each live decision, the server reads the connected Polymarket CLOB collateral balance and sizes BUYs from actual USDC.

## Realistic execution costs

By default the simulator fills copies against the **live order book**, not at the followed trader's idealized price, so the equity curve reflects net-of-cost P&L:

- **Spread** — buys fill up the asks, sells down the bids (you pay the spread).
- **Slippage** — large orders walk the book; fills past `maxSlippageBps` from mid are excluded, producing **partial fills or rejects** instead of free liquidity.
- **Fees** — `takerFeeBps` of notional (Polymarket is ~0, so default `0`; configurable).
- **Fallback** — when no live book is available the model uses the best quote, then an assumed `fallbackSpreadBps` spread, and **labels** which (`book` / `quote` / `assumed`) so precision is never faked.

Settings: `realisticFills` (default `true`), `takerFeeBps` (0), `maxSlippageBps` (500 = 5%), `fallbackSpreadBps` (200 = 2%). Turn `realisticFills` off to compare against the old optimistic curve. Total spread/slippage + fees paid is surfaced as **Cost drag** on the dashboard — gross edge ≈ net P&L + cost drag. Each trade record carries its effective price, mid benchmark, fee, friction, and fill status.

Default risk caps:

- `maxExposurePerMarketPercent`: `10`
- `maxTotalExposurePercent`: `40`
- `maxDailyLossPercent`: `10`
- `minAvailableBalanceUsd`: `1`

## Risk presets and entry filters

Risk presets set the total and per-market exposure caps without changing realized P&L or existing positions:

- **Conservative**: 40% total exposure, 10% per market.
- **Balanced**: 60% total exposure, 15% per market.
- **Aggressive Simulation**: 80% total exposure, 20% per market.
- **Live Default**: 45% total exposure (inside the 40-50% live range), 10% per market.
- **Custom**: selected automatically when you manually edit either exposure cap.

Default BUY filters avoid markets where copied entries are usually noisy or hard to exit:

- Skip BUYs below `minBuyTokenPrice` (default 3c).
- Skip BUYs above `maxBuyTokenPrice` (default 97c).
- Skip BUYs when market spread exceeds `maxMarketSpread` (default 8c, when spread data is available).
- Skip BUYs when the market is inside `minTimeToResolutionMinutes` (default 60 minutes, when resolution timing is available).
- `minMarketLiquidityUsd` still applies separately.

In simulation mode, if total exposure is already at the configured cap, the bot enters an exposure-paused state for BUYs. It keeps observing followed traders and still processes SELLs, but it marks new BUYs as seen without creating repeated skipped-trade warnings. A single info log is written when BUY processing pauses, and another when exposure falls below the cap.

## Session-only mode & stopping

By default the simulated positions a run opens persist after you stop. **Session-only mode** (header toggle, also in Settings) treats them as ephemeral:

- Stopping the bot, or closing the dashboard tab/window, auto-liquidates every open position at its current mark price (a `sendBeacon` fires on window close).

Whenever you click **Stop** with positions still open, a prompt offers three paths instead of silently leaving them:

1. **Sell all now** — flatten every position at its refreshed mark price, realize the P&L, then stop. (Recommended; this is the default when the window is closed in session-only mode.)
2. **Keep positions manually** — stop listening but leave positions untouched.
3. **Set auto-exit rules** — enter `draining` (exit-only) mode: no new entries, but keep polling and auto-sell each position on take-profit %, stop-loss %, or max-hold minutes, then stop once flat.

Auto-exit defaults (`autoExitTakeProfitPercent`, `autoExitStopLossPercent`, `autoExitMaxHoldMinutes`) are `0` = disabled, and can be pre-set in Settings or entered in the stop prompt. Liquidations and auto-exits are recorded as simulated SELL trades (`session-close` / `auto-exit`), so equity, realized P&L, and the equity curve stay consistent.

## Live Mode Portfolio Recovery

Real-money trading is still disabled (`ENABLE_REAL_TRADING=false`), but the architecture is now **portfolio-aware** so a future live session never starts blind to what the account already holds (from a previous bot session, a manual buy, or another device).

Open **Portfolio Recovery** from the dashboard header (or visit `/recovery`):

1. **Connect / read wallet** — enter the account address. Read-only: no signing, no keys, no orders.
2. **Load existing positions** — pulls current positions from `data-api.polymarket.com/positions`.
3. **Analyze each position** — enriches with live book (bid/ask/mid/spread), Gamma liquidity/volume/status, time to resolution, and `prices-history` trend stats (change, volatility, recent high/low, momentum).
4. **Review recommended actions** — recommendations only; nothing executes.
5. **Choose how to resume** — simulate management, manual mode, or (future, gated) live mode.

Each position is classified as `healthy-hold`, `take-profit`, `reduce-exposure`, `exit-candidate`, `too-illiquid`, `near-resolution`, or `manual-review`, and gets a recommended action: `hold`, `sell-all`, `sell-partial`, `reduce-risk`, `wait-for-liquidity`, or `manual-review`.

**Cost basis** is taken from the API where available, otherwise **reconstructed** from trade history, otherwise marked **unknown** — precision is never faked. Safety rules raise flags rather than acting: never auto-sell illiquid positions, never assume an unknown basis, warn on wide spreads, near resolution, and positions that came from a previous bot session.

The analysis engine (`src/lib/recovery/analyze.ts`) is pure and decoupled from execution, so the same logic can back the simulated manager today and a real manager later. Snapshots are cached in `localStorage` per wallet. Real order placement is implemented in `src/lib/execution/liveClob.ts` (Polymarket CLOB) and gated behind `ENABLE_REAL_TRADING` plus a configured signing key — off by default.

## Local files

The server creates and maintains:

```text
data/settings.json
data/traders.json
data/seen-trades.json
data/trades.json
data/positions.json
data/equity-curve.json
data/errors.log
data/bot-state.json
```

`data/` is ignored by git because it is local runtime state.

## API endpoints

```text
GET  /api/bot/status
POST /api/bot/start
POST /api/bot/stop      # body { liquidate?: boolean } — liquidate flattens all open positions, then stops
POST /api/bot/drain     # body { autoExitTakeProfitPercent?, autoExitStopLossPercent?, autoExitMaxHoldMinutes? }
POST /api/bot/marks     # pull live Polymarket marks for open positions and recompute equity/P&L
POST /api/bot/reset     # wipe positions, trades, logs, equity curve, and state back to the starting balance
POST /api/bot/pause
GET  /api/trades
GET  /api/positions
GET  /api/traders
POST /api/traders/add
POST /api/traders/remove
POST /api/traders/toggle
GET  /api/settings
POST /api/settings
GET  /api/logs
GET  /api/portfolio/recover?wallet=0x...   # read-only: analyze an account's existing positions
```

## Run locally

Requirements: Node.js 18.18+; Node 20+ recommended.

```bash
npm install
cp .env.local.example .env.local
npm run dev
```

Open `http://localhost:3000` and use **Start** to begin the local bot loop.

### Background tabs

After you click **Start**, the bot loop runs in the Next.js server process, not in the active browser tab. Switching to another browser tab or backgrounding the dashboard should not stop polling; the dashboard refresh UI may throttle, but the server loop continues as long as the dev/server process is alive. Closing the dashboard tab/window only triggers auto-liquidation when **Session-only mode** is enabled.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_APP_NAME` | `Polymarket Copy Bot` | UI/app display name |
| `POLYMARKET_GAMMA_URL` | `https://gamma-api.polymarket.com` | Market metadata |
| `POLYMARKET_CLOB_URL` | `https://clob.polymarket.com` | CLOB/read-only tooling compatibility |
| `POLYMARKET_LB_URL` | `https://lb-api.polymarket.com` | Leaderboard discovery |
| `POLYMARKET_DATA_URL` | `https://data-api.polymarket.com` | Per-wallet trade history |
| `POLY_REQUEST_TIMEOUT_MS` | `8000` | Upstream timeout |
| `ENABLE_REAL_TRADING` | `false` | Master real-money guard |
| `POLYMARKET_PRIVATE_KEY` | _(empty)_ | Trading wallet signing key (server-only); required for live orders |
| `POLYMARKET_FUNDER_ADDRESS` | _(signer)_ | USDC-holding address for proxy/safe wallets; blank = plain EOA |
| `POLYMARKET_SIGNATURE_TYPE` | `0` | 0 = EOA, 1 = Polymarket proxy, 2 = Gnosis safe |
| `POLYMARKET_CHAIN_ID` | `137` | Polygon mainnet 137, Amoy testnet 80002 |
| `LIVE_MAX_ORDER_USD` | `5` | Hard per-order USD cap applied to every live BUY |
| `LIVE_BALANCE_WARNING_THRESHOLD_USD` | `5` | Warn when local tracked equity and live USDC differ by more than this amount |

## Real trading (Polymarket CLOB)

Real-money execution is implemented against the official `@polymarket/clob-client` (EIP-712-signed FAK market orders) and is gated, **off by default**. When real mode is enabled and configured, copy BUYs/SELLs and the automatic take-profit / stop-loss exits are placed live. See `src/lib/execution/liveClob.ts`.

> ⚠️ This trades **real USDC automatically** by copying other wallets. Treat the private key like cash, and test on a tiny `LIVE_MAX_ORDER_USD` first.

To enable, set in `.env.local`:

1. `ENABLE_REAL_TRADING=true` — the master guard.
2. `POLYMARKET_PRIVATE_KEY` — the trading wallet's key (server-only; never the frontend).
3. For a Polymarket proxy/email wallet or Gnosis safe, set `POLYMARKET_FUNDER_ADDRESS` and `POLYMARKET_SIGNATURE_TYPE` (1 or 2). A plain EOA can leave both at defaults.
4. Fund the wallet with USDC on Polygon and make sure the CLOB allowance is set (proxy/safe wallets are handled by Polymarket; an EOA may need a one-time approval).
5. `LIVE_MAX_ORDER_USD` caps every live BUY as a hard backstop on top of the sizing/exposure limits — start at `1`.

Then set the bot **mode to `real`** in Settings to switch the loop from simulation to live. All existing risk checks still run first: sizing mode, per-market and total exposure caps, daily-loss cap, minimum balance, stale-trade and duplicate prevention.

In real mode, every live BUY is sized from the lower of the configured strategy size, actual live USDC balance, `LIVE_MAX_ORDER_USD`, and remaining exposure capacity. If the live balance read fails, the bot records a failed trade decision and places no order. `LIVE_MAX_ORDER_USD` remains a hard per-buy cap even if the strategy and wallet balance are larger.

The dashboard shows live wallet USDC separately from local tracked equity. They can differ because local P&L/positions are an accounting mirror while wallet USDC is authoritative spendable collateral. Differences above `LIVE_BALANCE_WARNING_THRESHOLD_USD` are warnings only; the bot never rewrites local P&L history from the live balance.

**Auto-exit:** when `mode = real`, every poll sells any open position that has hit `autoExitTakeProfitPercent` (up %), `autoExitStopLossPercent` (down %), or `autoExitMaxHoldMinutes` — independent of whether the followed trader sold.

**Known limitation:** the local equity/positions view estimates fills from the reference quote at order time; the authoritative fills live on-chain and in the CLOB trade history. Reconciling local accounting against `getTrades()` remains a tracked follow-up.

The legacy `bullpen --help` probe still runs and is shown in the dashboard for reference, but is no longer used for execution.

## Notes

- This is for private local use.
- Keep private keys out of the frontend and out of localStorage.
- The bot loop is a singleton in the Next.js server process so dashboard refreshes do not create duplicate loops. Because the singleton is held on `globalThis` to survive HMR, **changes to the engine require a full `npm run dev` restart** (not just a hot reload) to take effect.
- Open-position marks come from Gamma `outcomePrices`. Markets that have already resolved/closed drop out of the lookup, so those positions keep their last mark until you liquidate them.
- Public Polymarket APIs can change; skipped/failed trades are logged and the loop continues.


#   p o l y m a r k e t _ b o t  
 