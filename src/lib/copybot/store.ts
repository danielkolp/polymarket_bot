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
const SKIPS_FILE = path.join(DATA_DIR, "skips.json");

/** Real copies/exits only (skips live in their own small ring). */
const MAX_TRADES = 2000;
/** Recent skipped-trade decisions kept for the dashboard. */
const MAX_SKIPS = 300;
const MAX_LOGS = 500;
const MAX_EQUITY_POINTS = 2000;
/** Equity points closer together than this replace the previous point. */
const EQUITY_POINT_SPACING_MS = 120_000;
/** errors.log is rotated to errors.log.1 once it grows past this. */
const MAX_LOG_BYTES = 1024 * 1024;
/** The dashboard only ever needs the newest log lines. */
const LOG_TAIL_BYTES = 96 * 1024;
const MAX_SEEN_IDS = 5000;
const JSON_READ_RETRY_DELAYS_MS = [20, 50, 100];
let writeChain = Promise.resolve();
const lastGoodJson = new Map<string, unknown>();

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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  await ensureDataDir();
  let lastError: unknown = null;

  for (let attempt = 0; attempt <= JSON_READ_RETRY_DELAYS_MS.length; attempt++) {
    try {
      const raw = await fs.readFile(file, "utf8");
      if (raw.trim().length === 0) throw new SyntaxError(`Empty JSON file: ${path.basename(file)}`);
      const parsed = JSON.parse(raw) as T;
      lastGoodJson.set(file, clone(parsed));
      return parsed;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        await writeJson(file, fallback);
        return clone(fallback);
      }
      if (!(err instanceof SyntaxError)) throw err;
      lastError = err;
      const delayMs = JSON_READ_RETRY_DELAYS_MS[attempt];
      if (delayMs != null) await wait(delayMs);
    }
  }

  const cached = lastGoodJson.get(file);
  if (cached !== undefined) return clone(cached) as T;
  if (process.env.NODE_ENV !== "test") {
    console.warn(
      `[copybot-store] ${path.basename(file)} contained unreadable JSON after retries; using fallback snapshot.`,
      lastError,
    );
  }
  return clone(fallback);
}

async function writeJson<T>(file: string, value: T): Promise<void> {
  await ensureDataDir();
  const tmpFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  try {
    // Compact JSON: these files are rewritten every poll on a small VPS disk.
    await fs.writeFile(tmpFile, `${JSON.stringify(value)}\n`, "utf8");
    try {
      await fs.rename(tmpFile, file);
    } catch (renameErr) {
      // Windows: rename fails with EPERM when something holds the destination open.
      // Fall back to copy-over so the write still lands atomically enough.
      const code = (renameErr as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY") {
        await fs.copyFile(tmpFile, file);
        await fs.unlink(tmpFile).catch(() => {});
      } else {
        throw renameErr;
      }
    }
    lastGoodJson.set(file, clone(value));
  } catch (err) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Best effort cleanup; preserve the original write failure.
    }
    throw err;
  }
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
  await enqueueWrite(() => writeJson(SEEN_FILE, { ids: [...new Set(book.ids)].slice(-MAX_SEEN_IDS) }));
}

/** Copy/exit ledger (never contains skipped decisions). */
export async function loadTrades(): Promise<CopyTradeRecord[]> {
  const trades = await readJson<CopyTradeRecord[]>(TRADES_FILE, []);
  return trades.filter((t) => t.status !== "skipped");
}

export async function saveTrades(trades: CopyTradeRecord[]): Promise<void> {
  const kept = trades.filter((t) => t.status !== "skipped").slice(0, MAX_TRADES);
  await enqueueWrite(() => writeJson(TRADES_FILE, kept));
}

/** Recent skipped decisions (newest first), kept apart so they never crowd out real trades. */
export async function loadSkips(): Promise<CopyTradeRecord[]> {
  return readJson<CopyTradeRecord[]>(SKIPS_FILE, []);
}

/**
 * Record one decision. Skips go to a small ring buffer; everything else to the
 * trade ledger — so the ledger isn't rewritten for every skipped trade and real
 * history never ages out early.
 */
export async function prependTrade(record: CopyTradeRecord): Promise<void> {
  if (record.status === "skipped") {
    const skips = await loadSkips();
    await enqueueWrite(() => writeJson(SKIPS_FILE, [record, ...skips].slice(0, MAX_SKIPS)));
    return;
  }
  const trades = await loadTrades();
  await saveTrades([record, ...trades]);
}

/** Ledger + recent skips merged newest-first (dashboard / scoreboard view). */
export async function loadRecentDecisions(limit = 300): Promise<CopyTradeRecord[]> {
  const [trades, skips] = await Promise.all([loadTrades(), loadSkips()]);
  return [...trades.slice(0, limit), ...skips].sort((a, b) => b.processedAt - a.processedAt).slice(0, limit);
}

export async function clearSkips(): Promise<void> {
  await enqueueWrite(() => writeJson(SKIPS_FILE, []));
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
  const shouldReplace = last && point.ts - last.ts < EQUITY_POINT_SPACING_MS;
  const next = shouldReplace ? [...points.slice(0, -1), point] : [...points, point];
  await saveEquityCurve(next);
}

export async function loadBotState(settings?: BotSettings): Promise<BotState> {
  const s = settings ?? (await loadSettings());
  const initial = createInitialBotState(s.startingBalance);
  const state = await readJson<Partial<BotState>>(STATE_FILE, initial);
  const migrated: BotState = { ...initial, ...state };
  if (!Number.isFinite(state.dailyStartBotPnlUsd)) {
    migrated.dailyStartBotPnlUsd = 0;
    migrated.dailyLossLockout = false;
    await enqueueWrite(() => writeJson(STATE_FILE, migrated));
  }
  return migrated;
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

let appendsSinceSizeCheck = 0;

async function rotateLogIfLarge(): Promise<void> {
  appendsSinceSizeCheck += 1;
  if (appendsSinceSizeCheck < 50) return;
  appendsSinceSizeCheck = 0;
  try {
    const stat = await fs.stat(ERRORS_FILE);
    if (stat.size > MAX_LOG_BYTES) await fs.rename(ERRORS_FILE, `${ERRORS_FILE}.1`);
  } catch {
    // rotation is best-effort
  }
}

export async function appendLog(level: BotLogEntry["level"], message: string): Promise<BotLogEntry> {
  await ensureErrorLog();
  const entry: BotLogEntry = {
    id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    level,
    message: message.length > 2000 ? message.slice(0, 2000) + "…" : message,
  };
  const line = JSON.stringify(entry);
  await fs.appendFile(ERRORS_FILE, `${line}\n`, "utf8");
  await rotateLogIfLarge();
  return entry;
}

/** Read only the tail of a file (the dashboard needs the newest lines). */
async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8");
    // Drop a partial first line when we started mid-file.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

export async function loadLogs(limit = MAX_LOGS): Promise<BotLogEntry[]> {
  await ensureErrorLog();
  const raw = await readTail(ERRORS_FILE, LOG_TAIL_BYTES);
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

