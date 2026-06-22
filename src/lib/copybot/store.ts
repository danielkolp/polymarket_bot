import { promises as fs } from "fs";
import path from "path";
import { DEFAULT_BOT_SETTINGS, createInitialBotState } from "./defaults";
import { applyRiskPreset } from "./riskPresets";
import type {
  BotLogEntry,
  BotPosition,
  BotSettings,
  BotState,
  CopyTradeRecord,
  EquityPoint,
  FollowedTrader,
  LivePositionReconciliation,
  RedeemBook,
  RedeemedEntry,
  SeenTradeBook,
} from "./types";

const DATA_DIR = path.join(process.cwd(), "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");
const TRADERS_FILE = path.join(DATA_DIR, "traders.json");
const SEEN_FILE = path.join(DATA_DIR, "seen-trades.json");
const TRADES_FILE = path.join(DATA_DIR, "trades.json");
const POSITIONS_FILE = path.join(DATA_DIR, "positions.json");
const EQUITY_FILE = path.join(DATA_DIR, "equity-curve.json");
const ERRORS_FILE = path.join(DATA_DIR, "errors.log");
const STATE_FILE = path.join(DATA_DIR, "bot-state.json");
const LIVE_POSITIONS_FILE = path.join(DATA_DIR, "live-positions.json");
const REDEEMED_FILE = path.join(DATA_DIR, "redeemed.json");

const MAX_TRADES = 1000;
const MAX_LOGS = 500;
const MAX_EQUITY_POINTS = 1500;
let writeChain = Promise.resolve();

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeSettings(value: Partial<BotSettings> | null | undefined): BotSettings {
  // Re-apply the active risk preset on every merge so stale persisted JSON that
  // kept old numeric fields under a non-custom preset label is corrected at load
  // (and re-save) time. Custom settings pass through untouched.
  return applyRiskPreset({ ...DEFAULT_BOT_SETTINGS, ...(value ?? {}) });
}

function initialEquityCurve(settings: BotSettings, now = Date.now()): EquityPoint[] {
  return [{ ts: now, equityUsd: settings.startingBalance, cashUsd: settings.startingBalance, exposureUsd: 0 }];
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw err;
    await writeJson(file, fallback);
    return clone(fallback);
  }
}

async function writeJson<T>(file: string, value: T): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function ensureDataFiles(): Promise<void> {
  const settings = await loadSettings();
  await Promise.all([
    loadTraders(),
    loadSeenTrades(),
    loadTrades(),
    loadPositions(),
    loadEquityCurve(settings),
    loadBotState(settings),
    ensureErrorLog(),
  ]);
}

export async function loadSettings(): Promise<BotSettings> {
  const settings = await readJson<Partial<BotSettings>>(SETTINGS_FILE, DEFAULT_BOT_SETTINGS);
  const merged = mergeSettings(settings);
  if (JSON.stringify(settings) !== JSON.stringify(merged)) {
    await saveSettings(merged);
  }
  return merged;
}

export async function saveSettings(settings: BotSettings): Promise<void> {
  await enqueueWrite(() => writeJson(SETTINGS_FILE, mergeSettings(settings)));
}

export async function loadTraders(): Promise<FollowedTrader[]> {
  return readJson<FollowedTrader[]>(TRADERS_FILE, []);
}

export async function saveTraders(traders: FollowedTrader[]): Promise<void> {
  const normalized = traders
    .map((t) => ({ ...t, wallet: t.wallet.toLowerCase() }))
    .sort((a, b) => Number(b.enabled) - Number(a.enabled) || (a.rank ?? 9999) - (b.rank ?? 9999));
  await enqueueWrite(() => writeJson(TRADERS_FILE, normalized));
}

export async function loadSeenTrades(): Promise<SeenTradeBook> {
  const book = await readJson<SeenTradeBook>(SEEN_FILE, { ids: [] });
  return { ids: [...new Set(book.ids)] };
}

export async function saveSeenTrades(book: SeenTradeBook): Promise<void> {
  await enqueueWrite(() => writeJson(SEEN_FILE, { ids: [...new Set(book.ids)].slice(-10000) }));
}

export async function loadTrades(): Promise<CopyTradeRecord[]> {
  return readJson<CopyTradeRecord[]>(TRADES_FILE, []);
}

