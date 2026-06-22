"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cents, usd } from "@/lib/format";
import { fromNow } from "@/lib/time";
import { useSimStore } from "@/lib/sim/store";
import type { SimOrder } from "@/lib/sim/types";

export function OpenOrdersTable({ orders }: { orders: SimOrder[] }) {
  const manualCancel = useSimStore((s) => s.manualCancel);
  const now = Date.now();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Open Orders</span>
          <Badge variant="muted">{orders.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-[200px]">Market</TableHead>
              <TableHead>Side</TableHead>
              <TableHead className="text-right">Price</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead className="text-right">Notional</TableHead>
              <TableHead className="text-right">Age</TableHead>
              <TableHead className="text-right"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {orders.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-6 text-center text-sm text-muted-foreground">
                  No resting orders.
                </TableCell>
              </TableRow>
            )}
            {orders.map((o) => {
              const remaining = o.size - o.filledSize;
              return (
                <TableRow key={o.id}>
                  <TableCell className="max-w-[260px]">
                    <div className="truncate font-medium" title={o.marketQuestion}>
                      {o.marketQuestion}
                    </div>
                    <div className="text-xs text-muted-foreground">{o.outcomeLabel}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={o.side === "buy" ? "success" : "warning"}>{o.side}</Badge>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{cents(o.price)}</TableCell>
                  <TableCell className="text-right tabular-nums">{remaining.toFixed(0)}</TableCell>
                  <TableCell className="text-right tabular-nums">{usd(remaining * o.price)}</TableCell>
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {fromNow(o.createdAt - now)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => manualCancel(o.id)}>
                      Cancel
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
