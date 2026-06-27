"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Activity, AlertTriangle, Bot, OctagonX, Pause, Play, Plus, RefreshCcw, RotateCcw, ShieldCheck, Square, Trash2, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TrendIcon } from "@/components/ui/trend-icon";
import { applyRealModeSafetyCaps, RISK_PRESETS, type RiskPreset } from "@/lib/copybot/riskPresets";
import { DashboardVisuals } from "./DashboardVisuals";
import { cn } from "@/lib/utils";
import { fromNow } from "@/lib/time";
import type { BotLogEntry, BotPosition, BotSettings, BotStatus, CopyTradeRecord, FollowedTrader, RiskPresetId, SessionScoreboard, WalletCopyStat } from "@/lib/copybot/types";

type ApiEnvelope<T> = { ok: true; data: T; fetchedAt: number } | { ok: false; error: string };

async function readApiEnvelope<T>(res: Response): Promise<ApiEnvelope<T>> {
  const text = await res.text();
  if (text.trim().length === 0) {
    return { ok: false, error: "Server returned an empty response. Showing the last good dashboard snapshot." };
  }
  try {
    return JSON.parse(text) as ApiEnvelope<T>;
  } catch {
    return { ok: false, error: "Server returned incomplete JSON. Showing the last good dashboard snapshot." };
  }
}

async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = await readApiEnvelope<T>(res);
  if (!res.ok || !json.ok) throw new Error(json.ok ? `Request failed (${res.status})` : json.error);
  return json.data;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await readApiEnvelope<T>(res);
  if (!res.ok || !json.ok) throw new Error(json.ok ? `Request failed (${res.status})` : json.error);
  return json.data;
}

function money(value: number, fractionDigits = 2): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(Number.isFinite(value) ? value : 0);
}

