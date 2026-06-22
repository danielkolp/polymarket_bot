"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { usd, signedUsd, signedPct, pct, compactUsd } from "@/lib/format";
import type { SimMetrics } from "@/lib/sim/types";

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "neutral" | "pos" | "neg";
}) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div
        className={cn(
          "mt-1 text-xl font-semibold tabular-nums",
          tone === "pos" && "text-success",
          tone === "neg" && "text-destructive",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </Card>
  );
}

function tone(n: number): "pos" | "neg" | "neutral" {
  if (n > 0) return "pos";
  if (n < 0) return "neg";
  return "neutral";
}

export function BalanceCard({ metrics }: { metrics: SimMetrics }) {
  const totalPnl = metrics.realizedPnl + metrics.unrealizedPnl;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat label="Equity" value={usd(metrics.equity)} sub={`Cash ${compactUsd(metrics.cash)}`} />
      <Stat label="Total P&L" value={signedUsd(totalPnl)} tone={tone(totalPnl)} sub={signedPct(metrics.roi) + " ROI"} />
      <Stat
        label="Realized / Unrealized"
        value={signedUsd(metrics.realizedPnl)}
        tone={tone(metrics.realizedPnl)}
        sub={`uPnL ${signedUsd(metrics.unrealizedPnl)}`}
      />
      <Stat label="Daily P&L" value={signedUsd(metrics.dailyPnl)} tone={tone(metrics.dailyPnl)} />
      <Stat
        label="Win Rate"
        value={pct(metrics.winRate, 0)}
        sub={`${metrics.wins}W / ${metrics.losses}L`}
      />
      <Stat label="Max Drawdown" value={pct(metrics.maxDrawdown)} tone={metrics.maxDrawdown > 0 ? "neg" : "neutral"} />
    </div>
  );
}
