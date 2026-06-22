"use client";

import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { compactUsd, usd } from "@/lib/format";
import type { EquityPoint } from "@/lib/sim/types";

export function EquityChart({ data, startingBalance }: { data: EquityPoint[]; startingBalance: number }) {
  const chartData = data.map((p) => ({ ts: p.ts, equity: p.equity }));
  const last = data.length ? data[data.length - 1].equity : startingBalance;
  const up = last >= startingBalance;
  const stroke = up ? "hsl(var(--success))" : "hsl(var(--destructive))";

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Equity Curve</span>
          <span className="tabular-nums text-muted-foreground">{usd(last)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[180px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={stroke} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={stroke} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="ts"
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(ts) => new Date(ts).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
                minTickGap={40}
                stroke="hsl(var(--border))"
              />
              <YAxis
                width={48}
                tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                tickFormatter={(v) => compactUsd(v)}
                domain={["auto", "auto"]}
                stroke="hsl(var(--border))"
              />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  fontSize: 12,
                }}
                labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
                formatter={(v) => [usd(v as number), "Equity"]}
              />
              <ReferenceLine y={startingBalance} stroke="hsl(var(--muted-foreground))" strokeDasharray="3 3" />
              <Area type="monotone" dataKey="equity" stroke={stroke} strokeWidth={2} fill="url(#equityFill)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
