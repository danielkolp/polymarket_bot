"use client";

import { Activity, AlertTriangle, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { SimControls } from "./SimControls";
import { useHealth } from "@/lib/hooks/useHealth";
import { useSimStore } from "@/lib/sim/store";

export function Header({
  onOpenSettings,
  dataStale,
  marketsConnected,
}: {
  onOpenSettings: () => void;
  dataStale: boolean;
  marketsConnected: boolean;
}) {
  const { health } = useHealth();
  const running = useSimStore((s) => s.running);
  const simulationOnly = health ? health.simulationOnly : true;

  return (
    <header className="flex flex-col gap-3 border-b border-border pb-4 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3">
        <div className="flex size-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
          <Activity className="size-5" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold leading-none">{health?.appName ?? "Bonk"}</h1>
            {simulationOnly ? (
              <Badge variant="warning" className="gap-1">
                <ShieldCheck className="size-3" /> SIMULATION ONLY
              </Badge>
            ) : (
              <Badge variant="destructive" className="gap-1">
                <AlertTriangle className="size-3" /> REAL TRADING FLAG ON
              </Badge>
            )}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Polymarket strategy simulation · paper trading on live market data
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 text-xs">
          <span className="flex items-center gap-1 text-muted-foreground">
            {marketsConnected ? (
              <Wifi className="size-3.5 text-success" />
            ) : (
              <WifiOff className="size-3.5 text-destructive" />
            )}
            {marketsConnected ? "Connected" : "Reconnecting…"}
          </span>
          {dataStale && (
            <Badge variant="destructive" className="gap-1">
              <AlertTriangle className="size-3" /> Stale data
            </Badge>
          )}
          <span className="flex items-center gap-1 text-muted-foreground">
            <span className={`size-2 rounded-full ${running ? "bg-success animate-pulse" : "bg-muted-foreground"}`} />
            {running ? "Running" : "Paused"}
          </span>
        </div>
        <SimControls onOpenSettings={onOpenSettings} />
      </div>
    </header>
  );
}
