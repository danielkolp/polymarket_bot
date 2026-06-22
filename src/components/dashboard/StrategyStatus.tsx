"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Cpu } from "lucide-react";
import { fromNow } from "@/lib/time";

export function StrategyStatus({
  running,
  strategyEnabled,
  haltedReason,
  eligibleCount,
  ordersCount,
  watchCount,
  lastTickAt,
}: {
  running: boolean;
  strategyEnabled: boolean;
  haltedReason: string | null;
  eligibleCount: number;
  ordersCount: number;
  watchCount: number;
  lastTickAt: number | null;
}) {
  const state = haltedReason ? "Halted" : !running ? "Paused" : !strategyEnabled ? "Monitoring" : "Active";
  const variant = haltedReason ? "destructive" : state === "Active" ? "success" : "muted";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <Cpu className="size-4 text-primary" /> Spread-Capture Strategy
          </span>
          <Badge variant={variant}>{state}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        <p className="text-muted-foreground">
          Buy low, sell high: only buys when price is at/below its recent average, then banks the rebound at the
          take-profit (and cuts losers at the stop-loss) — all before resolution. Strategy universe = your scanner
          filters.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Row label="Eligible markets" value={String(eligibleCount)} />
          <Row label="Watching books" value={String(watchCount)} />
          <Row label="Active quotes" value={String(ordersCount)} />
          <Row label="Last tick" value={lastTickAt ? fromNow(lastTickAt - Date.now()) : "—"} />
        </div>
      </CardContent>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
