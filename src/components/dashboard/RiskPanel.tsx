"use client";

import { AlertTriangle, ShieldAlert, ShieldCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { usd, compactUsd, cents } from "@/lib/format";
import type { SimMetrics, SimOrder, SimPosition, RiskSettings } from "@/lib/sim/types";

function Meter({ label, value, max, format }: { label: string; value: number; max: number; format: (n: number) => string }) {
  const pct = max > 0 ? Math.min(1, value / max) : 0;
  const breach = max > 0 && value >= max - 1e-9;
  const warn = pct >= 0.8;
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={cn("tabular-nums", breach ? "text-destructive" : warn ? "text-warning" : "text-foreground")}>
          {format(value)} / {format(max)}
        </span>
      </div>
      <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", breach ? "bg-destructive" : warn ? "bg-warning" : "bg-primary")}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

export function RiskPanel({
  metrics,
  settings,
  positions,
  orders,
  haltedReason,
}: {
  metrics: SimMetrics;
  settings: RiskSettings;
  positions: SimPosition[];
  orders: SimOrder[];
  haltedReason: string | null;
}) {
  const perMarket = new Map<string, number>();
  for (const p of positions) {
    perMarket.set(p.marketId, (perMarket.get(p.marketId) ?? 0) + Math.abs(p.shares * p.markPrice));
  }
  const worstMarketExposure = Math.max(0, ...perMarket.values());
  const dailyLossUsed = Math.max(0, -metrics.dailyPnl);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            {haltedReason ? (
              <ShieldAlert className="size-4 text-destructive" />
            ) : (
              <ShieldCheck className="size-4 text-success" />
            )}
            Risk Controls
          </span>
          <Badge variant={haltedReason ? "destructive" : "success"}>{haltedReason ? "HALTED" : "OK"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {haltedReason && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{haltedReason} Trading resumes after the daily reset.</span>
          </div>
        )}

        <Meter label="Total exposure" value={metrics.totalExposure} max={settings.maxTotalExposure} format={compactUsd} />
        <Meter label="Worst market exposure" value={worstMarketExposure} max={settings.maxExposurePerMarket} format={compactUsd} />
        <Meter label="Daily loss used" value={dailyLossUsed} max={settings.maxDailyLoss} format={usd} />
        <Meter label="Open orders" value={orders.length} max={settings.maxOpenOrders} format={(n) => n.toFixed(0)} />

        <div className="grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
          <Threshold label="Min liquidity" value={compactUsd(settings.minLiquidity)} />
          <Threshold label="Min spread" value={cents(settings.minSpread)} />
          <Threshold label="Stale-data timeout" value={`${settings.staleDataTimeoutSec}s`} />
          <Threshold label="No-trade window" value={`${settings.noTradeWindowMinutes}m`} />
        </div>
      </CardContent>
    </Card>
  );
}

function Threshold({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}
