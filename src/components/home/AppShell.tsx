"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BarChart3, Bot, LayoutGrid, Loader2, Wallet } from "lucide-react";
import { Dashboard } from "@/components/dashboard/Dashboard";
import { Home, TokenPrompt } from "@/components/home/Home";
import { useBotActions, useBotStatus } from "@/lib/hooks/useBotStatus";
import { cn } from "@/lib/utils";

type Tab = "home" | "advanced";
const TAB_KEY = "bonk.tab";

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function AppShell() {
  const [tab, setTab] = useState<Tab>("home");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(TAB_KEY);
      if (saved === "home" || saved === "advanced") setTab(saved);
    } catch {
      // storage unavailable: default tab
    }
  }, []);
  const choose = useCallback((t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(TAB_KEY, t);
    } catch {
      // ignore
    }
  }, []);

  const { data: status, error, mutate } = useBotStatus();
  const actions = useBotActions(() => mutate());
  const now = useNow(5000);

  const live = status?.settings.mode === "real";
  const running = status?.state.runState === "running" || status?.state.runState === "draining";

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1100px] items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <Bot className="size-6 shrink-0 text-primary" />
            <span className="text-lg font-bold tracking-tight">Bonk</span>
            {status && (
              <span
                className={cn(
                  "ml-1 hidden rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider sm:inline",
                  live ? "bg-primary/15 text-primary" : "bg-secondary text-secondary-foreground",
                )}
              >
                {live ? "Live · real money" : "Paper"}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {status && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn("inline-block size-2 rounded-full", running ? "live-dot bg-success" : "bg-muted-foreground/60")} />
                <span className="hidden sm:inline">{running ? "Running" : "Paused"}</span>
              </span>
            )}
            <nav className="inline-flex rounded-md border border-border p-0.5 text-xs">
              <button
                type="button"
                onClick={() => choose("home")}
                className={cn("rounded px-3 py-1.5 font-medium", tab === "home" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                Home
              </button>
              <button
                type="button"
                onClick={() => choose("advanced")}
                className={cn("flex items-center gap-1 rounded px-3 py-1.5 font-medium", tab === "advanced" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                <LayoutGrid className="size-3" /> Advanced
              </button>
            </nav>
          </div>
        </div>
      </header>

      {tab === "advanced" ? (
        <Dashboard />
      ) : (
        <main className="mx-auto max-w-[1100px] space-y-4 px-4 py-4 lg:py-6">
          {actions.error && (
            <div className="flex items-start justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
              <span className="break-words">{actions.error}</span>
              <button type="button" className="shrink-0 underline" onClick={() => actions.setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {!status ? (
            <div className="flex min-h-[50vh] items-center justify-center gap-2 text-sm text-muted-foreground">
              {error ? (
                <span className="text-destructive">Can't reach the bot: {error instanceof Error ? error.message : "unknown error"}</span>
              ) : (
                <>
                  <Loader2 className="size-4 animate-spin" /> Loading…
                </>
              )}
            </div>
          ) : (
            <Home status={status} run={actions.run} busy={actions.busy} now={now} />
          )}
          <footer className="flex flex-wrap items-center justify-center gap-4 pb-6 pt-2 text-xs text-muted-foreground">
            <Link href="/analytics" className="inline-flex items-center gap-1 hover:text-foreground">
              <BarChart3 className="size-3" /> Analytics
            </Link>
            <Link href="/recovery" className="inline-flex items-center gap-1 hover:text-foreground">
              <Wallet className="size-3" /> Portfolio check
            </Link>
            <span>Copy trading carries risk. Only trade what you can afford to lose.</span>
          </footer>
        </main>
      )}

      <TokenPrompt
        open={actions.needsToken != null}
        onSubmit={(t) => void actions.retryWithToken(t)}
        onCancel={() => actions.setNeedsToken(null)}
      />
    </div>
  );
}
