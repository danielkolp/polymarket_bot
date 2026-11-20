/**
 * Low-level HTTP client for Polymarket upstreams. Single choke point for
 * timeouts, bounded retries, and typed errors. Never throws raw network errors
 * to callers — always raises a `PolymarketError` with a clean message.
 */
import { config } from "@/lib/config";

export class PolymarketError extends Error {
  readonly status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.name = "PolymarketError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /** Number of retries on 5xx / network failure. Default 2. */
  retries?: number;
  timeoutMs?: number;
}

function buildUrl(base: string, path: string, query?: RequestOptions["query"]): string {
  const url = new URL(path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue;
      url.searchParams.append(key, String(value));
    }
  }
  return url.toString();
}

async function doFetch<T>(url: string, options: RequestOptions): Promise<T> {
  const { method = "GET", body, retries = 2, timeoutMs = config.requestTimeoutMs } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        // Always hit the network; we add our own caching at the route layer.
        cache: "no-store",
      });
      clearTimeout(timer);

      // Rate limited (or a retryable 503): honour Retry-After, capped so a single
      // call can never stall the bot loop for long.
      if (res.status === 429 || res.status === 503) {
        lastError = new PolymarketError(`Upstream ${res.status} (rate limited) for ${url}`, res.status);
        if (attempt < retries) {
          const retryAfterSec = Number(res.headers.get("retry-after"));
          const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 500 * (attempt + 1);
          await sleep(Math.min(5000, waitMs));
          continue;
        }
        throw lastError;
      }
      // 410 Gone = Polymarket retired this endpoint. Say so plainly instead of a
      // generic upstream error so the operator knows a code update is needed.
      if (res.status === 410) {
        const text = await res.text().catch(() => "");
        throw new PolymarketError(
          `Polymarket retired this API endpoint (HTTP 410) — the bot needs a code update: ${url}${text ? ` ${text.slice(0, 200)}` : ""}`,
          410,
        );
      }
      if (res.status >= 500) {
        lastError = new PolymarketError(`Upstream ${res.status} for ${url}`, 502);
        if (attempt < retries) {
          await sleep(250 * (attempt + 1));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new PolymarketError(
          `Upstream ${res.status} for ${url}${text ? `: ${text.slice(0, 200)}` : ""}`,
          res.status,
        );
      }

      return (await res.json()) as T;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      const isAbort = err instanceof Error && err.name === "AbortError";
      const isPolyClientErr = err instanceof PolymarketError && err.status < 500 && err.status !== 429;
      // Don't retry clean 4xx errors; do retry timeouts/network/5xx.
      if (isPolyClientErr) throw err;
      if (attempt < retries) {
        await sleep(250 * (attempt + 1));
        continue;
      }
      if (isAbort) {
        throw new PolymarketError(`Upstream timed out after ${timeoutMs}ms: ${url}`, 504);
      }
      throw err instanceof PolymarketError
        ? err
        : new PolymarketError(`Network error for ${url}: ${(err as Error).message}`, 502);
    }
  }

  throw lastError instanceof PolymarketError
    ? lastError
    : new PolymarketError(`Request failed: ${url}`, 502);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const gammaRequest = <T>(path: string, options: RequestOptions = {}): Promise<T> =>
  doFetch<T>(buildUrl(config.gammaUrl, path, options.query), options);

export const clobRequest = <T>(path: string, options: RequestOptions = {}): Promise<T> =>
  doFetch<T>(buildUrl(config.clobUrl, path, options.query), options);

export const dataRequest = <T>(path: string, options: RequestOptions = {}): Promise<T> =>
  doFetch<T>(buildUrl(config.dataApiUrl, path, options.query), options);
