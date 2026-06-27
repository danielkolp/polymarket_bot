/**
 * Newline-delimited JSON (NDJSON) storage for the analytics layer.
 *
 * One append-only file per stream, all under data/analytics/. NDJSON keeps every
 * event individually queryable and trivially exportable, and append writes are
 * cheap (mirrors how the bot's error log is persisted). Files are compacted to a
 * bounded tail only when they grow past a size threshold, so steady-state runtime
 * overhead is a single appendFile per event.
 */
import { promises as fs } from "fs";
import path from "path";

const ANALYTICS_DIR = path.join(process.cwd(), "data", "analytics");

export const ANALYTICS_FILES = {
  decisions: path.join(ANALYTICS_DIR, "decisions.ndjson"),
  /** Bot-autonomous exits (auto-exit/leader-exit/flatten/redeem/settlement). */
  exits: path.join(ANALYTICS_DIR, "exits.ndjson"),
  snapshots: path.join(ANALYTICS_DIR, "snapshots.ndjson"),
  missed: path.join(ANALYTICS_DIR, "missed.ndjson"),
  /** Bookkeeping: ids of decisions already resolved into missed.ndjson. */
  missedResolved: path.join(ANALYTICS_DIR, "missed-resolved.json"),
} as const;

const COMPACT_THRESHOLD_BYTES = 8 * 1024 * 1024; // 8 MB
const COMPACT_KEEP_LINES = 50_000;

async function ensureDir(): Promise<void> {
  await fs.mkdir(ANALYTICS_DIR, { recursive: true });
}

/** Append one object as a JSON line. Best-effort; never throws to the caller. */
export async function appendNdjson(file: string, obj: unknown): Promise<void> {
  try {
    await ensureDir();
    await fs.appendFile(file, `${JSON.stringify(obj)}\n`, "utf8");
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[analytics-store] append failed for ${path.basename(file)}:`, err);
    }
  }
}

export interface ReadNdjsonOptions<T> {
  /** Return only the most recent N rows (after filtering). */
  limit?: number;
  /** Optional predicate applied while streaming. */
  filter?: (row: T) => boolean;
}

/** Read and parse an NDJSON file (oldest-first). Missing file -> empty array. */
export async function readNdjson<T>(file: string, opts: ReadNdjsonOptions<T> = {}): Promise<T[]> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const rows: T[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    let parsed: T;
    try {
      parsed = JSON.parse(line) as T;
    } catch {
      continue; // skip a torn final line rather than failing the whole read
    }
    if (opts.filter && !opts.filter(parsed)) continue;
    rows.push(parsed);
  }

  if (opts.limit != null && rows.length > opts.limit) {
    return rows.slice(rows.length - opts.limit);
  }
  return rows;
}

/** Count rows cheaply-ish (used by the dashboard summaries). */
export async function countNdjson(file: string): Promise<number> {
  try {
    const raw = await fs.readFile(file, "utf8");
    let n = 0;
    for (const line of raw.split(/\r?\n/)) if (line) n += 1;
    return n;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

/**
 * Compact a file to its last {@link COMPACT_KEEP_LINES} lines, but only when it
 * has grown past {@link COMPACT_THRESHOLD_BYTES}. The size check is a cheap stat;
 * the rewrite only happens rarely. Safe no-op when the file is small or missing.
 */
export async function compactIfLarge(file: string): Promise<void> {
  try {
    const stat = await fs.stat(file);
    if (stat.size < COMPACT_THRESHOLD_BYTES) return;
    const raw = await fs.readFile(file, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const kept = lines.slice(-COMPACT_KEEP_LINES);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, kept.join("\n") + "\n", "utf8");
    await fs.rename(tmp, file).catch(async (renameErr) => {
      const code = (renameErr as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EBUSY") {
        await fs.copyFile(tmp, file);
        await fs.unlink(tmp).catch(() => {});
      } else {
        throw renameErr;
      }
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    if (process.env.NODE_ENV !== "test") {
      console.warn(`[analytics-store] compact failed for ${path.basename(file)}:`, err);
    }
  }
}

/** Read the small JSON bookkeeping set of already-resolved missed decision ids. */
export async function readResolvedSet(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(ANALYTICS_FILES.missedResolved, "utf8");
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

export async function writeResolvedSet(ids: Set<string>): Promise<void> {
  try {
    await ensureDir();
    // Bound the set so it cannot grow without limit.
    const arr = [...ids].slice(-100_000);
    await fs.writeFile(ANALYTICS_FILES.missedResolved, JSON.stringify(arr), "utf8");
  } catch (err) {
    if (process.env.NODE_ENV !== "test") {
      console.warn("[analytics-store] writeResolvedSet failed:", err);
    }
  }
}
