"use client";

import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  ExternalLink,
  KeyRound,
  OctagonX,
  Pause,
  Play,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { TrendIcon } from "@/components/ui/trend-icon";
import { RISK_PRESETS } from "@/lib/copybot/riskPresets";
import type { BotPosition, BotStatus, CopyTradeRecord, RiskPresetId } from "@/lib/copybot/types";
import { cn } from "@/lib/utils";

type Run = (name: string, url: string, body?: unknown) => Promise<boolean>;

const SIMPLE_PRESETS: { id: RiskPresetId; label: string; tagline: string }[] = [
  { id: "safe", label: "Safe", tagline: "Small bets, big cash cushion. Recommended." },
  { id: "steady", label: "Balanced", tagline: "A bit more per trade and more positions." },
  { id: "growth", label: "Growth", tagline: "Bigger bets, bigger swings both ways." },
];

function money(v: number, digits = 2): string {
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toFixed(digits)}`;
}
function signedMoney(v: number): string {
  return `${v > 0 ? "+" : v < 0 ? "-" : ""}$${Math.abs(v).toFixed(2)}`;
}
function signedPct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  return `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
}
function ago(ts: number | null | undefined, now: number): string {
  if (!ts) return "never";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function shortName(name: string): string {
  return name.length > 18 ? `${name.slice(0, 16)}…` : name;
}

/** Inline equity sparkline (no chart library). */
function EquityLine({ points }: { points: number[] }) {
  if (points.length < 2 || Math.max(...points) - Math.min(...points) < 0.005) {
    return (
      <div className="flex h-16 items-center border-y border-dashed border-border/60 text-xs text-muted-foreground">
        The chart fills in as the bot trades.
      </div>
    );
  }
  const w = 320;
  const h = 64;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const step = w / (points.length - 1);
  const d = points.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * (h - 4) - 2).toFixed(1)}`).join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-16 w-full" aria-label="Account value over time">
      <polyline
        points={d}
        fill="none"
        stroke={up ? "hsl(var(--success))" : "hsl(var(--destructive))"}
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

interface Attention {
  tone: "danger" | "warning" | "info";
  title: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
  href?: { label: string; url: string };
}

function pickAttention(status: BotStatus, now: number, run: Run): Attention | null {
  const { state, settings, metrics, buyReadiness, redeemables } = status;
  const live = settings.mode === "real";
  const wantsRunning = (state.desiredRunState ?? state.runState) === "running";
  if (state.panic) {
    return {
      tone: "danger",
      title: "Emergency stop is on",
      detail: state.panicReason ?? "No new trades will be placed until you clear it.",
      action: { label: "Clear emergency stop", onClick: () => void run("resume", "/api/bot/panic", { resume: true }) },
    };
  }
  if (live && metrics.liveBalanceStatus === "error") {
    return { tone: "danger", title: "Can't read your Polymarket balance", detail: metrics.liveBalanceError ?? undefined };
  }
  const heartbeatAge = state.lastHeartbeatAt ? now - state.lastHeartbeatAt : null;
  const staleMs = 3 * settings.pollingIntervalSec * 1000 + 120_000;
  if (wantsRunning && state.runState === "running" && heartbeatAge != null && heartbeatAge > staleMs) {
    return { tone: "warning", title: "The bot hasn't checked in for a while", detail: "It restarts itself automatically; if this persists, open Advanced → Debug log." };
  }
  if (state.lastError && wantsRunning) {
    return { tone: "warning", title: "Last check hit a problem (it will retry)", detail: state.lastError };
  }
  if (state.drawdownPauseUntil && state.drawdownPauseUntil > now) {
    return {
      tone: "warning",
      title: "New buys paused after a drop",
      detail: `Your account fell ${settings.maxDrawdownPausePercent}% from its high. Buying resumes on its own ${new Date(state.drawdownPauseUntil).toLocaleString()}. Open positions are still managed.`,
    };
  }
  if (metrics.dailyLossLockout || state.dailyLossLockout) {
    return { tone: "warning", title: "Daily loss limit reached", detail: "No new buys until tomorrow (UTC). Open positions are still managed." };
  }
  if (live && wantsRunning && !buyReadiness.buysAllowed && buyReadiness.blockers.length > 0) {
    return { tone: "warning", title: "Buying is on hold", detail: buyReadiness.blockers.map((b) => b.detail).join(" · ") };
  }
  if (redeemables.totalExpectedPayoutUsd > 0.01) {
    return {
      tone: "info",
      title: `You have ${money(redeemables.totalExpectedPayoutUsd)} of winnings to claim`,
      detail: "Resolved winning positions pay out once claimed on Polymarket.",
      href: { label: "Open Polymarket portfolio", url: "https://polymarket.com/portfolio" },
    };
  }
  return null;
}

function AttentionBanner({ a }: { a: Attention }) {
  const tone =
    a.tone === "danger"
      ? "border-destructive/50 bg-destructive/10 text-destructive"
      : a.tone === "warning"
        ? "border-warning/50 bg-warning/10 text-warning"
        : "border-primary/40 bg-primary/10 text-primary";
  return (
    <div className={cn("flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between", tone)}>
      <div className="flex gap-3">
        <AlertTriangle className="mt-0.5 size-5 shrink-0" />
        <div>
          <div className="font-semibold">{a.title}</div>
          {a.detail && <div className="mt-0.5 break-words text-sm text-foreground/80">{a.detail}</div>}
        </div>
      </div>
      {a.action && (
        <Button size="sm" variant="outline" onClick={a.action.onClick} className="shrink-0">
          {a.action.label}
        </Button>
      )}
      {a.href && (
        <a href={a.href.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-sm underline">
          {a.href.label} <ExternalLink className="size-3.5" />
        </a>
      )}
    </div>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className="min-w-0">
      <div className="eyebrow">{label}</div>
      <div className={cn("mt-1 truncate text-base font-semibold tabular-nums", className)}>{value}</div>
    </div>
  );
}

function presetNumbers(id: RiskPresetId, equity: number) {
  const p = RISK_PRESETS[id];
  const x = p.extraSettings ?? {};
  const perTrade = Math.min(x.maxTradeAmountUsd ?? 5, (equity * (x.percentageCopySize ?? 5)) / 100);
  return {
    perTrade: Math.max(1, perTrade),
    invested: (equity * p.totalExposurePercent) / 100,
    dailyStop: (equity * (x.maxDailyLossPercent ?? 10)) / 100,
    positions: x.maxOpenPositions ?? 0,
  };
}

function describeRecord(r: CopyTradeRecord): { text: string; tone: "buy" | "sell" | "skip" | "fail" } {
  const price = `${(r.price * 100).toFixed(0)}¢`;
  const what = `${r.outcome ? `${r.outcome} · ` : ""}${r.marketTitle}`;
  if (r.status === "copied" || r.status === "simulated") {
    if (r.side === "BUY") return { text: `Bought ${money(r.copyAmountUsd)} of ${what} at ~${price}`, tone: "buy" };
    const pnl = r.realizedPnlUsd ? ` (${signedMoney(r.realizedPnlUsd)})` : "";
    return { text: `Sold ${money(r.copyAmountUsd)} of ${what}${pnl}`, tone: "sell" };
  }
  const reason = r.reason.replace(/^Skipped (LIVE )?(BUY|SELL)?:?\s*/i, "").replace(/^Real trade blocked:\s*/i, "");
  if (r.status === "failed") return { text: `Couldn't trade ${what}: ${reason}`, tone: "fail" };
  return { text: `Skipped ${what}: ${reason}`, tone: "skip" };
}

