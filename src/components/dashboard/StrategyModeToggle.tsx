"use client";

import { Crosshair, Trophy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSimStore } from "@/lib/sim/store";

export function StrategyModeToggle() {
  const mode = useSimStore((s) => s.settings.strategyMode);
  const setMode = useSimStore((s) => s.setStrategyMode);

  const Item = ({ value, icon, label }: { value: "spread" | "copy"; icon: React.ReactNode; label: string }) => (
    <button
      type="button"
      onClick={() => setMode(value)}
      className={cn(
        "flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
        mode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <div className="flex items-center gap-1 rounded-md border border-border bg-muted p-1">
      <Item value="spread" icon={<Crosshair className="size-3.5" />} label="Spread Capture" />
      <Item value="copy" icon={<Trophy className="size-3.5" />} label="Copy Trading" />
    </div>
  );
}
