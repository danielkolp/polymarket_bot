"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Circle,
  Lock,
  RefreshCcw,
  ShieldAlert,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Sparkline } from "@/components/ui/sparkline";
import { TrendIcon } from "@/components/ui/trend-icon";
import { cn } from "@/lib/utils";
import { fromNow, timeToResolution } from "@/lib/time";
import {
  loadLatestSnapshot,
  loadMostRecentWallet,
  saveSnapshot,
} from "@/lib/recovery/snapshotStore";
import type {
  PortfolioSnapshot,
  PositionClassification,
  RecommendedAction,
  RecoveredPosition,
  ResumeChoice,
  RiskFlag,
  RiskSeverity,
} from "@/lib/recovery/types";

type ApiEnvelope<T> = { ok: true; data: T; fetchedAt: number } | { ok: false; error: string };
type BadgeVariant = "success" | "warning" | "destructive" | "muted" | "default";

const WALLET_RE = /^0x[a-f0-9]{40}$/;

const CLASS_META: Record<PositionClassification, { label: string; variant: BadgeVariant }> = {
  "healthy-hold": { label: "Healthy hold", variant: "success" },
  "take-profit": { label: "Take profit", variant: "success" },
  "reduce-exposure": { label: "Reduce exposure", variant: "warning" },
  "exit-candidate": { label: "Exit candidate", variant: "destructive" },
  "too-illiquid": { label: "Too illiquid", variant: "warning" },
  "near-resolution": { label: "Near resolution", variant: "warning" },
  "manual-review": { label: "Manual review", variant: "muted" },
};

const ACTION_META: Record<RecommendedAction, { label: string; variant: BadgeVariant }> = {
  hold: { label: "Hold", variant: "muted" },
  "sell-all": { label: "Sell all", variant: "destructive" },
  "sell-partial": { label: "Sell partial", variant: "warning" },
  "reduce-risk": { label: "Reduce risk", variant: "warning" },
  "wait-for-liquidity": { label: "Wait for liquidity", variant: "default" },
  "manual-review": { label: "Manual review", variant: "default" },
};

const SEVERITY_VARIANT: Record<RiskSeverity, BadgeVariant> = {
  info: "muted",
  warning: "warning",
  critical: "destructive",
};