function PositionCard({ p }: { p: BotPosition }) {
  const cost = p.shares * p.avgPrice;
  const value = p.shares * p.markPrice;
  const pnl = value - cost;
  const pnlPct = cost > 0 ? pnl / cost : 0;
  return (
    <div className="rounded-lg border border-border bg-background/40 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="line-clamp-2 text-sm font-medium">{p.marketTitle}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{p.outcome || "—"}</Badge>
            {p.sourceWallets.length === 0 && <Badge variant="muted">yours (not managed)</Badge>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className={cn("flex items-center justify-end gap-1 text-sm font-semibold tabular-nums", pnl >= 0 ? "text-success" : "text-destructive")}>
            <TrendIcon value={pnl} size={13} /> {signedPct(pnlPct)}
          </div>
          <div className="text-xs text-muted-foreground tabular-nums">{signedMoney(pnl)}</div>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-muted-foreground tabular-nums">
        <div>Paid {money(cost)}</div>
        <div>Now {money(value)}</div>
        <div className="text-right">{(p.markPrice * 100).toFixed(0)}¢</div>
      </div>
    </div>
  );
}

export function Home({
  status,
  run,
  busy,
  now,
}: {
  status: BotStatus;
  run: Run;
  busy: string | null;
  now: number;
}) {
  const { state, settings, metrics } = status;
  const live = settings.mode === "real";
  const running = state.runState === "running" || state.runState === "draining";
  const [confirmReal, setConfirmReal] = useState(false);
  const [confirmSell, setConfirmSell] = useState(false);
  const [sellText, setSellText] = useState("");
  const [depositDraft, setDepositDraft] = useState<string | null>(null);

  const equity = metrics.equityUsd;
  const baseline = settings.depositBaselineUsd > 0 ? settings.depositBaselineUsd : settings.startingBalance;
  const allTime = equity - baseline;
  const today = metrics.dailyPnlUsd;
  const todayBase = state.dailyStartEquityUsd > 0 ? state.dailyStartEquityUsd : equity;
  const followed = status.traders.filter((t) => t.enabled && !t.exitOnly && !t.autoDisabled).length;
  const attention = pickAttention(status, now, run);
  const curve = useMemo(() => status.equityCurve.slice(-300).map((p) => p.equityUsd), [status.equityCurve]);
  const activity = status.recentTrades.slice(0, 14);
  const simplePreset = SIMPLE_PRESETS.some((p) => p.id === settings.riskPreset);
  const heartbeatAge = state.lastHeartbeatAt ? now - state.lastHeartbeatAt : null;
  const loopHealthy = !running || (heartbeatAge != null && heartbeatAge < 3 * settings.pollingIntervalSec * 1000 + 120_000);

  const health = [
    { ok: loopHealthy, label: running ? `Checked traders ${ago(state.lastHeartbeatAt ?? state.lastPollAt, now)}` : "Bot is paused" },
    {
      ok: !live || metrics.liveBalanceStatus !== "error",
      label: live ? (metrics.liveBalanceStatus === "error" ? "Balance unreadable" : "Polymarket balance readable") : "Paper money (no wallet needed)",
    },
    { ok: !live || status.buyReadiness.buysAllowed, label: status.buyReadiness.buysAllowed ? "Allowed to buy" : "Buying on hold" },
    { ok: followed > 0, label: `Following ${followed} top trader${followed === 1 ? "" : "s"}` },
  ];

  return (
    <div className="space-y-4">
      {attention && <AttentionBanner a={attention} />}

      {/* Account value */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="eyebrow">{live ? "Account value" : "Paper account value"}</div>
            <div className="font-punto mt-1 text-5xl leading-none tabular-nums text-foreground sm:text-6xl">{money(equity)}</div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm tabular-nums">
              <span className={today >= 0 ? "text-success" : "text-destructive"}>
                Today {signedMoney(today)} ({signedPct(todayBase > 0 ? today / todayBase : 0)})
              </span>
              <span className={allTime >= 0 ? "text-success" : "text-destructive"}>
                Since start {signedMoney(allTime)} ({signedPct(baseline > 0 ? allTime / baseline : 0)})
              </span>
            </div>
          </div>
        </div>
        <div className="mt-4">
          <EquityLine points={curve} />
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3 border-t border-border pt-3">
          <Stat label="Cash" value={money(metrics.cashUsd)} />
          <Stat label="Invested" value={money(metrics.totalExposureUsd)} />
          <Stat label="Positions" value={String(status.positions.length)} />
        </div>
      </section>

      {/* Start / pause */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 font-semibold">
              <span className={cn("inline-block size-2.5 rounded-full", running ? "live-dot bg-success" : "bg-muted-foreground/60")} />
              {state.runState === "draining" ? "Closing positions only" : running ? "Trading automatically" : "Paused"}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {running
                ? `Copies ${followed} profitable traders, checking every ${settings.pollingIntervalSec}s. Next trade ≈ ${money(Math.max(1, metrics.nextTradeSizeUsd))}.`
                : "No new trades. Open positions are kept as they are."}
            </p>
          </div>
          {running ? (
            <Button size="lg" variant="outline" className="h-12 w-full sm:w-auto" disabled={busy !== null} onClick={() => void run("pause", "/api/bot/pause")}>
              <Pause /> {busy === "pause" ? "Pausing…" : "Pause"}
            </Button>
          ) : (
            <Button
              size="lg"
              className="h-12 w-full text-base sm:w-auto"
              disabled={busy !== null || state.panic}
              onClick={() => void run("start", "/api/bot/start")}
            >
              <Play /> {busy === "start" ? "Starting…" : live ? "Start trading" : "Start (paper)"}
            </Button>
          )}
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-4 text-sm">
          <span className="text-muted-foreground">Money:</span>
          <div className="inline-flex rounded-md border border-border p-0.5">
            <button
              type="button"
              className={cn("rounded px-3 py-1.5 text-xs font-medium", !live ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground")}
              disabled={busy !== null || !live}
              onClick={() => void run("mode", "/api/settings", { mode: "simulation" })}
            >
              Paper
            </button>
            <button
              type="button"
              className={cn("rounded px-3 py-1.5 text-xs font-medium", live ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
              disabled={busy !== null || live || !status.realTradingEnabled}
              title={status.realTradingEnabled ? undefined : "Real trading is switched off on the server (ENABLE_REAL_TRADING)."}
              onClick={() => setConfirmReal(true)}
            >
              Real
            </button>
          </div>
          {!status.realTradingEnabled && <span className="text-xs text-muted-foreground">Real trading is off on the server.</span>}
        </div>
      </section>

      {/* Risk level */}
      <section className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Risk level</h2>
          {!simplePreset && <Badge variant="muted">Custom ({RISK_PRESETS[settings.riskPreset]?.label ?? settings.riskPreset})</Badge>}
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          {SIMPLE_PRESETS.map((p) => {
            const n = presetNumbers(p.id, equity > 0 ? equity : baseline);
            const active = settings.riskPreset === p.id;
            return (
              <button
                key={p.id}
                type="button"
                disabled={busy !== null || active}
                onClick={() => void run("preset", "/api/settings", { riskPreset: p.id })}
                className={cn(
                  "rounded-lg border p-3 text-left transition-colors",
                  active ? "border-primary bg-primary/10" : "border-border hover:bg-accent",
                )}
              >
                <div className="flex items-center justify-between">
                  <span className={cn("font-semibold", active && "text-primary")}>{p.label}</span>
                  {active && <CheckCircle2 className="size-4 text-primary" />}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{p.tagline}</div>
                <ul className="mt-2 space-y-0.5 text-xs tabular-nums text-foreground/80">
                  <li>≈ {money(n.perTrade)} per trade</li>
                  <li>Up to {money(n.invested, 0)} invested, {n.positions} positions</li>
                  <li>Stops buying for the day after −{money(n.dailyStop)}</li>
                </ul>
              </button>
            );
          })}
        </div>
      </section>

      <div className="grid items-start gap-4 lg:grid-cols-5">
        {/* Positions */}
        <section className="rounded-lg border border-border bg-card p-5 lg:col-span-3">
          <h2 className="font-semibold">Open positions</h2>
          {status.positions.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">Nothing open right now. New positions appear here when a followed trader makes a good-looking trade.</p>
          ) : (
            <div className="mt-3 grid gap-2">
              {status.positions.map((p) => (
                <PositionCard key={p.tokenId} p={p} />
              ))}
            </div>
          )}
        </section>

        {/* Health */}
        <section className="rounded-lg border border-border bg-card p-5 lg:col-span-2">
          <h2 className="font-semibold">Health</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {health.map((h) => (
              <li key={h.label} className="flex items-center gap-2">
                {h.ok ? <CheckCircle2 className="size-4 text-success" /> : <XCircle className="size-4 text-destructive" />}
                <span className={h.ok ? "" : "text-destructive"}>{h.label}</span>
              </li>
            ))}
            {status.redeemables.totalExpectedPayoutUsd > 0.01 && (
              <li className="flex items-center gap-2">
                <CircleDollarSign className="size-4 text-primary" />
                <a href="https://polymarket.com/portfolio" target="_blank" rel="noreferrer" className="underline">
                  {money(status.redeemables.totalExpectedPayoutUsd)} winnings to claim
                </a>
              </li>
            )}
          </ul>
          <div className="mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
            <div>Take-profit +{settings.autoExitTakeProfitPercent}% · stop-loss −{settings.autoExitStopLossPercent}%</div>
            <div className="mt-1">Keeps {settings.cashReservePercent}% as cash · max {settings.maxOpenPositions || "∞"} positions</div>
          </div>
        </section>
      </div>

      {/* Activity */}
      <section className="rounded-lg border border-border bg-card p-5">
        <h2 className="font-semibold">What the bot did</h2>
        {activity.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No activity yet. Followed traders are checked every {settings.pollingIntervalSec}s.</p>
        ) : (
          <ul className="mt-3 divide-y divide-border">
            {activity.map((r) => {
              const d = describeRecord(r);
              return (
                <li key={r.id} className="flex gap-3 py-2 text-sm">
                  <span className="w-14 shrink-0 text-xs text-muted-foreground tabular-nums">{ago(r.processedAt, now)}</span>
                  <span
                    className={cn(
                      "min-w-0 break-words",
                      d.tone === "buy" && "text-foreground",
                      d.tone === "sell" && "text-primary",
                      d.tone === "skip" && "text-muted-foreground",
                      d.tone === "fail" && "text-destructive",
                    )}
                  >
                    {d.text}
                    {r.traderName && (d.tone === "buy" || d.tone === "sell") && (
                      <span className="text-muted-foreground"> · copying {shortName(r.traderName)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* Settings + danger zone */}
      <details className="group rounded-lg border border-border bg-card p-5">
        <summary className="flex cursor-pointer list-none items-center justify-between font-semibold">
          More options
          <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
        </summary>
        <div className="mt-4 space-y-5">
          <div>
            <div className="text-sm font-medium">Starting amount (for "since start" profit)</div>
            <div className="mt-2 flex max-w-xs gap-2">
              <Input
                inputMode="decimal"
                value={depositDraft ?? String(baseline)}
                onChange={(e) => setDepositDraft(e.target.value)}
                aria-label="Starting amount in dollars"
              />
              <Button
                variant="outline"
                disabled={busy !== null || depositDraft == null || !(Number(depositDraft) > 0)}
                onClick={async () => {
                  if (await run("deposit", "/api/settings", { depositBaselineUsd: Number(depositDraft) })) setDepositDraft(null);
                }}
              >
                Save
              </Button>
            </div>
          </div>

          <div className="rounded-lg border border-destructive/40 p-4">
            <div className="text-sm font-semibold text-destructive">Danger zone</div>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" className="border-destructive/50 text-destructive" disabled={busy !== null || status.positions.length === 0} onClick={() => setConfirmSell(true)}>
                Sell everything and stop
              </Button>
              {!state.panic && (
                <Button variant="destructive" disabled={busy !== null} onClick={() => void run("panic", "/api/bot/panic", { reason: "Emergency stop from the dashboard." })}>
                  <OctagonX /> Emergency stop
                </Button>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">Emergency stop blocks all new buys (even after a restart) until you clear it. It does not sell anything.</p>
          </div>
        </div>
      </details>

      <Dialog open={confirmReal} onOpenChange={setConfirmReal} title="Switch to real money?">
        <div className="space-y-3 text-sm">
          <p>The bot will place real orders with the USDC in your Polymarket account, using the <b>{RISK_PRESETS[settings.riskPreset]?.label ?? settings.riskPreset}</b> risk level.</p>
          <p className="text-muted-foreground">Copy trading can lose money. Limits stay on: per-trade size, max invested, a cash cushion and a daily loss stop.</p>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmReal(false)}>Cancel</Button>
            <Button
              onClick={async () => {
                setConfirmReal(false);
                await run("mode", "/api/settings", { mode: "real" });
              }}
            >
              <ShieldCheck /> Use real money
            </Button>
          </div>
        </div>
      </Dialog>

      <Dialog open={confirmSell} onOpenChange={(o) => { setConfirmSell(o); setSellText(""); }} title="Sell every position and stop?">
        <div className="space-y-3 text-sm">
          <p>All {status.positions.length} open positions will be sold at the current best price{live ? " with real orders" : ""}, then the bot stops.</p>
          <p className="text-muted-foreground">Type <b>SELL</b> to confirm.</p>
          <Input value={sellText} onChange={(e) => setSellText(e.target.value)} aria-label="Type SELL to confirm" autoFocus />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmSell(false)}>Cancel</Button>
            <Button
              variant="destructive"
              disabled={sellText.trim().toUpperCase() !== "SELL" || busy !== null}
              onClick={async () => {
                setConfirmSell(false);
                setSellText("");
                await run("sell-all", "/api/bot/stop", { liquidate: true, source: "manual-flatten" });
              }}
            >
              Sell everything
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/** Small prompt shown when the server requires the dashboard password. */
export function TokenPrompt({ open, onSubmit, onCancel }: { open: boolean; onSubmit: (t: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()} title="Dashboard password needed">
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value);
        }}
      >
        <p className="text-muted-foreground">Enter the dashboard password (DASHBOARD_AUTH_TOKEN) once; this browser remembers it.</p>
        <Input type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus aria-label="Dashboard password" />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>
          <Button type="submit"><KeyRound /> Unlock</Button>
        </div>
      </form>
    </Dialog>
  );
}
