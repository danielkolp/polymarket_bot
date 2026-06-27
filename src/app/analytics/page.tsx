"use client";

import type { ReactNode } from "react";
import useSWR from "swr";
import Link from "next/link";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart } from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { jsonFetcher } from "@/lib/hooks/fetcher";
import { compactUsd, pct, signedPct, signedUsd, usd } from "@/lib/format";
import type { DashboardSummary, TraderAnalytics, CategoryAnalytics, PortfolioAnalytics, CorrelationCluster } from "@/lib/analytics/aggregate";

interface SummaryResponse {
  dashboard: DashboardSummary;
  traders: TraderAnalytics[];
  categories: CategoryAnalytics[];
  portfolio: PortfolioAnalytics;
  correlation: CorrelationCluster[];
  completedTradeCount: number;
}

const SUCCESS = "hsl(var(--success))";
const DESTRUCTIVE = "hsl(var(--destructive))";
const PRIMARY = "hsl(var(--primary))";

function Kpi({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" | "neutral" }) {
  const color = tone === "up" ? "text-[hsl(var(--success))]" : tone === "down" ? "text-[hsl(var(--destructive))]" : "";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`mt-1 text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      </CardContent>
    </Card>
  );
}

function toneOf(n: number): "up" | "down" | "neutral" {
  return n > 0 ? "up" : n < 0 ? "down" : "neutral";
}

export default function AnalyticsPage() {
  const { data, error, isLoading } = useSWR<SummaryResponse>("/api/analytics/summary", jsonFetcher, {
    refreshInterval: 30_000,
  });

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Analytics</h1>
          <p className="text-xs text-muted-foreground">
            Observational only — never affects trading. Auto-refreshes every 30s.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm">
          <Link href="/" className="text-muted-foreground hover:text-foreground">
            ← Dashboard
          </Link>
          <a
            href="/api/analytics/export?download=1"
            className="rounded-md border border-border bg-card px-3 py-1.5 hover:bg-accent"
          >
            Export JSON
          </a>
        </div>
      </header>

      {error && <Card><CardContent className="p-4 text-[hsl(var(--destructive))]">Failed to load: {error.message}</CardContent></Card>}
      {isLoading && !data && <Card><CardContent className="p-4 text-muted-foreground">Loading analytics…</CardContent></Card>}

      {data && <AnalyticsBody data={data} />}
    </main>
  );
}

function AnalyticsBody({ data }: { data: SummaryResponse }) {
  const d = data.dashboard;
  const perf = d.performance;

  return (
    <>
      <section className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Kpi label="Realized P&L" value={signedUsd(perf.cumulativeRealizedPnlUsd)} tone={toneOf(perf.cumulativeRealizedPnlUsd)} />
        <Kpi label="Cumulative ROI" value={signedPct(perf.cumulativeRoi)} tone={toneOf(perf.cumulativeRoi)} />
        <Kpi label="Win Rate" value={pct(perf.winRate)} />
        <Kpi label="Expectancy / trade" value={signedUsd(perf.expectancyUsd)} tone={toneOf(perf.expectancyUsd)} />
        <Kpi label="Avg Winner" value={usd(perf.avgWinnerUsd)} tone="up" />
        <Kpi label="Avg Loser" value={usd(perf.avgLoserUsd)} tone="down" />
        <Kpi label="Completed Trades" value={String(d.totals.completedTrades)} />
        <Kpi label="Decisions Logged" value={String(d.totals.decisions)} />
      </section>

      <section className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Kpi label="BUYs" value={String(d.totals.buys)} />
        <Kpi label="SELLs" value={String(d.totals.sells)} />
        <Kpi label="Skips (would have won)" value={`${d.totals.skips} (${d.missedThatWouldHaveWon})`} />
      </section>

      <Card>
        <CardHeader><CardTitle>Equity Curve (realized, from completed trades)</CardTitle></CardHeader>
        <CardContent>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={d.equityFromCompleted} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                <defs>
                  <linearGradient id="pnlFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={PRIMARY} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={PRIMARY} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="ts" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickFormatter={(ts) => new Date(ts).toLocaleDateString()} minTickGap={50} stroke="hsl(var(--border))" />
                <YAxis width={52} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickFormatter={(v) => compactUsd(v)} stroke="hsl(var(--border))" />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  labelFormatter={(ts) => new Date(ts as number).toLocaleString()}
                  formatter={(v) => [usd(v as number), "Cumulative P&L"]} />
                <Area type="monotone" dataKey="cumulativePnlUsd" stroke={PRIMARY} strokeWidth={2} fill="url(#pnlFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Decision Score Distribution (analytics-only, not used for trading)</CardTitle></CardHeader>
        <CardContent>
          <div className="h-[200px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={d.scoreDistribution} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <YAxis width={36} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                  formatter={(v, n) => [String(v), n === "count" ? "decisions" : "filled"]} />
                <Bar dataKey="count" fill={PRIMARY} radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Copy ROI by Trader</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table
              head={["Trader", "P&L", "Copy ROI"]}
              rows={d.copyRoiByTrader.slice(0, 12).map((t) => [
                t.name.length > 18 ? `${t.name.slice(0, 16)}…` : t.name,
                <span key="p" className={cls(t.pnlUsd)}>{signedUsd(t.pnlUsd)}</span>,
                <span key="r" className={cls(t.copyRoi)}>{signedPct(t.copyRoi)}</span>,
              ])}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Copy ROI by Category</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table
              head={["Category", "P&L", "Copy ROI"]}
              rows={d.copyRoiByCategory.map((c) => [
                c.category,
                <span key="p" className={cls(c.pnlUsd)}>{signedUsd(c.pnlUsd)}</span>,
                <span key="r" className={cls(c.copyRoi)}>{signedPct(c.copyRoi)}</span>,
              ])}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader><CardTitle>Skip Reasons & Missed Opportunities</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table
            head={["Reason", "Skips", "Resolved would-win", "Avg ROI if copied"]}
            rows={d.skipReasons.map((s) => [
              s.reasonCode,
              String(s.count),
              String(s.wouldHaveWon),
              <span key="r" className={cls(s.avgRoiIfCopied)}>{signedPct(s.avgRoiIfCopied)}</span>,
            ])}
          />
          <div className="border-t border-border p-3 text-xs text-muted-foreground">
            Missed resolved: {d.missedSummary.resolved} · would have been profitable: {d.missedSummary.wouldHaveBeenProfitable}
            {" "}· avg ROI if copied: {signedPct(d.missedSummary.avgRoiIfCopied)}
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Exposure by Category</CardTitle></CardHeader>
          <CardContent className="p-0">
            <Table
              head={["Category", "Exposure"]}
              rows={data.portfolio.exposureByCategory.map((e) => [e.category, usd(e.exposureUsd)])}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Correlated Position Clusters</CardTitle></CardHeader>
          <CardContent className="p-0">
            {data.correlation.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">No correlated clusters (≥2 positions sharing an attribute).</div>
            ) : (
              <Table
                head={["Kind", "Key", "Positions", "Exposure"]}
                rows={data.correlation.slice(0, 12).map((c) => [
                  c.kind,
                  c.key.length > 20 ? `${c.key.slice(0, 18)}…` : c.key,
                  String(c.positionCount),
                  usd(c.exposureUsd),
                ])}
              />
            )}
          </CardContent>
        </Card>
      </div>

      <ScoreBars data={d} />
    </>
  );
}

function ScoreBars({ data }: { data: DashboardSummary }) {
  return (
    <Card>
      <CardHeader><CardTitle>Realized P&L by Score Bucket (filled trades)</CardTitle></CardHeader>
      <CardContent>
        <div className="h-[200px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data.scoreDistribution} margin={{ top: 5, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
              <XAxis dataKey="bucket" tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} stroke="hsl(var(--border))" />
              <YAxis width={48} tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }} tickFormatter={(v) => compactUsd(v)} stroke="hsl(var(--border))" />
              <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8, fontSize: 12 }}
                formatter={(v) => [usd(v as number), "avg P&L"]} />
              <Bar dataKey="avgRealizedPnlUsd" radius={[3, 3, 0, 0]}>
                {data.scoreDistribution.map((b, i) => (
                  <Cell key={i} fill={b.avgRealizedPnlUsd >= 0 ? SUCCESS : DESTRUCTIVE} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

function cls(n: number): string {
  return n > 0 ? "text-[hsl(var(--success))]" : n < 0 ? "text-[hsl(var(--destructive))]" : "";
}

function Table({ head, rows }: { head: string[]; rows: ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
            {head.map((h) => (
              <th key={h} className="px-3 py-2 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td className="px-3 py-3 text-muted-foreground" colSpan={head.length}>No data yet.</td></tr>
          ) : (
            rows.map((r, i) => (
              <tr key={i} className="border-b border-border/50 last:border-0">
                {r.map((cell, j) => (
                  <td key={j} className="px-3 py-2 tabular-nums">{cell}</td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
