"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useSimStore } from "@/lib/sim/store";
import { DEFAULT_SETTINGS } from "@/lib/sim/defaults";
import type { RiskSettings } from "@/lib/sim/types";

function Field({
  label,
  value,
  onChange,
  step = 1,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  step?: number;
  hint?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <Input
        className="mt-1"
        type="number"
        step={step}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="mt-0.5 text-[10px] text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const settings = useSimStore((s) => s.settings);
  const updateSettings = useSimStore((s) => s.updateSettings);
  const hasActivity = useSimStore((s) => s.positions.length > 0 || s.metrics.realizedPnl !== 0);
  const [draft, setDraft] = useState<RiskSettings>(settings);

  useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);

  const set = (patch: Partial<RiskSettings>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    updateSettings(draft);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Simulation Settings"
      description="Tune risk controls and the spread-capture strategy. Changes apply on save."
      className="max-w-2xl"
    >
      <div className="max-h-[65vh] space-y-5 overflow-auto scrollbar-thin pr-1">
        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Balance</h3>
          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Starting balance ($)"
              value={draft.startingBalance}
              step={100}
              onChange={(n) => set({ startingBalance: n })}
              hint={hasActivity ? "Takes effect after Reset" : "Applies immediately (no activity yet)"}
            />
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Risk Controls</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Max exposure / market ($)" value={draft.maxExposurePerMarket} step={50} onChange={(n) => set({ maxExposurePerMarket: n })} />
            <Field label="Max total exposure ($)" value={draft.maxTotalExposure} step={100} onChange={(n) => set({ maxTotalExposure: n })} />
            <Field label="Max daily loss ($)" value={draft.maxDailyLoss} step={50} onChange={(n) => set({ maxDailyLoss: n })} />
            <Field label="Min liquidity ($)" value={draft.minLiquidity} step={500} onChange={(n) => set({ minLiquidity: n })} />
            <Field label="Min spread (¢)" value={draft.minSpread * 100} step={0.5} onChange={(n) => set({ minSpread: n / 100 })} />
            <Field label="Stale-data timeout (s)" value={draft.staleDataTimeoutSec} step={5} onChange={(n) => set({ staleDataTimeoutSec: n })} />
            <Field label="No-trade window (min)" value={draft.noTradeWindowMinutes} step={15} onChange={(n) => set({ noTradeWindowMinutes: n })} />
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Strategy</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Order size ($)" value={draft.orderSize} step={25} onChange={(n) => set({ orderSize: n })} />
            <Field label="Max open orders" value={draft.maxOpenOrders} onChange={(n) => set({ maxOpenOrders: n })} />
            <Field label="Stale order timeout (s)" value={draft.staleOrderTimeoutSec} step={15} onChange={(n) => set({ staleOrderTimeoutSec: n })} />
            <Field label="Quote edge offset (¢)" value={draft.edgeOffset * 100} step={0.1} onChange={(n) => set({ edgeOffset: n / 100 })} />
            <Field label="Maker exit offset (¢)" value={draft.takeProfitOffset * 100} step={0.5} onChange={(n) => set({ takeProfitOffset: n / 100 })} hint="Resting sell above entry" />
            <Field label="Take-profit (%)" value={draft.takeProfitPct * 100} step={1} onChange={(n) => set({ takeProfitPct: n / 100 })} hint="Sell high: bank a winner up this %" />
            <Field label="Stop-loss (%)" value={draft.stopLossPct * 100} step={1} onChange={(n) => set({ stopLossPct: n / 100 })} hint="Cut a loser down this %" />
            <Field label="Dip lookback (ticks)" value={draft.dipLookback} step={1} onChange={(n) => set({ dipLookback: n })} hint="Buy low: reference window" />
            <Field label="Buy-dip threshold (%)" value={draft.buyDipThreshold * 100} step={0.5} onChange={(n) => set({ buyDipThreshold: n / 100 })} hint="0 = only buy at/below recent avg" />
            <Field label="Fee (bps)" value={draft.feeBps} step={1} onChange={(n) => set({ feeBps: n })} hint="Per-fill trading fee" />
            <Field label="Fill ratio (0–1)" value={draft.fillRatio} step={0.05} onChange={(n) => set({ fillRatio: n })} hint="Share of book size captured per fill" />
            <Field label="Tick interval (s)" value={draft.tickIntervalSec} onChange={(n) => set({ tickIntervalSec: n })} />
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Copy Trading</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Field label="Per-trade size ($)" value={draft.copyPerTradeUsd} step={10} onChange={(n) => set({ copyPerTradeUsd: n })} hint="Paper $ mirrored per trade" />
            <Field label="Auto-follow top N" value={draft.copyMaxLeaders} onChange={(n) => set({ copyMaxLeaders: n })} />
            <Field label="Copy slippage (bps)" value={draft.copySlippageBps} step={5} onChange={(n) => set({ copySlippageBps: n })} hint="Models being late vs the trader" />
            <Field label="Recency window (min)" value={draft.copyRecencyMinutes} step={5} onChange={(n) => set({ copyRecencyMinutes: n })} hint="Ignore trades older than this" />
          </div>
        </section>
      </div>

      <div className="mt-5 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setDraft(DEFAULT_SETTINGS)}>
          Restore defaults
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={save}>
            Save
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
