"use client";

import { useRef } from "react";
import { Play, Pause, RotateCcw, Download, Upload, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useSimStore } from "@/lib/sim/store";

export function SimControls({ onOpenSettings }: { onOpenSettings: () => void }) {
  const running = useSimStore((s) => s.running);
  const strategyEnabled = useSimStore((s) => s.strategyEnabled);
  const start = useSimStore((s) => s.start);
  const pause = useSimStore((s) => s.pause);
  const reset = useSimStore((s) => s.reset);
  const setStrategyEnabled = useSimStore((s) => s.setStrategyEnabled);
  const exportJson = useSimStore((s) => s.exportJson);
  const importJson = useSimStore((s) => s.importJson);

  const fileRef = useRef<HTMLInputElement>(null);

  const handleExport = () => {
    const blob = new Blob([exportJson()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `bonk-sim-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const ok = importJson(String(reader.result));
      if (!ok) alert("Could not import: invalid Bonk state file.");
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      {running ? (
        <Button size="sm" variant="secondary" onClick={pause}>
          <Pause /> Pause
        </Button>
      ) : (
        <Button size="sm" onClick={start}>
          <Play /> Start
        </Button>
      )}

      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (confirm("Reset the simulation? This clears positions, orders, trades and P&L.")) reset();
        }}
      >
        <RotateCcw /> Reset
      </Button>

      <div className="mx-1 flex items-center gap-2 rounded-md border border-border px-2 py-1">
        <span className="text-xs text-muted-foreground">Strategy</span>
        <Switch checked={strategyEnabled} onCheckedChange={setStrategyEnabled} aria-label="Toggle strategy" />
      </div>

      <Button size="sm" variant="ghost" onClick={handleExport} title="Export state to JSON">
        <Download />
      </Button>
      <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()} title="Import state from JSON">
        <Upload />
      </Button>
      <input ref={fileRef} type="file" accept="application/json" className="hidden" onChange={handleImport} />

      <Button size="sm" variant="ghost" onClick={onOpenSettings} title="Settings">
        <Settings />
      </Button>
    </div>
  );
}
