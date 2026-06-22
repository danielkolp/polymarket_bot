"use client";

import { useMemo } from "react";
import { BarChart3, Clock3, Gauge, ShieldCheck, TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BotPosition, BotSettings, BotStatus, CopyTradeRecord, EquityPoint, TradeStatus } from "@/lib/copybot/types";

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
    maximumFractionDigits: 1,
  }).format(Number.isFinite(value) ? value : 0);
}

function percent(value: number, fractionDigits = 1): string {
  return `${((Number.isFinite(value) ? value : 0) * 100).toFixed(fractionDigits)}%`;
}

function dateTime(value: number | null | undefined): string {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function chartTime(value: number): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function tradeSizeForBalance(settings: BotSettings, balance: number): number {
  let raw = settings.sizingMode === "fixed" ? settings.fixedCopyAmountUsd : balance * (settings.percentageCopySize / 100);
  if (settings.sizingMode === "hybrid") raw = Math.max(settings.minTradeAmountUsd, Math.min(settings.maxTradeAmountUsd, raw));
  if (settings.sizingMode === "fixed") raw = Math.min(settings.maxTradeAmountUsd, raw);
  return Math.max(0, Math.min(balance, raw));
}

function ChartEmpty({ label, height = 220 }: { label: string; height?: number }) {
  return (
    <div
      className="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
      style={{ height }}
    >
      {label}
    </div>
  );
}

function Meter({
  label,
  value,
  capLabel,
  tone = "neutral",
}: {
  label: string;
  value: number;
  capLabel: string;
  tone?: "neutral" | "pos" | "neg";
}) {
  const pct = clamp01(value);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">
          {percent(pct, 0)} <span className="text-muted-foreground">{capLabel}</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-700",
            tone === "neg" ? "bg-destructive" : tone === "pos" ? "bg-success" : "bg-primary",
          )}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

