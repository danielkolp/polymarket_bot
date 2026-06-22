"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { BadgeProps } from "@/components/ui/badge";
import type { TradeLogEntry, TradeType } from "@/lib/sim/types";

const TYPE_VARIANT: Record<TradeType, BadgeProps["variant"]> = {
  fill: "success",
  place: "default",
  cancel: "muted",
  flatten: "warning",
  risk: "destructive",
  info: "secondary",
};

function timeLabel(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-US", { hour12: false });
}

export function TradeLog({ trades }: { trades: TradeLogEntry[] }) {
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Trade Log</span>
          <Badge variant="muted">{trades.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        <div className="max-h-[460px] space-y-1 overflow-auto scrollbar-thin pr-1">
          {trades.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">No activity yet.</p>
          )}
          {trades.map((t) => (
            <div key={t.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/40">
              <span className="mt-0.5 w-16 shrink-0 tabular-nums text-muted-foreground">{timeLabel(t.ts)}</span>
              <Badge variant={TYPE_VARIANT[t.type]} className="shrink-0">
                {t.type}
              </Badge>
              <span
                className={cn(
                  "flex-1 leading-relaxed",
                  t.pnl != null && t.pnl > 0 && "text-success",
                  t.pnl != null && t.pnl < 0 && "text-destructive",
                )}
              >
                {t.message}
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