export async function saveTrades(trades: CopyTradeRecord[]): Promise<void> {
  await enqueueWrite(() => writeJson(TRADES_FILE, trades.slice(0, MAX_TRADES)));
}

export async function prependTrade(record: CopyTradeRecord): Promise<void> {
  const trades = await loadTrades();
  await saveTrades([record, ...trades]);
}

export async function loadPositions(): Promise<BotPosition[]> {
  return readJson<BotPosition[]>(POSITIONS_FILE, []);
}

export async function savePositions(positions: BotPosition[]): Promise<void> {
  const open = positions.filter((p) => p.shares > 0.000001);
  await enqueueWrite(() => writeJson(POSITIONS_FILE, open));
}

export async function loadEquityCurve(settings?: BotSettings): Promise<EquityPoint[]> {
  const s = settings ?? (await loadSettings());
  return readJson<EquityPoint[]>(EQUITY_FILE, initialEquityCurve(s));
}

export async function saveEquityCurve(points: EquityPoint[]): Promise<void> {
  await enqueueWrite(() => writeJson(EQUITY_FILE, points.slice(-MAX_EQUITY_POINTS)));
}

export async function appendEquityPoint(point: EquityPoint): Promise<void> {
  const points = await loadEquityCurve();
  const last = points[points.length - 1];
  const shouldReplace = last && point.ts - last.ts < 5000;
  const next = shouldReplace ? [...points.slice(0, -1), point] : [...points, point];
  await saveEquityCurve(next);
}

export async function loadBotState(settings?: BotSettings): Promise<BotState> {
  const s = settings ?? (await loadSettings());
  const state = await readJson<Partial<BotState>>(STATE_FILE, createInitialBotState(s.startingBalance));
  return { ...createInitialBotState(s.startingBalance), ...state };
}

export async function saveBotState(state: BotState): Promise<void> {
  await enqueueWrite(() => writeJson(STATE_FILE, state));
}

/** Latest authoritative live-position reconciliation snapshot (real mode). */
export async function loadLivePositions(): Promise<LivePositionReconciliation | null> {
  return readJson<LivePositionReconciliation | null>(LIVE_POSITIONS_FILE, null);
}

export async function saveLivePositions(snapshot: LivePositionReconciliation | null): Promise<void> {
  await enqueueWrite(() => writeJson(LIVE_POSITIONS_FILE, snapshot));
}

/**
 * Persisted ledger of positions already redeemed on-chain — the double-redeem
 * guard. Survives trade-list truncation, so a redeemed condition is never
 * redeemed twice even after its copy record ages out of trades.json.
 */
export async function loadRedeemBook(): Promise<RedeemBook> {
  const book = await readJson<RedeemBook>(REDEEMED_FILE, { entries: [] });
  return { entries: Array.isArray(book.entries) ? book.entries : [] };
}

export async function saveRedeemBook(book: RedeemBook): Promise<void> {
  await enqueueWrite(() => writeJson(REDEEMED_FILE, { entries: book.entries.slice(-5000) }));
}

/** Append a redeemed entry, de-duplicating by tokenId (idempotent). */
export async function recordRedeemed(entry: RedeemedEntry): Promise<void> {
  const book = await loadRedeemBook();
  if (book.entries.some((e) => e.tokenId === entry.tokenId)) return;
  await saveRedeemBook({ entries: [...book.entries, entry] });
}

export async function ensureErrorLog(): Promise<void> {
  await ensureDataDir();
  try {
    await fs.access(ERRORS_FILE);
  } catch {
    await fs.writeFile(ERRORS_FILE, "", "utf8");
  }
}

export async function clearLogs(): Promise<void> {
  await ensureDataDir();
  await enqueueWrite(() => fs.writeFile(ERRORS_FILE, "", "utf8"));
}

export async function appendLog(level: BotLogEntry["level"], message: string): Promise<BotLogEntry> {
  await ensureErrorLog();
  const entry: BotLogEntry = {
    id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    level,
    message,
  };
  const line = JSON.stringify(entry);
  await fs.appendFile(ERRORS_FILE, `${line}\n`, "utf8");
  return entry;
}

export async function loadLogs(limit = MAX_LOGS): Promise<BotLogEntry[]> {
  await ensureErrorLog();
  const raw = await fs.readFile(ERRORS_FILE, "utf8");
  const entries = raw
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as BotLogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is BotLogEntry => entry !== null)
    .reverse();
  return entries.slice(0, limit);
}