function usd(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function signedUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : "-"}${usd(Math.abs(value))}`;
}

function priceC(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  return `${(p * 100).toFixed(1)}c`;
}

function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function ttr(ms: number | null | undefined): string {
  return timeToResolution(ms ?? null);
}

function tone(value: number | null | undefined): "pos" | "neg" | "neutral" {
  if (value == null || value === 0) return "neutral";
  return value > 0 ? "pos" : "neg";
}

function Stat({ label, value, sub, t = "neutral" }: { label: string; value: string; sub?: string; t?: "pos" | "neg" | "neutral" }) {
  return (
    <Card className="p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-lg font-semibold tabular-nums", t === "pos" && "text-success", t === "neg" && "text-destructive")}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </Card>
  );
}

function ChecklistRow({ done, active, title, detail }: { done: boolean; active?: boolean; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      {done ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" /> : <Circle className={cn("mt-0.5 size-4 shrink-0", active ? "text-primary" : "text-muted-foreground")} />}
      <div>
        <div className={cn("text-sm font-medium", !done && !active && "text-muted-foreground")}>{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </div>
  );
}

function PnlCell({ usd: value, pctValue }: { usd: number | null; pctValue: number | null }) {
  if (value == null) return <span className="text-xs text-muted-foreground">unknown</span>;
  const up = value > 0;
  const down = value < 0;
  return (
    <span className={cn("inline-flex items-center justify-end gap-1 tabular-nums", up && "text-success", down && "text-destructive", !up && !down && "text-muted-foreground")}>
      <TrendIcon value={value} size={13} />
      {signedUsd(value)}
      {pctValue != null && <span className="text-[11px] opacity-70">({pct(pctValue)})</span>}
    </span>
  );
}

function RiskFlagList({ flags }: { flags: RiskFlag[] }) {
  if (flags.length === 0) return <p className="text-xs text-muted-foreground">No risk flags.</p>;
  return (
    <div className="space-y-1.5">
      {flags.map((flag) => (
        <div key={flag.code} className="flex items-start gap-2 text-xs">
          <Badge variant={SEVERITY_VARIANT[flag.severity]} className="shrink-0">{flag.severity}</Badge>
          <span className="text-muted-foreground">{flag.message}</span>
        </div>
      ))}
    </div>
  );
}

function PositionDetail({ position }: { position: RecoveredPosition }) {
  const ph = position.priceHistory;
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{position.marketTitle}</CardTitle>
            <CardDescription>{position.outcome} · {position.shares.toFixed(2)} shares</CardDescription>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge variant={CLASS_META[position.classification].variant}>{CLASS_META[position.classification].label}</Badge>
            <Badge variant={ACTION_META[position.recommendedAction].variant}>→ {ACTION_META[position.recommendedAction].label}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
          <Field label="Cost basis" value={position.avgEntryPrice != null ? priceC(position.avgEntryPrice) : "unknown"} hint={position.costBasisSource} />
          <Field label="Mid / Bid / Ask" value={`${priceC(position.midPrice)} / ${priceC(position.bestBid)} / ${priceC(position.bestAsk)}`} />
          <Field label="Spread" value={position.spread != null ? `${(position.spread * 100).toFixed(1)}c` : "—"} />
          <Field label="Est. value" value={usd(position.estimatedValueUsd)} />
          <Field label="Cost basis $" value={usd(position.costBasisUsd)} />
          <Field label="Unrealized P&L" value={position.unrealizedPnlUsd != null ? `${signedUsd(position.unrealizedPnlUsd)} (${pct(position.unrealizedPnlPct)})` : "unknown"} t={tone(position.unrealizedPnlUsd)} />
          <Field label="Liquidity" value={usd(position.liquidityUsd, 0)} />
          <Field label="24h volume" value={usd(position.volume24hrUsd, 0)} />
          <Field label="Resolves" value={ttr(position.timeToResolutionMs)} hint={position.marketStatus} />
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">Price history</div>
          {ph ? (
            <div className="flex items-center gap-4">
              <Sparkline data={ph.series} width={160} height={40} />
              <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs sm:grid-cols-4">
                <Field small label="Change" value={pct(ph.changePct)} t={tone(ph.changePct)} />
                <Field small label="High / Low" value={`${priceC(ph.high)} / ${priceC(ph.low)}`} />
                <Field small label="Volatility" value={ph.volatility != null ? `${(ph.volatility * 100).toFixed(1)}%` : "—"} />
                <Field small label="Momentum" value={ph.momentum != null ? `${ph.momentum >= 0 ? "↑" : "↓"} ${(Math.abs(ph.momentum) * 100).toFixed(1)}c` : "—"} t={tone(ph.momentum)} />
              </div>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">No price history available.</p>
          )}
        </div>

        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground"><ShieldAlert className="size-3.5" /> Risk flags</div>
          <RiskFlagList flags={position.riskFlags} />
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="text-xs font-medium text-muted-foreground">Recommended action (not executed)</div>
          <div className="mt-1 flex items-center gap-2">
            <Badge variant={ACTION_META[position.recommendedAction].variant}>{ACTION_META[position.recommendedAction].label}</Badge>
            <span className="text-sm">{position.actionRationale}</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Field({ label, value, hint, t = "neutral", small }: { label: string; value: string; hint?: string; t?: "pos" | "neg" | "neutral"; small?: boolean }) {
  return (
    <div>
      <div className={cn("text-muted-foreground", small ? "text-[11px]" : "text-xs")}>{label}</div>
      <div className={cn("tabular-nums", small ? "text-xs" : "text-sm font-medium", t === "pos" && "text-success", t === "neg" && "text-destructive")}>
        {value}
        {hint && <span className="ml-1 text-[10px] uppercase text-muted-foreground">{hint}</span>}
      </div>
    </div>
  );
}

export function PortfolioRecovery() {
  const [wallet, setWallet] = useState("");
  const [snapshot, setSnapshot] = useState<PortfolioSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedToken, setSelectedToken] = useState<string | null>(null);
  const [resumeChoice, setResumeChoice] = useState<ResumeChoice | null>(null);
  const [fromCache, setFromCache] = useState(false);

  // On mount, restore the most recently recovered wallet + its cached snapshot.
  useEffect(() => {
    const recent = loadMostRecentWallet();
    if (recent) {
      setWallet(recent);
      const cached = loadLatestSnapshot(recent);
      if (cached) {
        setSnapshot(cached);
        setSelectedToken(cached.positions[0]?.tokenId ?? null);
        setFromCache(true);
      }
    }
  }, []);

  const walletValid = WALLET_RE.test(wallet.trim().toLowerCase());

  const recover = async () => {
    const w = wallet.trim().toLowerCase();
    if (!WALLET_RE.test(w)) {
      setError("Enter a valid 0x wallet address.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/portfolio/recover?wallet=${encodeURIComponent(w)}`, { cache: "no-store" });
      const json = (await res.json()) as ApiEnvelope<PortfolioSnapshot>;
      if (!res.ok || !json.ok) throw new Error(json.ok ? "Request failed" : json.error);
      setSnapshot(json.data);
      setSelectedToken(json.data.positions[0]?.tokenId ?? null);
      setResumeChoice(null);
      setFromCache(false);
      saveSnapshot(json.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recovery failed");
    } finally {
      setLoading(false);
    }
  };

  const selected = useMemo(
    () => snapshot?.positions.find((p) => p.tokenId === selectedToken) ?? snapshot?.positions[0] ?? null,
    [snapshot, selectedToken],
  );

  const aggregateFlags = useMemo(() => {
    if (!snapshot) return [] as { code: string; severity: RiskSeverity; message: string; count: number }[];
    const map = new Map<string, { code: string; severity: RiskSeverity; message: string; count: number }>();
    for (const p of snapshot.positions) {
      for (const f of p.riskFlags) {
        const existing = map.get(f.code);
        if (existing) existing.count += 1;
        else map.set(f.code, { code: f.code, severity: f.severity, message: f.message, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => (b.severity === "critical" ? 1 : 0) - (a.severity === "critical" ? 1 : 0));
  }, [snapshot]);

  const totals = snapshot?.totals;

  return (
    <div className="mx-auto max-w-[1500px] space-y-4 p-4 lg:p-6">
      <header className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Wallet className="size-5 text-primary" />
            <h1 className="text-xl font-semibold">Portfolio Recovery</h1>
            <Badge variant="muted">simulation-first</Badge>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Make live mode position-aware: read the account&rsquo;s existing shares, analyze them, and get recommended actions before the bot resumes. Read-only — no orders are placed.
          </p>
        </div>
        <Link href="/" className="inline-flex h-8 items-center gap-1 self-start rounded-md border border-border px-3 text-xs text-muted-foreground transition-colors hover:bg-muted/40">
          <ArrowLeft className="size-3" /> Back to dashboard
        </Link>
      </header>

      {/* Resume Bot Checklist */}
      <Card>
        <CardHeader>
          <CardTitle>Resume Bot Checklist</CardTitle>
          <CardDescription>Bring the bot back online safely, aware of what the account already holds.</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-5">
          <ChecklistRow done={walletValid} active={!walletValid} title="1. Connect / read wallet" detail="Enter the account address (read-only)." />
          <ChecklistRow done={!!snapshot} active={walletValid && !snapshot} title="2. Load existing positions" detail="Pull current positions from Polymarket." />
          <ChecklistRow done={!!snapshot} title="3. Analyze each position" detail="Cost basis, liquidity, P&L, risk flags." />
          <ChecklistRow done={!!snapshot && snapshot.positions.length > 0} title="4. Review recommended actions" detail="Recommendations only — nothing executes." />
          <ChecklistRow done={!!resumeChoice} active={!!snapshot} title="5. Choose how to resume" detail="Simulate, manual, or (future) live mode." />
        </CardContent>
      </Card>

      {/* Step 1 + 2: wallet input */}
      <Card>
        <CardHeader>
          <CardTitle>Connect wallet</CardTitle>
          <CardDescription>Read-only by address. No signing, no keys, no orders.</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void recover(); }}>
            <Input placeholder="0x… account address" value={wallet} onChange={(e) => setWallet(e.target.value)} className="max-w-md font-mono" />
            <Button type="submit" disabled={loading || !walletValid}>
              <RefreshCcw className={cn("size-4", loading && "animate-spin")} /> {loading ? "Recovering…" : "Load positions"}
            </Button>
          </form>
          {error && <div className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">{error}</div>}
          {snapshot && (
            <p className="mt-3 text-xs text-muted-foreground">
              {fromCache ? "Cached snapshot" : "Recovered"} {fromNow(snapshot.fetchedAt - Date.now())} · {snapshot.positions.length} position(s){fromCache && " — reload to refresh"}
            </p>
          )}
        </CardContent>
      </Card>

      {snapshot && (
        <>
          {/* Global safety banner */}
          {!snapshot.liveExecutionEnabled && (
            <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-foreground">
              <Lock className="mt-0.5 size-4 shrink-0" />
              <div>
                Live order placement is <span className="font-medium">disabled</span> (ENABLE_REAL_TRADING={String(snapshot.realTradingEnabled)}). Every action here is a recommendation the bot will <span className="font-medium">not</span> execute in this phase.
              </div>
            </div>
          )}

          {snapshot.notes.length > 0 && (
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
              <ul className="list-inside list-disc space-y-1">
                {snapshot.notes.map((note, i) => <li key={i}>{note}</li>)}
              </ul>
            </div>
          )}

          {/* Totals */}
          {totals && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
              <Stat label="Positions" value={String(totals.positionCount)} sub={`${totals.actionableCount} actionable`} />
              <Stat label="Est. value" value={usd(totals.estimatedValueUsd)} />
              <Stat label="Unrealized P&L" value={signedUsd(totals.unrealizedPnlUsd)} t={tone(totals.unrealizedPnlUsd)} sub="where cost basis known" />
              <Stat label="Unknown basis" value={String(totals.unknownCostBasisCount)} t={totals.unknownCostBasisCount > 0 ? "neg" : "neutral"} />
              <Stat label="Illiquid / near-res" value={`${totals.illiquidCount} / ${totals.nearResolutionCount}`} t={totals.illiquidCount + totals.nearResolutionCount > 0 ? "neg" : "neutral"} />
              <Stat label="From bot sessions" value={String(totals.fromBotSessionCount)} sub="prior-session holds" />
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="space-y-4 xl:col-span-2">
              {/* Existing Positions */}
              <Card>
                <CardHeader>
                  <CardTitle>Existing Positions</CardTitle>
                  <CardDescription>Click a row for full detail, price history, and risk flags.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="overflow-auto scrollbar-thin">
                    <table className="w-full min-w-[820px] text-sm">
                      <thead className="text-xs text-muted-foreground">
                        <tr className="border-b border-border text-left">
                          <th className="py-2 pr-3">Market</th>
                          <th className="py-2 pr-3">Outcome</th>
                          <th className="py-2 pr-3 text-right">Shares</th>
                          <th className="py-2 pr-3 text-right">Basis</th>
                          <th className="py-2 pr-3 text-right">Mid</th>
                          <th className="py-2 pr-3 text-right">Unrealized</th>
                          <th className="py-2 pr-3">Class</th>
                          <th className="py-2">Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {snapshot.positions.length === 0 && (
                          <tr><td colSpan={8} className="py-8 text-center text-xs text-muted-foreground">No open positions for this wallet.</td></tr>
                        )}
                        {snapshot.positions.map((p) => (
                          <tr
                            key={p.tokenId}
                            onClick={() => setSelectedToken(p.tokenId)}
                            className={cn("cursor-pointer border-b border-border/70 transition-colors hover:bg-muted/40", selected?.tokenId === p.tokenId && "bg-primary/5")}
                          >
                            <td className="max-w-[280px] truncate py-2 pr-3" title={p.marketTitle}>
                              {p.marketTitle}
                              {p.fromBotSession && <Badge variant="muted" className="ml-1.5 align-middle text-[10px]">bot</Badge>}
                            </td>
                            <td className="py-2 pr-3">{p.outcome}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{p.shares.toFixed(1)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{p.avgEntryPrice != null ? priceC(p.avgEntryPrice) : <span className="text-muted-foreground">?</span>}</td>
                            <td className="py-2 pr-3 text-right tabular-nums">{priceC(p.midPrice)}</td>
                            <td className="py-2 pr-3 text-right"><PnlCell usd={p.unrealizedPnlUsd} pctValue={p.unrealizedPnlPct} /></td>
                            <td className="py-2 pr-3"><Badge variant={CLASS_META[p.classification].variant}>{CLASS_META[p.classification].label}</Badge></td>
                            <td className="py-2"><Badge variant={ACTION_META[p.recommendedAction].variant}>{ACTION_META[p.recommendedAction].label}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CardContent>
              </Card>

              {/* Position Detail + Price History + Risk Flags + Recommended Action */}
              {selected && <PositionDetail position={selected} />}
            </div>

            <div className="space-y-4">
              {/* Aggregate Risk Flags */}
              <Card>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2"><ShieldAlert className="size-4 text-warning" /> Risk Flags</CardTitle>
                  <CardDescription>Portfolio-wide safety warnings.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  {aggregateFlags.length === 0 && <p className="text-xs text-muted-foreground">No risk flags across positions.</p>}
                  {aggregateFlags.map((f) => (
                    <div key={f.code} className="flex items-start gap-2 text-xs">
                      <Badge variant={SEVERITY_VARIANT[f.severity]} className="shrink-0">{f.count}×</Badge>
                      <span className="text-muted-foreground">{f.message}</span>
                    </div>
                  ))}
                </CardContent>
              </Card>

              {/* Resume choice */}
              <Card>
                <CardHeader>
                  <CardTitle>Resume Mode</CardTitle>
                  <CardDescription>Choose how the bot should proceed from here.</CardDescription>
                </CardHeader>
                <CardContent className="space-y-2">
                  <ResumeOption
                    active={resumeChoice === "simulate"}
                    title="Simulate management"
                    detail="Paper-manage these positions using the recommendations. Default and safe."
                    onClick={() => setResumeChoice("simulate")}
                  />
                  <ResumeOption
                    active={resumeChoice === "manual"}
                    title="Manual mode"
                    detail="You act on recommendations yourself; the bot only monitors."
                    onClick={() => setResumeChoice("manual")}
                  />
                  <ResumeOption
                    active={resumeChoice === "live"}
                    disabled={!snapshot.realTradingEnabled}
                    title="Live mode (future)"
                    detail={snapshot.realTradingEnabled ? "Real execution is still not implemented in this phase." : "Disabled — set ENABLE_REAL_TRADING=true to unlock later."}
                    onClick={() => snapshot.realTradingEnabled && setResumeChoice("live")}
                  />
                  {resumeChoice && (
                    <div className="rounded-md border border-border bg-muted/30 p-2 text-xs text-muted-foreground">
                      {resumeChoice === "simulate" && "Simulated management selected. Recommendations would drive paper trades only."}
                      {resumeChoice === "manual" && "Manual mode selected. The bot will monitor and surface recommendations without acting."}
                      {resumeChoice === "live" && "Live mode is gated and unimplemented — no real orders will be placed."}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </>
      )}

      {!snapshot && !loading && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <AlertTriangle className="size-5" />
            Enter a wallet address above to recover and analyze its existing Polymarket positions.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function ResumeOption({ active, disabled, title, detail, onClick }: { active: boolean; disabled?: boolean; title: string; detail: string; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex w-full items-start gap-2 rounded-lg border p-3 text-left transition-colors",
        disabled && "cursor-not-allowed opacity-60",
        active ? "border-primary/60 bg-primary/10" : "border-border hover:bg-muted/40",
      )}
    >
      {disabled ? <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : active ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-primary" /> : <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </button>
  );
}