function EquityChartCard({ points, startingBalance }: { points: EquityPoint[]; startingBalance: number }) {
  const data = useMemo(() => {
    const seeded = points.length > 0 ? points : [{ ts: Date.now(), equityUsd: startingBalance, cashUsd: startingBalance, exposureUsd: 0 }];
    return seeded.map((point) => ({ ...point, time: chartTime(point.ts), pnlUsd: point.equityUsd - startingBalance }));
  }, [points, startingBalance]);

  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-2 duration-500">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="size-4 text-primary" /> Equity Curve
        </CardTitle>
        <CardDescription>Paper equity and exposure over server-side bot ticks.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="h-[280px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: 6, right: 16, top: 8, bottom: 0 }}>
              <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="time" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} minTickGap={24} />
              <YAxis tickFormatter={(value) => compactMoney(Number(value))} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} width={58} />
              <Tooltip
                contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
                formatter={(value, name) => [money(Number(value)), name === "equityUsd" ? "Equity" : name === "cashUsd" ? "Cash" : "Exposure"]}
                labelFormatter={(_, payload) => (payload?.[0]?.payload?.ts ? dateTime(payload[0].payload.ts) : "")}
              />
              <Area type="monotone" dataKey="equityUsd" stroke="hsl(var(--primary))" strokeWidth={2} fill="hsl(var(--primary))" fillOpacity={0.12} dot={false} activeDot={{ r: 4 }} />
              <Area type="monotone" dataKey="exposureUsd" stroke="hsl(var(--warning))" strokeWidth={1.5} fill="transparent" dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function ExposureChart({ positions, equity }: { positions: BotPosition[]; equity: number }) {
  const data = positions
    .map((position) => ({
      label: position.marketTitle.length > 26 ? `${position.marketTitle.slice(0, 26)}...` : position.marketTitle,
      exposure: position.shares * position.markPrice,
      risk: equity > 0 ? (position.shares * position.markPrice) / equity : 0,
    }))
    .sort((a, b) => b.exposure - a.exposure)
    .slice(0, 8);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="size-4 text-primary" /> Exposure Map
        </CardTitle>
        <CardDescription>Largest open market exposures.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="No open positions to map yet." height={240} />
        ) : (
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} layout="vertical" margin={{ left: 8, right: 18, top: 4, bottom: 4 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" horizontal={false} />
                <XAxis type="number" tickFormatter={(value) => compactMoney(Number(value))} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="label" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} width={120} />
                <Tooltip
                  contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }}
                  formatter={(value, name, item) => [name === "exposure" ? money(Number(value)) : percent(Number(value)), item.payload.label]}
                />
                <Bar dataKey="exposure" fill="hsl(var(--primary))" radius={[0, 5, 5, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TradeStatusChart({ trades }: { trades: CopyTradeRecord[] }) {
  const data = useMemo(() => {
    const statuses: TradeStatus[] = ["simulated", "dry-run", "skipped", "failed", "copied"];
    return statuses
      .map((status) => ({ status, count: trades.filter((trade) => trade.status === status).length }))
      .filter((item) => item.count > 0);
  }, [trades]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gauge className="size-4 text-primary" /> Trade Outcomes
        </CardTitle>
        <CardDescription>Recent bot decisions at a glance.</CardDescription>
      </CardHeader>
      <CardContent>
        {data.length === 0 ? (
          <ChartEmpty label="Trade outcomes will appear after new trader trades are processed." height={240} />
        ) : (
          <div className="h-[240px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ left: 4, right: 12, top: 8, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="status" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} />
                <YAxis allowDecimals={false} tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 11 }} tickLine={false} axisLine={false} width={34} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
                <Bar dataKey="count" fill="hsl(var(--primary))" radius={[5, 5, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RiskAndSizing({ status }: { status: BotStatus }) {
  const equity = Math.max(status.metrics.equityUsd, 0.01);
  const largestPosition = status.positions.reduce((max, position) => Math.max(max, position.shares * position.markPrice), 0);
  const perMarketUsed = largestPosition / Math.max(0.01, equity * (status.settings.maxExposurePerMarketPercent / 100));
  const totalUsed = status.metrics.totalExposureUsd / Math.max(0.01, equity * (status.settings.maxTotalExposurePercent / 100));
  const lossUsed = Math.max(0, -status.metrics.dailyPnlUsd) / Math.max(0.01, status.state.dailyStartEquityUsd * (status.settings.maxDailyLossPercent / 100));
  const ten = tradeSizeForBalance(status.settings, 10);
  const hundred = tradeSizeForBalance(status.settings, 100);

  return (
    <Card className="animate-in fade-in-0 slide-in-from-bottom-1 duration-500">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" /> Risk + Sizing
        </CardTitle>
        <CardDescription>How close the bot is to the configured caps, and what the next buy will size to.</CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Meter label="Largest market" value={perMarketUsed} capLabel={`of ${status.settings.maxExposurePerMarketPercent}% cap`} tone={perMarketUsed > 0.85 ? "neg" : "neutral"} />
          <Meter label="Total exposure" value={totalUsed} capLabel={`of ${status.settings.maxTotalExposurePercent}% cap`} tone={totalUsed > 0.85 ? "neg" : "neutral"} />
          <Meter label="Daily loss" value={lossUsed} capLabel={`of ${status.settings.maxDailyLossPercent}% cap`} tone={lossUsed > 0.7 ? "neg" : "pos"} />
        </div>
        <div className="rounded-md border border-border bg-background/60 p-3 text-sm">
          <div className="text-xs text-muted-foreground">Current sizing mode</div>
          <div className="mt-1 font-medium">
            {status.settings.sizingMode === "fixed" && `${money(status.settings.fixedCopyAmountUsd)} fixed, capped at ${money(status.settings.maxTradeAmountUsd)}`}
            {status.settings.sizingMode === "percentage" && `${status.settings.percentageCopySize}% of available balance`}
            {status.settings.sizingMode === "hybrid" && `${status.settings.percentageCopySize}% of balance, clamped ${money(status.settings.minTradeAmountUsd)} to ${money(status.settings.maxTradeAmountUsd)}`}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">$10</div>
              <div className="font-semibold tabular-nums">{money(ten)}</div>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">$100</div>
              <div className="font-semibold tabular-nums">{money(hundred)}</div>
            </div>
            <div className="rounded-md bg-muted/40 p-2">
              <div className="text-muted-foreground">Now</div>
              <div className="font-semibold tabular-nums">{money(status.metrics.nextTradeSizeUsd)}</div>
            </div>
          </div>
          {status.metrics.nextTradeSizeUsd < status.settings.minTradeAmountUsd && (
            <div className="mt-3 rounded-md border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
              Below configured minimum. The bot will skip instead of forcing an oversized trade.
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function PollProgress({ status }: { status: BotStatus }) {
  const now = Date.now();
  const last = status.state.lastPollAt;
  const next = status.state.nextPollAt;
  const running = status.state.runState === "running";
  const progress = running && last && next && next > last ? clamp01((now - last) / (next - last)) : 0;
  const remainingMs = running && next ? Math.max(0, next - now) : null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <Clock3 className="size-4 text-primary" /> Poll Cycle
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Next poll</span>
          <span>{remainingMs == null ? "not scheduled" : `${Math.ceil(remainingMs / 1000)}s`}</span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary transition-all duration-500" style={{ width: `${progress * 100}%` }} />
        </div>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <div className="rounded-md bg-background/60 p-2">
            <div className="text-muted-foreground">Last poll</div>
            <div>{dateTime(status.state.lastPollAt)}</div>
          </div>
          <div className="rounded-md bg-background/60 p-2">
            <div className="text-muted-foreground">Discovery</div>
            <div>{dateTime(status.state.lastDiscoveryAt)}</div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function DashboardVisuals({ status }: { status: BotStatus; totalPnl: number }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(360px,1fr)]">
        <EquityChartCard points={status.equityCurve} startingBalance={status.settings.startingBalance} />
        <div className="space-y-4">
          <PollProgress status={status} />
          <RiskAndSizing status={status} />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ExposureChart positions={status.positions} equity={status.metrics.equityUsd} />
        <TradeStatusChart trades={status.recentTrades} />
      </div>
    </div>
  );
}