function compactMoney(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: Math.abs(value) >= 1000 ? 1 : 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function signedMoney(value: number): string {
  const formatted = money(Math.abs(value));
  return value < 0 ? `-${formatted}` : `+${formatted}`;
}

function percent(value: number, fractionDigits = 1): string {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(fractionDigits)}%`;
}

function dateTime(value: number | string | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function cents(price: number): string {
  return `${((Number.isFinite(price) ? price : 0) * 100).toFixed(1)}c`;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function clockTime(date: Date): string {
  return date
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    .replace(/\s/g, "")
    .toLowerCase();
}

function localDayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

function friendlyTradeTime(value: number | null, now: number): string {
  if (!value) return "-";
  const date = new Date(value);
  const diffMs = now - value;
  if (diffMs >= 0 && diffMs < 60_000) return "just now";
  if (diffMs >= 0 && diffMs < 24 * 60 * 60 * 1000) {
    const totalMinutes = Math.max(1, Math.floor(diffMs / 60_000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}min` : ""} ago`;
    return `${minutes}min ago`;
  }

  const todayStart = localDayStart(new Date(now));
  const tradeStart = localDayStart(date);
  const dayDiff = Math.round((todayStart - tradeStart) / (24 * 60 * 60 * 1000));
  if (dayDiff === 1) return `yesterday at ${clockTime(date)}`;

  const datePart = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
  return `${datePart} at ${clockTime(date)}`;
}

function shortWallet(wallet: string): string {
  return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
}

/** Re-render every `intervalMs` so relative times tick visibly. */
function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const SPINNER_FRAMES = ['⣷', '⣯', '⣟', '⡿', '⢿', '⣻', '⣽', '⣾'] as const;

function useSpinner(intervalMs = 80): string {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return SPINNER_FRAMES[frame];
}

/** Smoothly count from previous value to a new target (ease-out cubic, ~400ms). */
function useAnimatedNumber(target: number): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(target)) { setDisplay(target); return; }
    const from = fromRef.current;
    if (from === target) return;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    const duration = 380;
    const startTime = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - startTime) / duration, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      const v = from + (target - from) * eased;
      fromRef.current = v;
      setDisplay(v);
      if (t < 1) { rafRef.current = requestAnimationFrame(tick); }
      else { fromRef.current = target; }
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [target]);

  return display;
}

function relPast(ts: number | null, now: number): string {
  if (!ts) return "-";
  return fromNow(ts - now); // negative diff => "12s ago"
}

function relFuture(ts: number | null, now: number): string {
  if (!ts) return "-";
  const diff = ts - now;
  if (diff <= 0) return "due now";
  return `in ${fromNow(diff)}`;
}

function tone(value: number): "pos" | "neg" | "neutral" {
  if (value > 0) return "pos";
  if (value < 0) return "neg";
  return "neutral";
}

type PulseDirection = "up" | "down" | null;

function useValuePulse(value: number | null | undefined): { direction: PulseDirection; delta: number } {
  const previous = useRef<number | null>(null);
  const [pulse, setPulse] = useState<{ direction: PulseDirection; delta: number }>({ direction: null, delta: 0 });

  useEffect(() => {
    if (value == null || !Number.isFinite(value)) return;
    const prev = previous.current;
    previous.current = value;
    if (prev == null) return;

    const delta = value - prev;
    if (Math.abs(delta) < 1e-9) return;
    setPulse({ direction: delta > 0 ? "up" : "down", delta });
    const timeout = window.setTimeout(() => setPulse({ direction: null, delta: 0 }), 950);
    return () => window.clearTimeout(timeout);
  }, [value]);

  return pulse;
}

function pulseClass(direction: PulseDirection): string | false {
  if (direction === "up") return "value-blink-up";
  if (direction === "down") return "value-blink-down";
  return false;
}

function BlinkValue({
  value,
  children,
  className,
  showIcon = true,
  contained = false,
}: {
  value: number | null | undefined;
  children: ReactNode;
  className?: string;
  showIcon?: boolean;
  contained?: boolean;
}) {
  const pulse = useValuePulse(value);
  return (
    <span className={cn("inline-flex items-center justify-end rounded px-1 transition-colors", pulseClass(pulse.direction), contained && "value-blink-contained", className)}>
      {showIcon && (
        <span className="mr-1 flex w-[15px] shrink-0 items-center">
          {pulse.direction && (
            <span className="animate-in zoom-in-50 duration-150">
              <TrendIcon value={pulse.delta} size={13} />
            </span>
          )}
        </span>
      )}
      {children}
    </span>
  );
}

function StatCard({
  label,
  value,
  rawValue,
  format = money,
  sub,
  tone: statTone = "neutral",
  arrow,
  pulseValue,
}: {
  label: string;
  value?: string;
  rawValue?: number;
  format?: (n: number) => string;
  sub?: string;
  tone?: "pos" | "neg" | "neutral";
  arrow?: number;
  pulseValue?: number | null;
}) {
  const pulse = useValuePulse(pulseValue ?? rawValue);
  const animated = useAnimatedNumber(rawValue ?? 0);
  const spinner = useSpinner();
  const trendValue = pulse.direction ? pulse.delta : arrow;
  const showArrow = trendValue !== undefined && trendValue !== 0;
  const displayValue = rawValue !== undefined ? format(animated) : (value ?? "");

  return (
    <Card className={cn("p-4 cursor-default select-none transition-all duration-150 hover:-translate-y-px hover:shadow-[0_4px_16px_hsl(var(--primary)/0.08)]", pulseClass(pulse.direction))}>
      <div className="text-xs text-muted-foreground whitespace-nowrap">{label}</div>
      <div
        className={cn(
          "mt-1 flex items-center whitespace-nowrap rounded font-punto text-2xl tabular-nums transition-colors sm:text-3xl",
          statTone === "pos" && "text-success",
          statTone === "neg" && "text-destructive",
          pulse.direction === "up" && "text-success value-glow-up",
          pulse.direction === "down" && "text-destructive value-glow-down",
        )}
      >
        <span className="flex w-[22px] shrink-0 items-center">
          {showArrow ? (
            <span className="animate-in zoom-in-50 duration-150">
              <TrendIcon value={trendValue!} size={18} />
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground/40 select-none">{spinner}</span>
          )}
        </span>
        {displayValue}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </Card>
  );
}
function StatusBadge({ status }: { status: BotStatus }) {
  const runState = status.state.runState;
  const variant =
    runState === "running" ? "success" : runState === "paused" || runState === "draining" ? "warning" : "muted";
  const label = runState === "draining" ? "draining - exit-only" : runState;
  const liveBalanceVariant =
    status.metrics.liveBalanceStatus === "ok"
      ? "success"
      : status.metrics.liveBalanceStatus === "warning"
        ? "warning"
        : status.metrics.liveBalanceStatus === "error"
          ? "destructive"
          : "muted";
  return (
    <div className="flex flex-wrap gap-2">
      <Badge variant={variant}>{label}</Badge>
      <Badge variant={status.settings.mode === "simulation" ? "default" : "destructive"}>{status.settings.mode}</Badge>
      {status.settings.sessionOnly && <Badge variant="warning">session-only</Badge>}
      <Badge variant={status.realTradingEnabled ? "warning" : "muted"}>
        ENABLE_REAL_TRADING={String(status.realTradingEnabled)}
      </Badge>
      {status.settings.mode === "real" && (
        <Badge variant={liveBalanceVariant}>live balance {status.metrics.liveBalanceStatus}</Badge>
      )}
    </div>
  );
}

function NumberField({
  label,
  value,
  step = 1,
  min = 0,
  max,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="space-y-1 text-xs text-muted-foreground">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        step={step}
        value={Number.isFinite(value) ? value : 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

function SettingsPanel({ status, onSave }: { status: BotStatus; onSave: (settings: Partial<BotSettings>) => Promise<void> }) {
  const [draft, setDraft] = useState(status.settings);
  const [saving, setSaving] = useState(false);
  const settingsKey = JSON.stringify(status.settings);

  useEffect(() => {
    setDraft(status.settings);
  }, [settingsKey]);

  const update = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => setDraft((current) => applyRealModeSafetyCaps({ ...current, [key]: value }));
  const applyRiskPreset = (presetId: RiskPresetId) => {
    const preset: RiskPreset = RISK_PRESETS[presetId];
    setDraft((current) =>
      applyRealModeSafetyCaps(
        presetId === "custom"
          ? { ...current, riskPreset: "custom" }
          : {
              ...current,
              riskPreset: presetId,
              maxTotalExposurePercent: preset.totalExposurePercent,
              maxExposurePerMarketPercent: preset.perMarketExposurePercent,
              minTimeToResolutionMinutes: preset.minTimeToResolutionMinutes,
              minBuyTokenPrice: preset.minBuyTokenPrice,
              maxBuyTokenPrice: preset.maxBuyTokenPrice,
              // Presets may pin extra fields (e.g. Action Mode's discovery breadth
              // and conviction thresholds). Mirror them so the form matches what the
              // server will pin on save.
              ...preset.extraSettings,
            },
      ),
    );
  };
  const updateRiskCap = (
    key:
      | "maxExposurePerMarketPercent"
      | "maxTotalExposurePercent"
      | "minTimeToResolutionMinutes"
      | "minBuyTokenPrice"
      | "maxBuyTokenPrice",
    value: number,
  ) => {
    setDraft((current) => applyRealModeSafetyCaps({ ...current, riskPreset: "custom", [key]: value }));
  };
  const save = async () => {
    setSaving(true);
    try {
      await onSave(draft);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Settings</CardTitle>
        <CardDescription>Simulation is the default. Real mode is blocked unless the server env flag is explicitly true.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Risk preset</span>
            <Select value={draft.riskPreset} onChange={(event) => applyRiskPreset(event.target.value as RiskPresetId)}>
              {Object.values(RISK_PRESETS).map((preset) => (
                <option key={preset.id} value={preset.id}>{preset.label}</option>
              ))}
            </Select>
            {RISK_PRESETS[draft.riskPreset]?.description && (
              <span className="block text-[11px] leading-snug text-muted-foreground/80">
                {RISK_PRESETS[draft.riskPreset].description}
              </span>
            )}
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Mode</span>
            <Select value={draft.mode} onChange={(event) => update("mode", event.target.value as BotSettings["mode"])}>
              <option value="simulation">simulation</option>
              <option value="real" disabled={!status.realTradingEnabled}>real</option>
            </Select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Sizing mode</span>
            <Select value={draft.sizingMode} onChange={(event) => update("sizingMode", event.target.value as BotSettings["sizingMode"])}>
              <option value="fixed">fixed dollar</option>
              <option value="percentage">percentage balance</option>
              <option value="hybrid">percentage + min/max</option>
            </Select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Sell behavior</span>
            <Select value={draft.sellBehavior} onChange={(event) => update("sellBehavior", event.target.value as BotSettings["sellBehavior"])}>
              <option value="proportional">proportional</option>
              <option value="all">sell all</option>
            </Select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Sizing signal</span>
            <Select value={draft.sizingSignalMode} onChange={(event) => update("sizingSignalMode", event.target.value as BotSettings["sizingSignalMode"])}>
              <option value="local-fixed">local (own sizing)</option>
              <option value="leader-size-weighted">leader-size weighted</option>
            </Select>
          </label>
          <NumberField label="Fixed copy amount ($)" value={draft.fixedCopyAmountUsd} step={0.25} onChange={(value) => update("fixedCopyAmountUsd", value)} />
          <NumberField label="Percentage copy size (%)" value={draft.percentageCopySize} step={0.25} onChange={(value) => update("percentageCopySize", value)} />
          <NumberField label="Minimum trade amount ($)" value={draft.minTradeAmountUsd} step={0.01} onChange={(value) => update("minTradeAmountUsd", value)} />
          <NumberField label="Maximum trade amount ($)" value={draft.maxTradeAmountUsd} step={0.25} onChange={(value) => update("maxTradeAmountUsd", value)} />
          <NumberField label="Per-market exposure cap (%)" value={draft.maxExposurePerMarketPercent} step={0.5} onChange={(value) => updateRiskCap("maxExposurePerMarketPercent", value)} />
          <NumberField label="Total exposure cap (%)" value={draft.maxTotalExposurePercent} step={0.5} onChange={(value) => updateRiskCap("maxTotalExposurePercent", value)} />
          <NumberField label="Daily loss cap (%)" value={draft.maxDailyLossPercent} step={0.5} min={0.01} max={100} onChange={(value) => update("maxDailyLossPercent", value)} />
          <NumberField label="Max copies / wallet / cycle" value={draft.maxCopiesPerWalletPerCycle} step={1} min={0} onChange={(value) => update("maxCopiesPerWalletPerCycle", value)} />
          <NumberField label="Per-wallet exposure cap (%)" value={draft.maxExposurePerWalletPercent} step={1} min={0} max={100} onChange={(value) => update("maxExposurePerWalletPercent", value)} />
          <NumberField label="Same wallet/market cooldown (sec)" value={draft.walletTradeCooldownSec} step={15} min={0} onChange={(value) => update("walletTradeCooldownSec", value)} />
          <NumberField label={draft.mode === "real" ? "Local equity seed ($)" : "Starting balance ($)"} value={draft.startingBalance} step={1} min={1} onChange={(value) => update("startingBalance", value)} />
          <NumberField label="Min available balance ($)" value={draft.minAvailableBalanceUsd} step={0.25} onChange={(value) => update("minAvailableBalanceUsd", value)} />
          <NumberField label="Polling interval (sec)" value={draft.pollingIntervalSec} step={5} min={5} onChange={(value) => update("pollingIntervalSec", value)} />
          <NumberField label="Top traders to follow" value={draft.topTradersToFollow} step={1} min={1} max={100} onChange={(value) => update("topTradersToFollow", value)} />
          <NumberField label="Min weekly volume ($)" value={draft.minTraderWeeklyVolumeUsd} step={50} onChange={(value) => update("minTraderWeeklyVolumeUsd", value)} />
          <NumberField label="Min weekly trade count" value={draft.minTraderTradeCount} step={1} onChange={(value) => update("minTraderTradeCount", value)} />
          <NumberField label="Max trader inactivity (hrs)" value={draft.maxTraderInactivityHours} step={1} min={0.25} onChange={(value) => update("maxTraderInactivityHours", value)} />
          <NumberField label="Min market liquidity ($)" value={draft.minMarketLiquidityUsd} step={50} onChange={(value) => update("minMarketLiquidityUsd", value)} />
          <NumberField label="Min BUY price (c)" value={draft.minBuyTokenPrice * 100} step={0.5} min={0} max={100} onChange={(value) => updateRiskCap("minBuyTokenPrice", value / 100)} />
          <NumberField label="Max BUY price (c)" value={draft.maxBuyTokenPrice * 100} step={0.5} min={0} max={100} onChange={(value) => updateRiskCap("maxBuyTokenPrice", value / 100)} />
          <NumberField label="Max market spread (c)" value={draft.maxMarketSpread * 100} step={0.5} min={0} max={100} onChange={(value) => update("maxMarketSpread", value / 100)} />
          <NumberField label="Min time to resolution (min)" value={draft.minTimeToResolutionMinutes} step={15} min={0} onChange={(value) => updateRiskCap("minTimeToResolutionMinutes", value)} />
          <NumberField label="Max trade age (sec)" value={draft.maxTradeAgeSec} step={30} min={5} onChange={(value) => update("maxTradeAgeSec", value)} />
          <NumberField label="Max adverse entry move (c)" value={draft.maxAdverseEntryMoveCents} step={0.5} min={0} onChange={(value) => update("maxAdverseEntryMoveCents", value)} />
          <NumberField label="Live BUY freshness (sec)" value={draft.liveMaxCopyTradeAgeSec} step={15} min={5} onChange={(value) => update("liveMaxCopyTradeAgeSec", value)} />
          <NumberField label="Auto-exit take-profit (%)" value={draft.autoExitTakeProfitPercent} step={1} onChange={(value) => update("autoExitTakeProfitPercent", value)} />
          <NumberField label="Auto-exit stop-loss (%)" value={draft.autoExitStopLossPercent} step={1} onChange={(value) => update("autoExitStopLossPercent", value)} />
          <NumberField label="Auto-exit max hold (min)" value={draft.autoExitMaxHoldMinutes} step={5} onChange={(value) => update("autoExitMaxHoldMinutes", value)} />
          <NumberField label="Taker fee (bps)" value={draft.takerFeeBps} step={1} onChange={(value) => update("takerFeeBps", value)} />
          <NumberField label="Max slippage (bps)" value={draft.maxSlippageBps} step={25} min={1} onChange={(value) => update("maxSlippageBps", value)} />
          <NumberField label="Fallback spread (bps)" value={draft.fallbackSpreadBps} step={25} onChange={(value) => update("fallbackSpreadBps", value)} />
        </div>
        <label className="flex items-center justify-between rounded-md border border-border p-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium text-foreground">Realistic fills (spread, slippage, fees)</span>
            <span className="block text-xs text-muted-foreground">Fill copies against the live order book with spread/slippage/partial fills instead of idealized prices. Turn off to compare against the optimistic curve.</span>
          </span>
          <Switch checked={draft.realisticFills} onCheckedChange={(value) => update("realisticFills", value)} aria-label="Realistic fills" />
        </label>
        <label className="flex items-center justify-between rounded-md border border-border p-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium text-foreground">Session-only mode</span>
            <span className="block text-xs text-muted-foreground">Auto-liquidate every open position when the bot stops or the dashboard window is closed.</span>
          </span>
          <Switch checked={draft.sessionOnly} onCheckedChange={(value) => update("sessionOnly", value)} aria-label="Session-only mode" />
        </label>
        <label className="flex items-center justify-between rounded-md border border-border p-3">
          <span className="space-y-0.5">
            <span className="block text-sm font-medium text-foreground">Exit when leader exits</span>
            <span className="block text-xs text-muted-foreground">When a copied position&rsquo;s source leader no longer holds it, sell it (sim: at mark; real: only bot-opened positions, gated by live-data health). Manual/unknown positions are never touched.</span>
          </span>
          <Switch checked={draft.exitWhenLeaderNoLongerHolds} onCheckedChange={(value) => update("exitWhenLeaderNoLongerHolds", value)} aria-label="Exit when leader exits" />
        </label>
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TraderTable({ traders, onToggle, onRemove, onRefresh, refreshing }: { traders: FollowedTrader[]; onToggle: (wallet: string, enabled: boolean) => void; onRemove: (wallet: string) => void; onRefresh: () => void; refreshing: boolean }) {
  const now = useNow(60_000);
  const rowGrid = "md:grid md:grid-cols-[minmax(0,1.6fr)_0.62fr_0.78fr_0.78fr_0.48fr_0.78fr_1.05fr_1.05fr] md:items-center md:gap-2";
  const headerClass = "hidden border-b border-border pb-2 text-xs text-muted-foreground md:grid";
  const cellLabel = "mr-2 text-muted-foreground md:hidden";

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle>Followed Traders</CardTitle>
            <CardDescription>Auto-discovered active weekly traders plus manual wallets.</CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onRefresh} disabled={refreshing} title="Re-run discovery to find new high-volume, high-profit traders">
            <RefreshCcw className={refreshing ? "size-3 animate-spin" : "size-3"} />
            {refreshing ? "Refreshing..." : "Refresh traders"}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-2 text-sm">
          <div className={cn(rowGrid, headerClass)}>
            <div>Trader</div>
            <div>Source</div>
            <div className="text-right">Weekly P&amp;L</div>
            <div className="text-right">Volume</div>
            <div className="text-right">Trades</div>
            <div className="text-right">Copy P&amp;L</div>
            <div className="text-right">Last trade</div>
            <div className="text-right">Actions</div>
          </div>
          {traders.length === 0 && (
            <div className="rounded-md border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
              Start the bot or add a wallet to populate followed traders.
            </div>
          )}
          {traders.map((trader) => (
            <div key={trader.wallet} className={cn(rowGrid, "rounded-md border border-border/70 p-3 md:rounded-none md:border-x-0 md:border-b md:border-t-0 md:p-0 md:py-2")}>
              <div className="min-w-0">
                <div className="truncate font-medium" title={trader.name}>{trader.name}</div>
                <div className="truncate text-xs text-muted-foreground">{shortWallet(trader.wallet)}</div>
              </div>
              <div className="mt-2 md:mt-0">
                <span className={cellLabel}>Source</span>
                <Badge variant={trader.source === "manual" ? "default" : "muted"}>
                  {trader.discoverySource ?? trader.source}
                </Badge>
                {trader.discoveryScore != null && (
                  <span className="ml-1 text-[11px] text-muted-foreground" title="Discovery v2 composite rank score (0-100)">
                    {trader.discoveryScore.toFixed(0)}
                  </span>
                )}
                {trader.autoDisabled && (
                  <Badge variant="destructive" className="ml-1" title={trader.autoDisableReason ?? undefined}>auto-disabled</Badge>
                )}
                {!trader.autoDisabled && trader.underReview && (
                  <Badge variant="warning" className="ml-1" title={trader.reviewReason ?? trader.copyScore?.reviewReason ?? undefined}>under review</Badge>
                )}
              </div>
              <div className={cn("mt-2 flex justify-between gap-2 tabular-nums md:mt-0 md:block md:text-right", trader.weeklyPnlUsd >= 0 ? "text-success" : "text-destructive")}>
                <span className={cellLabel}>Weekly P&amp;L</span>
                <span title={signedMoney(trader.weeklyPnlUsd)}>{compactMoney(trader.weeklyPnlUsd)}</span>
              </div>
              <div className="mt-2 flex justify-between gap-2 tabular-nums md:mt-0 md:block md:text-right">
                <span className={cellLabel}>Volume</span>
                <span title={money(trader.weeklyVolumeUsd, 0)}>{compactMoney(trader.weeklyVolumeUsd)}</span>
              </div>
              <div className="mt-2 flex justify-between gap-2 tabular-nums md:mt-0 md:block md:text-right">
                <span className={cellLabel}>Trades</span>
                <span>{trader.weeklyTradeCount}</span>
              </div>
              <div className={cn("mt-2 flex justify-between gap-2 tabular-nums md:mt-0 md:block md:text-right", trader.copiedSimPnlUsd >= 0 ? "text-success" : "text-destructive")}>
                <span className={cellLabel}>Copy P&amp;L</span>
                <span title={signedMoney(trader.copiedSimPnlUsd)}>{compactMoney(trader.copiedSimPnlUsd)}</span>
              </div>
              <div className="mt-2 flex justify-between gap-2 text-xs text-muted-foreground md:mt-0 md:block md:text-right" title={dateTime(trader.lastTradeAt)}>
                <span className={cellLabel}>Last trade</span>
                <span>{friendlyTradeTime(trader.lastTradeAt, now)}</span>
              </div>
              <div className="mt-3 flex items-center justify-start gap-1 md:mt-0 md:justify-end">
                <Button
                  size="sm"
                  className="h-7 px-2"
                  variant={trader.enabled ? "outline" : "success"}
                  onClick={() => onToggle(trader.wallet, !trader.enabled)}
                >
                  {trader.enabled ? "Disable" : "Enable"}
                </Button>
                <Button size="icon" variant="ghost" className="size-7" onClick={() => onRemove(trader.wallet)} aria-label={`Remove ${trader.name}`}>
                  <Trash2 className="size-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
function LeaderHoldsCell({ position }: { position: BotPosition }) {
  // Manual/unknown positions (no source wallet) are not leader-tracked.
  if (position.sourceWallets.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
  const status = position.leaderHolds;
  if (status === "no") return <Badge variant="warning" title="The source leader appears to have exited; consider closing.">leader exited</Badge>;
  if (status === "yes") return <span className="text-xs text-success">yes</span>;
  return <span className="text-xs text-muted-foreground">unknown</span>;
}

function PositionRow({ position, equity }: { position: BotPosition; equity: number }) {
  const animatedMark = useAnimatedNumber(position.markPrice);
  const markPulse = useValuePulse(position.markPrice);
  const exposure = position.shares * animatedMark;
  const costBasis = position.shares * position.avgPrice;
  const unrealized = (animatedMark - position.avgPrice) * position.shares;
  const unrealizedPct = position.avgPrice > 0 ? (animatedMark - position.avgPrice) / position.avgPrice : 0;
  const up = unrealized > 0;
  const down = unrealized < 0;
  const leaderExited = position.sourceWallets.length > 0 && position.leaderHolds === "no";

  return (
    <tr className={cn("border-b border-border/70 transition-colors hover:bg-muted/25", leaderExited && "bg-warning/5")}>
      <td className="max-w-[360px] truncate py-2 pr-3" title={position.marketTitle}>{position.marketTitle}</td>
      <td className="py-2 pr-3">{position.outcome}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{position.shares.toFixed(2)}</td>
      <td className="py-2 pr-3 text-right tabular-nums">{(position.avgPrice * 100).toFixed(1)}c</td>
      <td className="py-2 pr-3 text-right tabular-nums">
        <span className={cn("inline-flex items-center justify-end rounded px-1 transition-colors value-blink-contained min-w-[6ch]", pulseClass(markPulse.direction))}>
          <span className={cn(markPulse.direction === "up" && "value-glow-up", markPulse.direction === "down" && "value-glow-down")}>
            {(animatedMark * 100).toFixed(1)}c
          </span>
        </span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{money(costBasis)}</td>
      <td className={cn("py-2 pr-3 text-right tabular-nums", up && "text-success", down && "text-destructive", !up && !down && "text-muted-foreground")}>
        <span className="inline-flex min-h-5 items-center justify-end gap-1">
          <TrendIcon value={unrealized} size={13} />
          <span className="min-w-[9ch] tabular-nums">{signedMoney(unrealized)}</span>
          <span className="text-[11px] opacity-70">({percent(unrealizedPct)})</span>
        </span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">
        <span className="min-w-[8ch] tabular-nums">{money(exposure)}</span>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums">{percent(equity > 0 ? exposure / equity : 0)}</td>
      <td className="py-2 text-right"><LeaderHoldsCell position={position} /></td>
    </tr>
  );
}

function PositionTable({ positions, equity }: { positions: BotPosition[]; equity: number }) {
  const now = useNow(1000);
  const lastMarkAt = positions.length ? Math.max(...positions.map((p) => p.updatedAt)) : null;
  const totalUnrealized = positions.reduce((sum, p) => sum + (p.markPrice - p.avgPrice) * p.shares, 0);
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Open Positions</CardTitle>
            <CardDescription>Live Polymarket marks - refreshed each poll and via &ldquo;Update prices.&rdquo;</CardDescription>
          </div>
          {positions.length > 0 && (
            <div className="text-right text-xs">
              <div className={cn("font-semibold tabular-nums", totalUnrealized > 0 ? "text-success" : totalUnrealized < 0 ? "text-destructive" : "text-muted-foreground")}>
                <BlinkValue value={totalUnrealized} showIcon={false}>{signedMoney(totalUnrealized)} unrealized</BlinkValue>
              </div>
              <div className="text-muted-foreground">marks updated {relPast(lastMarkAt, now)}</div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto scrollbar-thin">
          <table className="w-full min-w-[960px] text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3">Outcome</th>
                <th className="py-2 pr-3 text-right">Shares</th>
                <th className="py-2 pr-3 text-right">Avg</th>
                <th className="py-2 pr-3 text-right">Mark</th>
                <th className="py-2 pr-3 text-right" title="Remaining cost basis (shares × avg entry)">Cost basis</th>
                <th className="py-2 pr-3 text-right">Unrealized P&L</th>
                <th className="py-2 pr-3 text-right">Exposure</th>
                <th className="py-2 pr-3 text-right">Bankroll risk</th>
                <th className="py-2 text-right" title="Does the source leader still hold this position?">Leader holds?</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && <tr><td colSpan={10} className="py-8 text-center text-xs text-muted-foreground">No simulated positions yet.</td></tr>}
              {positions.map((position) => (
                <PositionRow key={position.tokenId} position={position} equity={equity} />
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function TradesTable({ trades }: { trades: CopyTradeRecord[] }) {
  const variants: Record<CopyTradeRecord["status"], "success" | "warning" | "destructive" | "muted" | "default"> = {
    simulated: "success",
    copied: "success",
    skipped: "warning",
    failed: "destructive",
    "dry-run": "default",
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Copied / Simulated Trades</CardTitle>
        <CardDescription>Includes simulated fills, dry runs, skips, and failures.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="max-h-[460px] overflow-auto scrollbar-thin">
          <table className="w-full min-w-[1080px] text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Trader</th>
                <th className="py-2 pr-3">Side</th>
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3 text-right" title="Leader's original trade price">Leader</th>
                <th className="py-2 pr-3 text-right" title="Bot's executable BUY price (current ask) at copy time">Bot ask</th>
                <th className="py-2 pr-3 text-right" title="How many cents worse the bot's entry was vs the leader">Adverse</th>
                <th className="py-2 pr-3 text-right">Copy size</th>
                <th className="py-2 text-right">Reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && <tr><td colSpan={10} className="py-8 text-center text-xs text-muted-foreground">No bot trade records yet.</td></tr>}
              {trades.map((trade) => {
                const leaderC = trade.leaderPrice ?? trade.price;
                const adverse = trade.adverseMoveCents;
                return (
                <tr key={trade.id} className="border-b border-border/70 transition-colors hover:bg-muted/25">
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{dateTime(trade.processedAt)}</td>
                  <td className="py-2 pr-3"><Badge variant={variants[trade.status]}>{trade.status}</Badge></td>
                  <td className="py-2 pr-3">{trade.traderName}</td>
                  <td className="py-2 pr-3"><Badge variant={trade.side === "BUY" ? "success" : "warning"}>{trade.side}</Badge></td>
                  <td className="max-w-[320px] truncate py-2 pr-3" title={trade.marketTitle}>{trade.outcome ? `${trade.outcome} / ` : ""}{trade.marketTitle}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{(leaderC * 100).toFixed(1)}c</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">{trade.botExecPrice != null ? `${(trade.botExecPrice * 100).toFixed(1)}c` : "—"}</td>
                  <td className={cn("py-2 pr-3 text-right tabular-nums", adverse != null && adverse > 0.05 && "text-destructive", adverse != null && adverse < -0.05 && "text-success")}>
                    {adverse != null ? `${adverse > 0 ? "+" : ""}${adverse.toFixed(1)}c` : "—"}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(trade.copyAmountUsd)}</td>
                  <td className="max-w-[360px] truncate py-2 text-right text-xs text-muted-foreground" title={trade.reason}>{trade.reason}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ScoreTile({
  label, value, rawValue, format = (n: number) => Math.round(n).toLocaleString(), sub, tone: t,
}: {
  label: string;
  value?: ReactNode;
  rawValue?: number;
  format?: (n: number) => string;
  sub?: ReactNode;
  tone?: "pos" | "neg" | "neutral";
}) {
  const pulse = useValuePulse(rawValue);
  const animated = useAnimatedNumber(rawValue ?? 0);
  const spinner = useSpinner();
  const showArrow = pulse.direction !== null;
  const displayValue = rawValue !== undefined ? format(animated) : value;

  return (
    <div className={cn("rounded-md border border-border bg-background/40 p-2.5 transition-colors value-blink-contained", pulseClass(pulse.direction))}>
      <div className="eyebrow whitespace-nowrap text-[10px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 flex items-center text-sm font-semibold tabular-nums",
          !pulse.direction && t === "pos" && "text-success",
          !pulse.direction && t === "neg" && "text-destructive",
          pulse.direction === "up" && "text-success",
          pulse.direction === "down" && "text-destructive",
        )}
      >
        {rawValue !== undefined && (
          <span className="mr-0.5 flex w-[14px] shrink-0 items-center">
            {showArrow ? (
              <span className="animate-in zoom-in-50 duration-150">
                <TrendIcon value={pulse.delta} size={11} />
              </span>
            ) : (
              <span className="select-none text-[9px] text-muted-foreground/40">{spinner}</span>
            )}
          </span>
        )}
        <span className={cn(
          pulse.direction === "up" && "value-glow-up",
          pulse.direction === "down" && "value-glow-down",
        )}>
          {displayValue}
        </span>
      </div>
      {sub != null && <div className="mt-0.5 text-[11px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Scoreboard({ scoreboard }: { scoreboard: SessionScoreboard }) {
  const now = useNow(1000);
  const totalPnl = scoreboard.realizedPnlUsd + scoreboard.unrealizedPnlUsd;
  // Keep runtime ticking live while a session is active.
  const runtimeMs = scoreboard.startedAt ? Math.max(scoreboard.runtimeMs, now - scoreboard.startedAt) : scoreboard.runtimeMs;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center justify-between gap-2">
          <span>Session Scoreboard</span>
          <span className="flex items-center gap-2">
            <Badge variant="secondary">{scoreboard.presetLabel}</Badge>
            <Badge variant="muted">{formatDuration(runtimeMs)} runtime</Badge>
          </span>
        </CardTitle>
        <CardDescription>
          Live session summary. Counters reset each time the bot is started. Active thresholds:{" "}
          {`buy ${cents(scoreboard.activeRiskValues.minBuyTokenPrice)}-${cents(scoreboard.activeRiskValues.maxBuyTokenPrice)}`}
          {`, resolves > ${scoreboard.activeRiskValues.minTimeToResolutionMinutes} min`}
          {`, exposure ${scoreboard.activeRiskValues.maxExposurePerMarketPercent}% / market - ${scoreboard.activeRiskValues.maxTotalExposurePercent}% total`}
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          <ScoreTile label="Wallets checked" rawValue={scoreboard.walletsChecked} sub="cumulative this session" />
          <ScoreTile label="Trades scanned" rawValue={scoreboard.tradesScanned} sub="trader trades seen" />
          <ScoreTile label="Copied buys" rawValue={scoreboard.copiedBuys} />
          <ScoreTile label="Copied sells" rawValue={scoreboard.copiedSells} />
          <ScoreTile label="Open positions" rawValue={scoreboard.openPositions} />
          <ScoreTile label="Total exposure" rawValue={scoreboard.totalExposurePercent} format={percent} tone={scoreboard.totalExposurePercent > 0.4 ? "neg" : "neutral"} />
          <ScoreTile label="Realized P&L" rawValue={scoreboard.realizedPnlUsd} format={signedMoney} tone={tone(scoreboard.realizedPnlUsd)} />
          <ScoreTile label="Unrealized P&L" rawValue={scoreboard.unrealizedPnlUsd} format={signedMoney} tone={tone(scoreboard.unrealizedPnlUsd)} />
          <ScoreTile label="Current equity" rawValue={scoreboard.currentEquityUsd} format={money} sub={`${signedMoney(totalPnl)} total P&L`} />
          <ScoreTile label="ROI" rawValue={scoreboard.roi} format={percent} tone={tone(scoreboard.roi)} />
          <ScoreTile label="Max drawdown" rawValue={scoreboard.maxDrawdown} format={percent} tone={scoreboard.maxDrawdown > 0 ? "neg" : "neutral"} />
          <ScoreTile label="Avg entry / exit" value={`${cents(scoreboard.averageEntryPrice)} / ${cents(scoreboard.averageExitPrice)}`} />
          <ScoreTile
            label="Best wallet"
            value={scoreboard.bestWallet ? shortWallet(scoreboard.bestWallet.wallet) : "-"}
            sub={scoreboard.bestWallet ? `${scoreboard.bestWallet.name} - ${signedMoney(scoreboard.bestWallet.realizedPnlUsd)}` : "no closed trades"}
            tone={scoreboard.bestWallet ? tone(scoreboard.bestWallet.realizedPnlUsd) : "neutral"}
          />
          <ScoreTile
            label="Worst wallet"
            value={scoreboard.worstWallet ? shortWallet(scoreboard.worstWallet.wallet) : "-"}
            sub={scoreboard.worstWallet ? `${scoreboard.worstWallet.name} - ${signedMoney(scoreboard.worstWallet.realizedPnlUsd)}` : "no closed trades"}
            tone={scoreboard.worstWallet ? tone(scoreboard.worstWallet.realizedPnlUsd) : "neutral"}
          />
        </div>

        <div>
          <div className="eyebrow mb-1.5 text-[10px] text-muted-foreground">Copied trades by wallet</div>
          {scoreboard.copiedTradesByWallet.length === 0 ? (
            <div className="rounded-md border border-border bg-background/40 px-2.5 py-2 text-xs text-muted-foreground">No copied trades yet.</div>
          ) : (
            <div className="max-h-[200px] overflow-auto scrollbar-thin pr-1">
              <table className="w-full text-xs">
                <thead className="text-[10px] text-muted-foreground">
                  <tr className="border-b border-border text-left">
                    <th className="py-1 pr-2">Wallet</th>
                    <th className="py-1 pr-2 text-right">Copies</th>
                    <th className="py-1 pr-2 text-right">B / S</th>
                    <th className="py-1 pr-2 text-right">Exposure</th>
                    <th className="py-1 text-right">Realized P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {scoreboard.copiedTradesByWallet.map((wallet: WalletCopyStat) => (
                    <tr key={wallet.wallet} className="border-b border-border/60">
                      <td className="max-w-[180px] truncate py-1 pr-2" title={`${wallet.name} - ${wallet.wallet}`}>
                        <span className="font-medium">{wallet.name}</span>
                        <span className="ml-1 text-muted-foreground">{shortWallet(wallet.wallet)}</span>
                      </td>
                      <td className="py-1 pr-2 text-right tabular-nums">{wallet.copiedTrades}</td>
                      <td className="py-1 pr-2 text-right tabular-nums text-muted-foreground">{wallet.buys}/{wallet.sells}</td>
                      <td className="py-1 pr-2 text-right tabular-nums">{money(wallet.exposureUsd)} <span className="text-muted-foreground">({percent(wallet.exposurePercent)})</span></td>
                      <td className={cn("py-1 text-right tabular-nums", wallet.realizedPnlUsd > 0 ? "text-success" : wallet.realizedPnlUsd < 0 ? "text-destructive" : "text-muted-foreground")}>{signedMoney(wallet.realizedPnlUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div>
          <div className="eyebrow mb-1.5 text-[10px] text-muted-foreground">Skips grouped by reason</div>
          {scoreboard.skipsByReason.length === 0 ? (
            <div className="rounded-md border border-border bg-background/40 px-2.5 py-2 text-xs text-muted-foreground">No skipped trades yet.</div>
          ) : (
            <div className="max-h-[180px] space-y-1 overflow-auto scrollbar-thin pr-1">
              {scoreboard.skipsByReason.map((skip) => (
                <div key={skip.reason} className="flex items-start gap-2 rounded-md border border-border bg-background/40 px-2.5 py-1.5 text-xs">
                  <Badge variant="muted" className="shrink-0 tabular-nums">x{skip.count}</Badge>
                  <span className="leading-relaxed text-muted-foreground">{skip.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function LogPanel({ logs }: { logs: BotLogEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          <span>Debug Log</span>
          <Button size="sm" variant="ghost" onClick={() => setOpen((value) => !value)}>
            {open ? "Hide raw logs" : `Show raw logs (${logs.length})`}
          </Button>
        </CardTitle>
        <CardDescription>Full, unaggregated bot events: skipped trades, failures, and loop errors.</CardDescription>
      </CardHeader>
      {open && (
        <CardContent>
          <div className="max-h-[360px] space-y-2 overflow-auto scrollbar-thin pr-1 text-xs">
            {logs.length === 0 && <div className="py-6 text-center text-muted-foreground">No logs yet.</div>}
            {logs.map((log) => (
              <div key={log.id} className="rounded-md border border-border bg-background/50 p-2">
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={log.level === "error" ? "destructive" : log.level === "warning" ? "warning" : "muted"}>{log.level}</Badge>
                  <span className="text-muted-foreground">{dateTime(log.ts)}</span>
                </div>
                <div className="mt-1 text-muted-foreground">{log.message}</div>
              </div>
            ))}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function AddTrader({ onAdd }: { onAdd: (wallet: string) => Promise<void> }) {
  const [wallet, setWallet] = useState("");
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Manual Wallet</CardTitle>
        <CardDescription>Add a trader wallet without waiting for discovery.</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!wallet.trim()) return;
            setAdding(true);
            try {
              await onAdd(wallet.trim());
              setWallet("");
            } finally {
              setAdding(false);
            }
          }}
        >
          <Input placeholder="0x..." value={wallet} onChange={(event) => setWallet(event.target.value)} />
          <Button type="submit" disabled={adding}><Plus className="size-4" /> Add</Button>
        </form>
      </CardContent>
    </Card>
  );
}

function BotStatusCard({ status }: { status: BotStatus }) {
  const now = useNow(1000);
  const { state, metrics } = status;
  const running = state.runState === "running";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bot Status</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last poll</span>
          <span className="tabular-nums" title={dateTime(state.lastPollAt)}>{relPast(state.lastPollAt, now)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Next poll</span>
          <span className="tabular-nums" title={dateTime(state.nextPollAt)}>{running ? relFuture(state.nextPollAt, now) : "-"}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last discovery</span>
          <span className="tabular-nums" title={dateTime(state.lastDiscoveryAt)}>{relPast(state.lastDiscoveryAt, now)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Seen bootstrap</span>
          <span>{dateTime(state.firstRunBootstrappedAt)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Failed / skipped</span>
          <span>{metrics.failedTrades} / {metrics.skippedTrades}</span>
        </div>
        {status.settings.mode === "real" && (
          <>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Live cash</span>
              <span className="tabular-nums">{metrics.liveUsdcBalance == null ? "-" : money(metrics.liveUsdcBalance)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Local mirror equity</span>
              <span className="tabular-nums">{money(metrics.localTrackedEquity)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Equity diff</span>
              <span className="tabular-nums">{metrics.balanceDifference == null ? "-" : signedMoney(metrics.balanceDifference)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Live check</span>
              <span className="tabular-nums" title={dateTime(metrics.lastLiveBalanceCheck)}>{dateTime(metrics.lastLiveBalanceCheck)}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function Dashboard() {
  const { data: status, error, isLoading, mutate } = useSWR<BotStatus>("/api/bot/status", jsonFetcher, {
    refreshInterval: 2000,
    revalidateOnFocus: true,
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);

  const runAction = async (name: string, url: string, body?: unknown) => {
    setBusy(name);
    setActionError(null);
    try {
      await postJson<BotStatus>(url, body);
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(null);
    }
  };

  const totalPnl = useMemo(() => {
    if (!status) return 0;
    return status.metrics.realizedPnlUsd + status.metrics.unrealizedPnlUsd;
  }, [status]);

  // Session-only mode: auto-liquidate when the dashboard window/tab is closed so
  // no unsettled simulated positions are left behind. sendBeacon survives unload.
  const sessionOnly = status?.settings.sessionOnly;
  const lifecycleActive = status?.state.runState === "running" || status?.state.runState === "draining";
  useEffect(() => {
    if (!sessionOnly || !lifecycleActive) return;
    const onHide = () => {
      try {
        const blob = new Blob([JSON.stringify({ liquidate: true, source: "session-close" })], {
          type: "application/json",
        });
        navigator.sendBeacon("/api/bot/stop", blob);
      } catch {
        // Best effort - nothing we can do if the beacon is rejected on unload.
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [sessionOnly, lifecycleActive]);

  // Stop always liquidates: sell every open position at current mark price, then stop.
  const handleStopClick = () => {
    void runAction("stop", "/api/bot/stop", { liquidate: true, source: "session-close" });
  };

  if (isLoading && !status) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading copy bot dashboard...</div>;
  }

  if (!status) {
    return (
      <div className="mx-auto max-w-4xl p-6">
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle>Dashboard unavailable</CardTitle>
            <CardDescription>{error instanceof Error ? error.message : "Failed to load bot status."}</CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 lg:p-6">
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="eyebrow flex items-center gap-2">
            {status.state.runState === "running" ? (
              <>
                <span className="live-dot inline-block size-2 rounded-full bg-success" />
                Live - polling
              </>
            ) : (
              <>
                <span className="inline-block size-2 rounded-full bg-muted-foreground/50" />
                {status.state.runState}
              </>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            <Bot className="size-6 text-primary" />
            <h1 className="text-2xl font-bold tracking-tight text-foreground">Polymarket Copy Bot</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">Private local dashboard. Simulation is default; real trading stays behind server-side guards.</p>
          <Link href="/recovery" className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-muted/40">
            <Wallet className="size-3" /> Portfolio Recovery
          </Link>
        </div>
        <div className="flex flex-col items-start gap-3 md:items-end">
          <StatusBadge status={status} />
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground" title="Auto-liquidate open positions when the bot stops or the window is closed.">
              <Switch
                checked={status.settings.sessionOnly}
                onCheckedChange={(value) => void runAction("settings", "/api/settings", { sessionOnly: value })}
                disabled={busy !== null}
                aria-label="Session-only mode"
              />
              Session-only
            </label>
            <Button size="sm" onClick={() => runAction("start", "/api/bot/start")} disabled={busy !== null || status.state.runState === "running" || status.state.runState === "draining"}><Play className="size-3" /> Start</Button>
            <Button size="sm" variant="outline" onClick={() => runAction("pause", "/api/bot/pause")} disabled={busy !== null || status.state.runState !== "running"}><Pause className="size-3" /> Pause</Button>
            <Button size="sm" variant="outline" onClick={handleStopClick} disabled={busy !== null || status.state.runState === "stopped"}><Square className="size-3" /> Stop</Button>
            <Button size="sm" variant="outline" onClick={() => runAction("marks", "/api/bot/marks")} disabled={busy !== null || status.positions.length === 0} title="Pull live Polymarket prices for your open positions now."><Activity className="size-3" /> {busy === "marks" ? "Updating..." : "Update prices"}</Button>
            <Button size="sm" variant="ghost" onClick={() => mutate()}><RefreshCcw className="size-3" /> Refresh</Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setResetOpen(true)} disabled={busy !== null} title="Clear positions, trades, and P&L back to the starting balance."><RotateCcw className="size-3" /> Reset</Button>
            {status.metrics.panic ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => runAction("resume", "/api/bot/panic", { resume: true })}
                disabled={busy !== null}
                title="Clear the panic stop. The bot stays stopped until you click Start."
              >
                <ShieldCheck className="size-3" /> Resume
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => runAction("panic", "/api/bot/panic")}
                disabled={busy !== null}
                title="Emergency stop: halt the loop and block all new BUYs. Persisted across restarts."
              >
                <OctagonX className="size-3" /> Panic stop
              </Button>
            )}
          </div>
        </div>
      </header>

      {error && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" />
          <span>Latest refresh failed: {error instanceof Error ? error.message : "Failed to refresh bot status."}</span>
        </div>
      )}
      {status.metrics.panic && (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <OctagonX className="size-4 shrink-0" />
          <span>{status.metrics.panicReason ?? "Panic stop engaged."} New BUYs are disabled until you Resume and Start.</span>
        </div>
      )}
      {!status.metrics.panic && status.metrics.dailyLossLockout && (
        <div className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-4 shrink-0" />
          <span>{status.metrics.dailyLossLockoutReason ?? "Daily loss lockout active. New BUYs are disabled until the next day."}</span>
        </div>
      )}
      {!status.metrics.panic &&
        !status.metrics.dailyLossLockout &&
        !status.buyReadiness.buysAllowed &&
        status.buyReadiness.blockers.length > 0 && (
          <div className="flex items-start gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm text-amber-600 dark:text-amber-400">
            <AlertTriangle className="size-4 shrink-0 translate-y-0.5" />
            <div>
              <span className="font-medium">New BUYs are blocked.</span>
              <ul className="mt-0.5 list-disc pl-4 text-xs">
                {status.buyReadiness.blockers.map((b) => (
                  <li key={b.code}>{b.detail}</li>
                ))}
              </ul>
            </div>
          </div>
        )}

      <Dialog
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="Reset simulation?"
        description="Clears all open positions, trade history, and the equity curve, and sets your bankroll back to the starting balance. Followed traders and settings are kept. This cannot be undone."
      >
        <div className="flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setResetOpen(false)} disabled={busy !== null}>Cancel</Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy !== null}
            onClick={async () => {
              setResetOpen(false);
              await runAction("reset", "/api/bot/reset");
            }}
          >
            <RotateCcw className="size-3" /> Reset simulation
          </Button>
        </div>
      </Dialog>

      {(status.settings.mode === "real" || status.realTradingEnabled) && (
        <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div>
            Real trading controls are dangerous. The app refuses real mode unless ENABLE_REAL_TRADING=true, reads live cash before sizing, and caps every BUY with LIVE_MAX_ORDER_USD.
          </div>
        </div>
      )}

      {!status.bullpen.available && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          Bullpen CLI was not detected with <span className="font-mono">bullpen --help</span>. Simulation mode remains fully functional.
        </div>
      )}

      {actionError && <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{actionError}</div>}
      {status.metrics.buyExposurePaused && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          Exposure paused: BUY trades are being observed but not processed until total exposure falls below {status.settings.maxTotalExposurePercent}%.
        </div>
      )}
      {status.settings.mode === "real" && (status.metrics.liveBalanceStatus === "warning" || status.metrics.liveBalanceStatus === "error") && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          Live balance {status.metrics.liveBalanceStatus}: {status.metrics.liveBalanceError ?? "live equity differs from local mirror equity by " + signedMoney(status.metrics.balanceDifference ?? 0)}. Local P&amp;L history was not changed.
        </div>
      )}
      {status.state.runState === "draining" && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
          <span>
            Auto-exit mode: holding {status.positions.length} position{status.positions.length === 1 ? "" : "s"} and selling on
            {" "}
            TP {status.settings.autoExitTakeProfitPercent || "off"}% / SL {status.settings.autoExitStopLossPercent || "off"}% / max-hold {status.settings.autoExitMaxHoldMinutes || "off"}m. No new entries.
          </span>
          <Button size="sm" variant="outline" onClick={() => runAction("flatten", "/api/bot/stop", { liquidate: true, source: "auto-exit" })} disabled={busy !== null}>
            Sell all now
          </Button>
        </div>
      )}
      {status.state.runState === "running" && status.metrics.totalTrades === 0 && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 text-sm text-primary animate-in fade-in-0 slide-in-from-top-1 duration-300">
          Bot is polling {status.traders.filter((trader) => trader.enabled).length} enabled traders. Existing trades were marked as seen on startup, so it will only simulate-copy fresh trades detected after the bot started.
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-9">
        {status.settings.mode === "real" && (
          <StatCard
            label="Live cash"
            rawValue={status.metrics.liveUsdcBalance ?? 0}
            format={money}
            value={status.metrics.liveUsdcBalance == null ? "-" : money(status.metrics.liveUsdcBalance)}
            sub={status.metrics.balanceDifference == null ? "wallet cash" : "equity diff " + signedMoney(status.metrics.balanceDifference)}
            tone={status.metrics.liveBalanceStatus === "error" || status.metrics.liveBalanceStatus === "warning" ? "neg" : "neutral"}
          />
        )}
        <StatCard label="Current equity" rawValue={status.metrics.equityUsd} format={money} sub={`${signedMoney(totalPnl)} total P&L | ${percent(status.metrics.roi)} ROI`} />
        <StatCard label="Cash" rawValue={status.metrics.cashUsd} format={money} sub={status.settings.mode === "real" ? "live wallet cash" : "local accounting cash"} />
        <StatCard label="Exposure" rawValue={status.metrics.totalExposureUsd} format={money} sub={`cost basis ${money(status.metrics.totalOpenCostBasisUsd)}`} />
        <StatCard label="Realized P&L" rawValue={status.metrics.realizedPnlUsd} format={signedMoney} tone={tone(status.metrics.realizedPnlUsd)} arrow={status.metrics.realizedPnlUsd} />
        <StatCard label="Unrealized P&L" rawValue={status.metrics.unrealizedPnlUsd} format={signedMoney} tone={tone(status.metrics.unrealizedPnlUsd)} arrow={status.metrics.unrealizedPnlUsd} />
        <StatCard label="Next trade size" rawValue={status.metrics.nextTradeSizeUsd} format={money} sub={`${status.settings.percentageCopySize}% sizing mode`} />
        <StatCard label="Win rate" value={percent(status.metrics.winRate, 0)} sub={`${status.metrics.winners}W / ${status.metrics.losers}L`} />
        <StatCard label="Bankroll at risk" rawValue={status.metrics.totalExposurePercent} format={percent} sub={`${money(status.metrics.totalExposureUsd)} / ${money(status.metrics.equityUsd)} equity`} tone={status.metrics.totalExposurePercent > 0.4 ? "neg" : "neutral"} />
        <StatCard label="Cost drag" rawValue={status.metrics.totalFrictionUsd} format={money} sub={`incl. ${money(status.metrics.totalFeesUsd)} fees${status.settings.realisticFills ? "" : " - idealized"}`} tone={status.metrics.totalFrictionUsd > 0 ? "neg" : "neutral"} />
      </div>
      <Scoreboard scoreboard={status.scoreboard} />

      <DashboardVisuals status={status} totalPnl={totalPnl} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <PositionTable positions={status.positions} equity={status.metrics.equityUsd} />
          <TraderTable
            traders={status.traders}
            onToggle={(wallet, enabled) => void runAction("toggle", "/api/traders/toggle", { wallet, enabled })}
            onRemove={(wallet) => void runAction("remove", "/api/traders/remove", { wallet })}
            onRefresh={() => void runAction("discover", "/api/bot/discover")}
            refreshing={busy === "discover"}
          />
          <TradesTable trades={status.recentTrades} />
        </div>
        <div className="space-y-4">
          <AddTrader onAdd={async (wallet) => runAction("add", "/api/traders/add", { wallet })} />
          <BotStatusCard status={status} />
          <SettingsPanel status={status} onSave={async (settings) => runAction("settings", "/api/settings", settings)} />
          <LogPanel logs={status.logs} />
        </div>
      </div>

      <footer className="pt-2 text-center text-[11px] text-muted-foreground">
        Local simulation dashboard. No private keys are exposed to the frontend or stored in localStorage.
      </footer>
    </div>
  );
}






