"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { Activity, AlertTriangle, Bot, Coins, DollarSign, Hand, OctagonX, Pause, Play, Plus, RefreshCcw, RotateCcw, ShieldCheck, Square, Timer, Trash2, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { TrendIcon } from "@/components/ui/trend-icon";
import { RISK_PRESETS, type RiskPreset } from "@/lib/copybot/riskPresets";
import { DashboardVisuals } from "./DashboardVisuals";
import { cn } from "@/lib/utils";
import { fromNow } from "@/lib/time";
import type { BotLogEntry, BotPosition, BotSettings, BotStatus, CopyTradeRecord, FollowedTrader, RedeemRunResult, RedeemablePlan, RiskPresetId, SessionScoreboard, WalletCopyStat } from "@/lib/copybot/types";

type ApiEnvelope<T> = { ok: true; data: T; fetchedAt: number } | { ok: false; error: string };

async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.ok ? "Request failed" : json.error);
  return json.data;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok) throw new Error(json.ok ? "Request failed" : json.error);
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
}: {
  value: number | null | undefined;
  children: ReactNode;
  className?: string;
  showIcon?: boolean;
}) {
  const pulse = useValuePulse(value);
  return (
    <span className={cn("inline-flex items-center justify-end gap-1 rounded px-1 transition-colors", pulseClass(pulse.direction), className)}>
      {showIcon && pulse.direction && <TrendIcon value={pulse.delta} size={13} />}
      {children}
    </span>
  );
}

