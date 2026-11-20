"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import type { BotStatus } from "@/lib/copybot/types";
import { jsonFetcher } from "./fetcher";

/**
 * Shared bot-status poller for the dashboard. Refreshes every 5s while the tab
 * is visible (SWR pauses polling in background tabs, so an idle phone tab costs
 * the server nothing).
 */
export function useBotStatus() {
  const swr = useSWR<BotStatus>("/api/bot/status", jsonFetcher, {
    refreshInterval: 5000,
    refreshWhenHidden: false,
    revalidateOnFocus: true,
    keepPreviousData: true,
  });
  return swr;
}

export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/** POST a JSON body to a mutating route; throws UnauthorizedError on 401. */
export async function postAction<T = unknown>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: "same-origin",
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string; data?: T } | null;
  if (res.status === 401) throw new UnauthorizedError(json?.error ?? "Dashboard password required.");
  if (!res.ok || !json || json.ok === false) throw new Error(json?.error ?? `Request failed (${res.status})`);
  return json.data as T;
}

/** Store the dashboard password as a same-site cookie the server's guard accepts. */
export function saveDashboardToken(token: string): void {
  const secure = typeof location !== "undefined" && location.protocol === "https:" ? "; secure" : "";
  document.cookie = `dashboard_token=${encodeURIComponent(token.trim())}; path=/; max-age=31536000; samesite=strict${secure}`;
}

/**
 * Run dashboard actions with one shared busy flag, error message and a
 * "needs password" state (when DASHBOARD_AUTH_TOKEN is set on the server).
 */
export function useBotActions(onDone: () => unknown) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsToken, setNeedsToken] = useState<null | { name: string; url: string; body?: unknown }>(null);

  const run = useCallback(
    async (name: string, url: string, body?: unknown): Promise<boolean> => {
      setBusy(name);
      setError(null);
      try {
        await postAction(url, body);
        await onDone();
        return true;
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          setNeedsToken({ name, url, body });
        } else {
          setError(err instanceof Error ? err.message : "Action failed");
        }
        return false;
      } finally {
        setBusy(null);
      }
    },
    [onDone],
  );

  const retryWithToken = useCallback(
    async (token: string) => {
      saveDashboardToken(token);
      const pending = needsToken;
      setNeedsToken(null);
      if (pending) await run(pending.name, pending.url, pending.body);
    },
    [needsToken, run],
  );

  return { busy, error, setError, run, needsToken, setNeedsToken, retryWithToken };
}
