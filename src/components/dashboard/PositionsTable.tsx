"use client";

import { ArrowDown, ArrowUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Sparkline } from "@/components/ui/sparkline";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cents, usd, signedUsd, signedPct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useSimStore } from "@/lib/sim/store";
import type { SimPosition } from "@/lib/sim/types";

export function PositionsTable({
  positions,
  priceHistory,
}: {
  positions: SimPosition[];
  priceHistory: Record<string, number[]>;
}) {
  const manualFlatten = useSimStore((s) => s.manualFlatten);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Open Positions</span>
          <Badge variant="muted">{positions.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px]">Market</TableHead>
              <TableHead className="text-right">Shares</TableHead>
              <TableHead className="text-right">Avg</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-center">Trend</TableHead>
              <TableHead className="text-right">Value</TableHead>
              <TableHead className="text-right">uPnL</TableHead>
              <TableHead className="text-right">Ret%</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {positions.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-6 text-center text-sm text-muted-foreground">
                  No open positions.
                </TableCell>
              </TableRow>
            )}
            {positions.map((p) => {
              const value = p.shares * p.markPrice;
              const uPnl = (p.markPrice - p.avgPrice) * p.shares;
              const ret = p.avgPrice > 0 ? (p.markPrice - p.avgPrice) / p.avgPrice : 0;
              const hist = priceHistory[p.tokenId] ?? [];
              const prev = hist.length >= 2 ? hist[hist.length - 2] : p.markPrice;
              const tickUp = p.markPrice > prev;
              const tickDown = p.markPrice < prev;
              return (
                <TableRow key={p.tokenId}>
                  <TableCell className="max-w-[260px]">
                    <div className="truncate font-medium" title={p.marketQuestion}>
                      {p.marketQuestion}
                    </div>
                    <div className="text-xs text-muted-foreground">{p.outcomeLabel}</div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.shares.toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{cents(p.avgPrice)}</TableCell>
                  <TableCell className="text-right">
                    <span
                      className={cn(
                        "inline-flex items-center justify-end gap-1 font-medium tabular-nums",
                        tickUp && "text-success",
                        tickDown && "text-destructive",
                      )}
                    >
                      {tickUp && <ArrowUp className="size-3" />}
                      {tickDown && <ArrowDown className="size-3" />}
                      {cents(p.markPrice)}
                    </span>
                  </TableCell>
                  <TableCell className="text-center">
                    <div className="flex justify-center">
                      <Sparkline data={hist} />
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{usd(value)}</TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      uPnl > 0 && "text-success",
                      uPnl < 0 && "text-destructive",
                    )}
                  >
                    {signedUsd(uPnl)}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right tabular-nums",
                      ret > 0 && "text-success",
                      ret < 0 && "text-destructive",
                    )}
                  >
                    {signedPct(ret)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => manualFlatten(p.tokenId)}>
                      Flatten
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