function StatCard({
  label,
  value,
  sub,
  tone: statTone = "neutral",
  arrow,
  pulseValue,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "pos" | "neg" | "neutral";
  arrow?: number;
  pulseValue?: number | null;
}) {
  const pulse = useValuePulse(pulseValue);
  const trendValue = pulse.direction ? pulse.delta : arrow;
  return (
    <Card className={cn("p-4 transition-colors", pulseClass(pulse.direction))}>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 flex items-center gap-1 rounded text-xl font-semibold tabular-nums transition-colors",
          statTone === "pos" && "text-success",
          statTone === "neg" && "text-destructive",
          pulse.direction === "up" && "text-success",
          pulse.direction === "down" && "text-destructive",
        )}
      >
        {trendValue !== undefined && trendValue !== 0 && <TrendIcon value={trendValue} size={18} />}
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </Card>
  );
}
function StatusBadge({ status }: { status: BotStatus }) {
  const runState = status.state.runState;
  const variant =
    runState === "running" ? "success" : runState === "paused" || runState === "draining" ? "warning" : "muted";
  const label = runState === "draining" ? "draining · exit-only" : runState;
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

/**
 * Shown when Stop is clicked while copied positions are still open. Offers the
 * three exit paths instead of silently leaving simulated positions behind.
 */
function StopDialog({
  open,
  onOpenChange,
  status,
  busy,
  onSellAll,
  onKeep,
  onAutoExit,
}: {
  open: boolean;
  onOpenChange: (value: boolean) => void;
  status: BotStatus;
  busy: string | null;
  onSellAll: () => void;
  onKeep: () => void;
  onAutoExit: (rules: {
    autoExitTakeProfitPercent: number;
    autoExitStopLossPercent: number;
    autoExitMaxHoldMinutes: number;
  }) => void;
}) {
  const sessionOnly = status.settings.sessionOnly;
  const openCount = status.positions.length;
  const [showRules, setShowRules] = useState(false);
  const [tp, setTp] = useState(status.settings.autoExitTakeProfitPercent || 20);
  const [sl, setSl] = useState(status.settings.autoExitStopLossPercent || 15);
  const [hold, setHold] = useState(status.settings.autoExitMaxHoldMinutes || 30);

  useEffect(() => {
    if (open) setShowRules(false);
  }, [open]);

  const working = busy !== null;
  const noRules = tp <= 0 && sl <= 0 && hold <= 0;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`You have ${openCount} open copied position${openCount === 1 ? "" : "s"}.`}
      description={`${money(status.metrics.totalExposureUsd)} exposure · ${signedMoney(status.metrics.unrealizedPnlUsd)} unrealized. Choose how to handle them before the bot stops.`}
    >
      <div className="space-y-2">
        <button
          type="button"
          disabled={working}
          onClick={onSellAll}
          className={cn(
            "flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors disabled:opacity-50",
            sessionOnly ? "border-primary/60 bg-primary/10 hover:bg-primary/15" : "border-border hover:bg-muted/40",
          )}
        >
          <DollarSign className="mt-0.5 size-4 shrink-0 text-primary" />
          <div>
            <div className="flex items-center gap-2 text-sm font-medium">
              Sell all now
              <Badge variant="success">recommended</Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              Flatten every position at its current mark price, realize the P&amp;L, then stop.
            </div>
          </div>
        </button>

        <button
          type="button"
          disabled={working}
          onClick={onKeep}
          className="flex w-full items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors hover:bg-muted/40 disabled:opacity-50"
        >
          <Hand className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <div className="text-sm font-medium">Keep positions manually</div>
            <div className="text-xs text-muted-foreground">
              Stop listening but leave open positions untouched. You manage exits yourself.
            </div>
          </div>
        </button>

        <div
          className={cn(
            "rounded-lg border transition-colors",
            showRules ? "border-primary/50 bg-muted/30" : "border-border hover:bg-muted/40",
          )}
        >
          <button
            type="button"
            disabled={working}
            onClick={() => setShowRules((v) => !v)}
            className="flex w-full items-start gap-3 p-3 text-left disabled:opacity-50"
          >
            <Timer className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <div className="text-sm font-medium">Set auto-exit rules</div>
              <div className="text-xs text-muted-foreground">
                Keep monitoring (no new entries) and auto-sell each position on take-profit, stop-loss, or max hold.
              </div>
            </div>
          </button>

          {showRules && (
            <div className="space-y-3 border-t border-border/70 p-3">
              <div className="grid grid-cols-3 gap-2">
                <NumberField label="Take-profit %" value={tp} step={1} onChange={setTp} />
                <NumberField label="Stop-loss %" value={sl} step={1} onChange={setSl} />
                <NumberField label="Max hold (min)" value={hold} step={5} onChange={setHold} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Set a field to 0 to disable that rule. At least one rule is required, or positions are sold immediately.
              </p>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  disabled={working || noRules}
                  onClick={() =>
                    onAutoExit({
                      autoExitTakeProfitPercent: tp,
                      autoExitStopLossPercent: sl,
                      autoExitMaxHoldMinutes: hold,
                    })
                  }
                >
                  Start auto-exit
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
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

  const update = <K extends keyof BotSettings>(key: K, value: BotSettings[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const applyRiskPreset = (presetId: RiskPresetId) => {
    const preset: RiskPreset = RISK_PRESETS[presetId];
    setDraft((current) =>
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
    setDraft((current) => ({ ...current, riskPreset: "custom", [key]: value }));
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
          <NumberField label="Fixed copy amount ($)" value={draft.fixedCopyAmountUsd} step={0.25} onChange={(value) => update("fixedCopyAmountUsd", value)} />
          <NumberField label="Percentage copy size (%)" value={draft.percentageCopySize} step={0.25} onChange={(value) => update("percentageCopySize", value)} />
          <NumberField label="Minimum trade amount ($)" value={draft.minTradeAmountUsd} step={0.01} onChange={(value) => update("minTradeAmountUsd", value)} />
          <NumberField label="Maximum trade amount ($)" value={draft.maxTradeAmountUsd} step={0.25} onChange={(value) => update("maxTradeAmountUsd", value)} />
          <NumberField label="Per-market exposure cap (%)" value={draft.maxExposurePerMarketPercent} step={0.5} onChange={(value) => updateRiskCap("maxExposurePerMarketPercent", value)} />
          <NumberField label="Total exposure cap (%)" value={draft.maxTotalExposurePercent} step={0.5} onChange={(value) => updateRiskCap("maxTotalExposurePercent", value)} />
          <NumberField label="Daily loss cap (%)" value={draft.maxDailyLossPercent} step={0.5} onChange={(value) => update("maxDailyLossPercent", value)} />
          <NumberField label="Max copies / wallet / cycle" value={draft.maxCopiesPerWalletPerCycle} step={1} min={0} onChange={(value) => update("maxCopiesPerWalletPerCycle", value)} />
          <NumberField label="Per-wallet exposure cap (%)" value={draft.maxExposurePerWalletPercent} step={1} min={0} max={100} onChange={(value) => update("maxExposurePerWalletPercent", value)} />
          <NumberField label="Same wallet/market cooldown (sec)" value={draft.walletTradeCooldownSec} step={15} min={0} onChange={(value) => update("walletTradeCooldownSec", value)} />
          <NumberField label="Starting balance ($)" value={draft.startingBalance} step={1} min={1} onChange={(value) => update("startingBalance", value)} />
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
        <div className="flex justify-end">
          <Button onClick={save} disabled={saving}>{saving ? "Saving..." : "Save settings"}</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function TraderTable({ traders, onToggle, onRemove }: { traders: FollowedTrader[]; onToggle: (wallet: string, enabled: boolean) => void; onRemove: (wallet: string) => void }) {
  const now = useNow(60_000);
  const rowGrid = "md:grid md:grid-cols-[minmax(0,1.6fr)_0.62fr_0.78fr_0.78fr_0.48fr_0.78fr_1.05fr_1.05fr] md:items-center md:gap-2";
  const headerClass = "hidden border-b border-border pb-2 text-xs text-muted-foreground md:grid";
  const cellLabel = "mr-2 text-muted-foreground md:hidden";

  return (
    <Card>
      <CardHeader>
        <CardTitle>Followed Traders</CardTitle>
        <CardDescription>Auto-discovered active weekly traders plus manual wallets.</CardDescription>
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
                  <span className="ml-1 text-[11px] text-muted-foreground" title="Discovery v2 composite rank score (0–100)">
                    {trader.discoveryScore.toFixed(0)}
                  </span>
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
            <CardDescription>Live Polymarket marks — refreshed each poll and via &ldquo;Update prices.&rdquo;</CardDescription>
          </div>
          {positions.length > 0 && (
            <div className="text-right text-xs">
              <div className={cn("font-semibold tabular-nums", totalUnrealized > 0 ? "text-success" : totalUnrealized < 0 ? "text-destructive" : "text-muted-foreground")}>
                <BlinkValue value={totalUnrealized}>{signedMoney(totalUnrealized)} unrealized</BlinkValue>
              </div>
              <div className="text-muted-foreground">marks updated {relPast(lastMarkAt, now)}</div>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        <div className="overflow-auto scrollbar-thin">
          <table className="w-full min-w-[820px] text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3">Outcome</th>
                <th className="py-2 pr-3 text-right">Shares</th>
                <th className="py-2 pr-3 text-right">Avg</th>
                <th className="py-2 pr-3 text-right">Mark</th>
                <th className="py-2 pr-3 text-right">Unrealized P&L</th>
                <th className="py-2 pr-3 text-right">Exposure</th>
                <th className="py-2 text-right">Bankroll risk</th>
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-xs text-muted-foreground">No simulated positions yet.</td></tr>}
              {positions.map((position) => {
                const exposure = position.shares * position.markPrice;
                const unrealized = (position.markPrice - position.avgPrice) * position.shares;
                const unrealizedPct = position.avgPrice > 0 ? (position.markPrice - position.avgPrice) / position.avgPrice : 0;
                const up = unrealized > 0;
                const down = unrealized < 0;
                return (
                  <tr key={position.tokenId} className="border-b border-border/70">
                    <td className="max-w-[360px] truncate py-2 pr-3" title={position.marketTitle}>{position.marketTitle}</td>
                    <td className="py-2 pr-3">{position.outcome}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{position.shares.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{(position.avgPrice * 100).toFixed(1)}c</td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <BlinkValue value={position.markPrice}>{(position.markPrice * 100).toFixed(1)}c</BlinkValue>
                    </td>
                    <td className={cn("py-2 pr-3 text-right tabular-nums", up && "text-success", down && "text-destructive", !up && !down && "text-muted-foreground")}>
                      <span className="inline-flex items-center justify-end gap-1">
                        <TrendIcon value={unrealized} size={13} />
                        <BlinkValue value={unrealized} showIcon={false}>{signedMoney(unrealized)}</BlinkValue>
                        <span className="text-[11px] opacity-70">({percent(unrealizedPct)})</span>
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">
                      <BlinkValue value={exposure}>{money(exposure)}</BlinkValue>
                    </td>
                    <td className="py-2 text-right tabular-nums">{percent(equity > 0 ? exposure / equity : 0)}</td>
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
          <table className="w-full min-w-[940px] text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border text-left">
                <th className="py-2 pr-3">Time</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Trader</th>
                <th className="py-2 pr-3">Side</th>
                <th className="py-2 pr-3">Market</th>
                <th className="py-2 pr-3 text-right">Price</th>
                <th className="py-2 pr-3 text-right">Copy size</th>
                <th className="py-2 text-right">Reason</th>
              </tr>
            </thead>
            <tbody>
              {trades.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-xs text-muted-foreground">No bot trade records yet.</td></tr>}
              {trades.map((trade) => (
                <tr key={trade.id} className="border-b border-border/70">
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{dateTime(trade.processedAt)}</td>
                  <td className="py-2 pr-3"><Badge variant={variants[trade.status]}>{trade.status}</Badge></td>
                  <td className="py-2 pr-3">{trade.traderName}</td>
                  <td className="py-2 pr-3"><Badge variant={trade.side === "BUY" ? "success" : "warning"}>{trade.side}</Badge></td>
                  <td className="max-w-[320px] truncate py-2 pr-3" title={trade.marketTitle}>{trade.outcome ? `${trade.outcome} / ` : ""}{trade.marketTitle}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{(trade.price * 100).toFixed(1)}c</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{money(trade.copyAmountUsd)}</td>
                  <td className="max-w-[360px] truncate py-2 text-right text-xs text-muted-foreground" title={trade.reason}>{trade.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function ScoreTile({ label, value, sub, tone: t }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "pos" | "neg" | "neutral" }) {
  return (
    <div className="rounded-md border border-border bg-background/40 p-2.5">
      <div className="eyebrow text-[10px] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-sm font-semibold tabular-nums",
          t === "pos" && "text-success",
          t === "neg" && "text-destructive",
        )}
      >
        {value}
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
          {`buy ${cents(scoreboard.activeRiskValues.minBuyTokenPrice)}–${cents(scoreboard.activeRiskValues.maxBuyTokenPrice)}`}
          {`, resolves > ${scoreboard.activeRiskValues.minTimeToResolutionMinutes} min`}
          {`, exposure ${scoreboard.activeRiskValues.maxExposurePerMarketPercent}% / market · ${scoreboard.activeRiskValues.maxTotalExposurePercent}% total`}
          .
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          <ScoreTile label="Wallets checked" value={scoreboard.walletsChecked.toLocaleString()} sub="cumulative this session" />
          <ScoreTile label="Trades scanned" value={scoreboard.tradesScanned.toLocaleString()} sub="trader trades seen" />
          <ScoreTile label="Copied buys" value={scoreboard.copiedBuys.toLocaleString()} />
          <ScoreTile label="Copied sells" value={scoreboard.copiedSells.toLocaleString()} />
          <ScoreTile label="Open positions" value={scoreboard.openPositions.toLocaleString()} />
          <ScoreTile label="Total exposure" value={percent(scoreboard.totalExposurePercent)} tone={scoreboard.totalExposurePercent > 0.4 ? "neg" : "neutral"} />
          <ScoreTile label="Realized P&L" value={signedMoney(scoreboard.realizedPnlUsd)} tone={tone(scoreboard.realizedPnlUsd)} />
          <ScoreTile label="Unrealized P&L" value={signedMoney(scoreboard.unrealizedPnlUsd)} tone={tone(scoreboard.unrealizedPnlUsd)} />
          <ScoreTile label="Current equity" value={money(scoreboard.currentEquityUsd)} sub={`${signedMoney(totalPnl)} total P&L`} />
          <ScoreTile label="ROI" value={percent(scoreboard.roi)} tone={tone(scoreboard.roi)} />
          <ScoreTile label="Max drawdown" value={percent(scoreboard.maxDrawdown)} tone={scoreboard.maxDrawdown > 0 ? "neg" : "neutral"} />
          <ScoreTile label="Avg entry / exit" value={`${cents(scoreboard.averageEntryPrice)} / ${cents(scoreboard.averageExitPrice)}`} />
          <ScoreTile
            label="Best wallet"
            value={scoreboard.bestWallet ? shortWallet(scoreboard.bestWallet.wallet) : "-"}
            sub={scoreboard.bestWallet ? `${scoreboard.bestWallet.name} · ${signedMoney(scoreboard.bestWallet.realizedPnlUsd)}` : "no closed trades"}
            tone={scoreboard.bestWallet ? tone(scoreboard.bestWallet.realizedPnlUsd) : "neutral"}
          />
          <ScoreTile
            label="Worst wallet"
            value={scoreboard.worstWallet ? shortWallet(scoreboard.worstWallet.wallet) : "-"}
            sub={scoreboard.worstWallet ? `${scoreboard.worstWallet.name} · ${signedMoney(scoreboard.worstWallet.realizedPnlUsd)}` : "no closed trades"}
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
                      <td className="max-w-[180px] truncate py-1 pr-2" title={`${wallet.name} · ${wallet.wallet}`}>
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
                  <Badge variant="muted" className="shrink-0 tabular-nums">×{skip.count}</Badge>
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
              <span className="text-muted-foreground">Live balance</span>
              <span className="tabular-nums">{metrics.liveUsdcBalance == null ? "-" : money(metrics.liveUsdcBalance)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Local equity</span>
              <span className="tabular-nums">{money(metrics.localTrackedEquity)}</span>
            </div>
            <div className="flex justify-between gap-3">
              <span className="text-muted-foreground">Balance diff</span>
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

/**
 * Resolved-winnings redemption (real mode). Shows positions the account can
 * redeem for USDC, the expected payout, and which need manual action (proxy/safe/
 * neg-risk). Redeeming requires typing the confirmation text — the bot never
 * redeems from this panel without it. Fully-automatic redemption is a separate,
 * server-side opt-in (ENABLE_AUTO_REDEEM).
 */
function RedeemablesPanel({
  plan,
  busy,
  onRedeem,
}: {
  plan: RedeemablePlan;
  busy: string | null;
  onRedeem: (confirm: string, includeUnknown: boolean) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [includeUnknown, setIncludeUnknown] = useState(false);

  useEffect(() => {
    if (open) {
      setConfirmText("");
      setIncludeUnknown(false);
    }
  }, [open]);

  if (plan.items.length === 0 && !plan.error) return null;

  const working = busy !== null;
  const hasUnknown = plan.items.some((i) => i.blockedReason == null && !i.attributionKnown);
  const autoRedeemable = plan.items.filter((i) => i.blockedReason == null && (i.attributionKnown || includeUnknown)).length;

  return (
    <Card className="border-primary/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Coins className="size-4 text-primary" /> Redeemable Winnings
        </CardTitle>
        <CardDescription>
          {plan.error
            ? plan.error
            : `${money(plan.totalExpectedPayoutUsd)} expected · ${plan.redeemableCount} redeemable by bot, ${plan.manualCount} need manual action.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {plan.items.length > 0 && (
          <div className="overflow-auto scrollbar-thin">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b border-border text-left">
                  <th className="py-2 pr-3">Market</th>
                  <th className="py-2 pr-3">Outcome</th>
                  <th className="py-2 pr-3 text-right">Shares</th>
                  <th className="py-2 pr-3 text-right">Payout</th>
                  <th className="py-2 text-right">Status</th>
                </tr>
              </thead>
              <tbody>
                {plan.items.map((item) => (
                  <tr key={item.tokenId} className="border-b border-border/70">
                    <td className="max-w-[300px] truncate py-2 pr-3" title={item.marketTitle}>{item.marketTitle}</td>
                    <td className="py-2 pr-3">{item.outcome}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{item.shares.toFixed(2)}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{money(item.expectedPayoutUsd)}</td>
                    <td className="py-2 text-right">
                      {item.blockedReason ? (
                        <Badge variant="warning" title={item.blockedReason}>manual</Badge>
                      ) : item.attributionKnown ? (
                        <Badge variant="success">bot</Badge>
                      ) : (
                        <Badge variant="muted" title="Unknown/manual position — only redeemed if you opt in.">unknown</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {plan.redeemableCount > 0 && (
          <div className="flex justify-end">
            <Button size="sm" disabled={working} onClick={() => setOpen(true)}>
              <Coins className="size-3" /> Redeem winnings
            </Button>
          </div>
        )}
      </CardContent>

      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Redeem resolved winnings?"
        description="This submits on-chain redemption transactions for resolved (won) positions and claims their USDC. It moves real funds and cannot be undone. Positions needing manual action (proxy/safe wallets, neg-risk markets) are skipped."
      >
        <div className="space-y-3">
          {hasUnknown && (
            <label className="flex items-center justify-between rounded-md border border-border p-3 text-xs">
              <span className="text-muted-foreground">
                Also redeem unknown / manual positions (not attributed to a copied wallet).
              </span>
              <Switch checked={includeUnknown} onCheckedChange={setIncludeUnknown} aria-label="Include unknown positions" />
            </label>
          )}
          <label className="space-y-1 text-xs text-muted-foreground">
            <span>Type REDEEM to confirm</span>
            <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="REDEEM" />
          </label>
          <p className="text-[11px] text-muted-foreground">
            {autoRedeemable} position{autoRedeemable === 1 ? "" : "s"} will be redeemed for ~
            {money(
              plan.items
                .filter((i) => i.blockedReason == null && (i.attributionKnown || includeUnknown))
                .reduce((s, i) => s + i.expectedPayoutUsd, 0),
            )}
            .
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={working}>Cancel</Button>
            <Button
              size="sm"
              disabled={working || confirmText !== "REDEEM"}
              onClick={async () => {
                setOpen(false);
                await onRedeem("REDEEM", includeUnknown);
              }}
            >
              <Coins className="size-3" /> {busy === "redeem" ? "Redeeming..." : "Confirm redeem"}
            </Button>
          </div>
        </div>
      </Dialog>
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
  const [stopOpen, setStopOpen] = useState(false);
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

  // Redemption returns a run summary (not a BotStatus); surface partial failures
  // and refresh status afterward so the ledger/balance reflect the redeemed cash.
  const runRedeem = async (confirm: string, includeUnknown: boolean) => {
    setBusy("redeem");
    setActionError(null);
    try {
      const result = await postJson<RedeemRunResult>("/api/bot/redeem", { confirm, includeUnknown });
      if (result.failed > 0) {
        setActionError(`Redeemed ${result.redeemed} position(s); ${result.failed} failed. See the debug log for details.`);
      }
      await mutate();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Redeem failed");
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
        // Best effort — nothing we can do if the beacon is rejected on unload.
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [sessionOnly, lifecycleActive]);

  // Stop click: if copied positions are still open, surface the exit choices
  // instead of silently leaving them. Otherwise stop immediately.
  const handleStopClick = () => {
    if (status && status.positions.length > 0) setStopOpen(true);
    else void runAction("stop", "/api/bot/stop");
  };

  const closeStopThen = async (name: string, url: string, body?: unknown) => {
    setStopOpen(false);
    await runAction(name, url, body);
  };

  if (isLoading && !status) {
    return <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">Loading copy bot dashboard...</div>;
  }

  if (error || !status) {
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
                Live · polling
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

      <StopDialog
        open={stopOpen}
        onOpenChange={setStopOpen}
        status={status}
        busy={busy}
        onSellAll={() => void closeStopThen("stop", "/api/bot/stop", { liquidate: true, source: "session-close" })}
        onKeep={() => void closeStopThen("stop", "/api/bot/stop", { liquidate: false })}
        onAutoExit={(rules) => void closeStopThen("drain", "/api/bot/drain", rules)}
      />

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
            Real trading controls are dangerous. The app refuses real mode unless ENABLE_REAL_TRADING=true, reads live USDC before sizing, and caps every BUY with LIVE_MAX_ORDER_USD.
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
          Live balance {status.metrics.liveBalanceStatus}: {status.metrics.liveBalanceError ?? "live USDC differs from local tracked equity by " + signedMoney(status.metrics.balanceDifference ?? 0)}. Local P&amp;L history was not changed.
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

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-8">
        {status.settings.mode === "real" && (
          <StatCard
            label="Live USDC"
            value={status.metrics.liveUsdcBalance == null ? "-" : money(status.metrics.liveUsdcBalance)}
            pulseValue={status.metrics.liveUsdcBalance}
            sub={status.metrics.balanceDifference == null ? "wallet balance" : "diff " + signedMoney(status.metrics.balanceDifference)}
            tone={status.metrics.liveBalanceStatus === "error" || status.metrics.liveBalanceStatus === "warning" ? "neg" : "neutral"}
          />
        )}
        <StatCard label="Current balance" value={money(status.metrics.equityUsd)} pulseValue={status.metrics.equityUsd} sub={"local cash " + money(status.metrics.cashUsd)} />
        <StatCard label="Available balance" value={money(status.metrics.availableBalanceUsd)} pulseValue={status.metrics.availableBalanceUsd} sub="cash available for next buy" />
        <StatCard label="Next trade size" value={money(status.metrics.nextTradeSizeUsd)} pulseValue={status.metrics.nextTradeSizeUsd} sub={`${status.settings.percentageCopySize}% sizing mode`} />
        <StatCard label="Total P&L" value={signedMoney(totalPnl)} tone={tone(totalPnl)} arrow={totalPnl} pulseValue={totalPnl} sub={`${percent(status.metrics.roi)} ROI`} />
        <StatCard label="Win rate" value={percent(status.metrics.winRate, 0)} sub={`${status.metrics.winners}W / ${status.metrics.losers}L`} />
        <StatCard label="Bankroll at risk" value={percent(status.metrics.totalExposurePercent)} pulseValue={status.metrics.totalExposurePercent} sub={`${money(status.metrics.totalExposureUsd)} exposure`} tone={status.metrics.totalExposurePercent > 0.4 ? "neg" : "neutral"} />
        <StatCard label="Cost drag" value={money(status.metrics.totalFrictionUsd)} sub={`incl. ${money(status.metrics.totalFeesUsd)} fees${status.settings.realisticFills ? "" : " · idealized"}`} tone={status.metrics.totalFrictionUsd > 0 ? "neg" : "neutral"} />
      </div>

      <Scoreboard scoreboard={status.scoreboard} />

      <DashboardVisuals status={status} totalPnl={totalPnl} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          {status.settings.mode === "real" && (
            <RedeemablesPanel plan={status.redeemables} busy={busy} onRedeem={runRedeem} />
          )}
          <PositionTable positions={status.positions} equity={status.metrics.equityUsd} />
          <TraderTable
            traders={status.traders}
            onToggle={(wallet, enabled) => void runAction("toggle", "/api/traders/toggle", { wallet, enabled })}
            onRemove={(wallet) => void runAction("remove", "/api/traders/remove", { wallet })}
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






