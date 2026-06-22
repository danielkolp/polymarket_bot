/** Simulation domain types. */

export type OrderSide = "buy" | "sell";
export type OrderStatus = "open" | "partial" | "filled" | "cancelled";

export interface OrderIntent {
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  outcomeLabel: string;
  side: OrderSide;
  price: number; // 0..1
  size: number; // shares
  postOnly: boolean;
}

export interface SimOrder extends OrderIntent {
  id: string;
  status: OrderStatus;
  filledSize: number;
  createdAt: number;
  updatedAt: number;
}

export interface SimPosition {
  marketId: string;
  marketQuestion: string;
  tokenId: string;
  outcomeLabel: string;
  shares: number; // net long shares of this outcome token
  avgPrice: number; // average entry price (0..1)
  realizedPnl: number; // lifetime realized pnl for this position
  markPrice: number; // latest mark (mid) price
  updatedAt: number;
}

export type TradeType = "place" | "fill" | "cancel" | "flatten" | "risk" | "info";

export interface TradeLogEntry {
  id: string;
  ts: number;
  type: TradeType;
  side?: OrderSide;
  marketId?: string;
  marketQuestion?: string;
  outcomeLabel?: string;
  price?: number;
  size?: number;
  pnl?: number;
  message: string;
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface RiskSettings {
  startingBalance: number;

  // Risk controls
  maxExposurePerMarket: number; // $ notional per market
  maxTotalExposure: number; // $ notional across all markets
  maxDailyLoss: number; // $ loss threshold (positive number)
  minLiquidity: number; // $ minimum market liquidity to trade
  minSpread: number; // minimum fractional spread to consider eligible
  staleDataTimeoutSec: number; // skip markets whose book is older than this
  noTradeWindowMinutes: number; // flatten + stop trading this close to resolution

  // Strategy parameters
  orderSize: number; // $ notional per quote
  maxOpenOrders: number; // cap on resting orders
  staleOrderTimeoutSec: number; // cancel resting orders older than this
  edgeOffset: number; // how far inside best bid/ask to quote (fractional, e.g. 0.005)
  takeProfitOffset: number; // resting maker exit this far above avg entry (fractional)
  fillRatio: number; // 0..1 portion of available size captured per fill

  // Active position management (taker exits at mid). 0 disables.
  takeProfitPct: number; // exit a winner once up this fraction (e.g. 0.08 = +8%)
  stopLossPct: number; // exit a loser once down this fraction (e.g. 0.10 = -10%)
  feeBps: number; // trading fee in basis points applied to every fill

  // "Buy low" entry gate — the core buy-low/sell-high edge.
  dipLookback: number; // ticks of recent price history used as the reference
  buyDipThreshold: number; // only buy when mid <= recentAvg*(1+this); 0 = at/below avg

  // Copy-trading
  strategyMode: "spread" | "copy"; // which strategy the engine runs
  copyPerTradeUsd: number; // paper $ notional mirrored per trader trade
  copyMaxLeaders: number; // auto-follow the top N leaderboard traders
  copyLeaderMetric: "profit" | "volume";
  copyLeaderWindow: "1d" | "7d" | "all";
  copySlippageBps: number; // adverse slippage modeling our lateness vs the trader
  copyRecencyMinutes: number; // ignore trader trades older than this when first seen

  tickIntervalSec: number; // engine tick cadence
}

export interface SimMetrics {
  cash: number;
  equity: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalExposure: number;
  roi: number; // fractional
  wins: number;
  losses: number;
  winRate: number; // fractional
  peakEquity: number;
  maxDrawdown: number; // fractional
  dailyPnl: number;
  dailyStartEquity: number;
  dailyDate: string; // yyyy-mm-dd
}

export interface SimSnapshot {
  running: boolean;
  haltedReason: string | null;
  strategyEnabled: boolean;
  settings: RiskSettings;
  orders: SimOrder[];
  positions: SimPosition[];
  trades: TradeLogEntry[];
  equityCurve: EquityPoint[];
  metrics: SimMetrics;
  watchTokenIds: string[];
  /** Rolling recent mid prices per tracked token (oldest → newest). */
  priceHistory: Record<string, number[]>;
  /** Copy-trading: wallets we mirror. */
  followedWallets: string[];
  /** Copy-trading: latest mirrored trade timestamp (sec) per wallet. */
  lastCopiedTs: Record<string, number>;
  lastTickAt: number | null;
  createdAt: number;
}
