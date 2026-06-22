"use client";

import { AlertCircle, Crosshair } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Sparkline } from "@/components/ui/sparkline";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ScannerFilters } from "./ScannerFilters";
import { cents, compactUsd } from "@/lib/format";
import { timeToResolution } from "@/lib/time";
import type { Market } from "@/lib/polymarket/types";
import type { MarketFilters } from "@/lib/hooks/useMarkets";
import type { RiskSettings } from "@/lib/sim/types";
import { isMarketEligible } from "@/lib/sim/eligibility";

const isEligible = isMarketEligible;

export function MarketScanner({
  markets,
  isLoading,
  error,
  settings,
  watchTokenIds,
  priceHistory,
  filters,
  onFiltersChange,
}: {
  markets: Market[];
  isLoading: boolean;
  error?: Error;
  settings: RiskSettings;
  watchTokenIds: string[];
  priceHistory: Record<string, number[]>;
  filters: MarketFilters;
  onFiltersChange: (f: MarketFilters) => void;
}) {
  const watch = new Set(watchTokenIds);
  const eligibleCount = markets.filter((m) => isEligible(m, settings)).length;

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Crosshair className="size-4 text-primary" /> Market Scanner
          </CardTitle>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Badge variant="muted">{markets.length} markets</Badge>
            <Badge variant="success">{eligibleCount} eligible</Badge>
          </div>
        </div>
        <ScannerFilters filters={filters} onChange={onFiltersChange} />
      </CardHeader>
      <CardContent>
        {error && (
          <div className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertCircle className="size-4" /> {error.message}
          </div>
        )}

        <div className="max-h-[420px] overflow-auto scrollbar-thin">
          <Table>
            <TableHeader className="sticky top-0 bg-card">
              <TableRow>
                <TableHead className="min-w-[240px]">Market</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="text-right">Bid</TableHead>
                <TableHead className="text-right">Ask</TableHead>
                <TableHead className="text-right">Spread</TableHead>
                <TableHead className="text-center">Trend</TableHead>
                <TableHead className="text-right">Liquidity</TableHead>
                <TableHead className="text-right">Vol 24h</TableHead>
                <TableHead className="text-right">Resolves</TableHead>
                <TableHead className="text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && markets.length === 0 &&
                Array.from({ length: 8 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 10 }).map((__, j) => (
                      <TableCell key={j}>
                        <Skeleton className="h-4 w-full" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}

              {!isLoading && markets.length === 0 && !error && (
                <TableRow>
                  <TableCell colSpan={10} className="py-8 text-center text-sm text-muted-foreground">
                    No markets match your filters.
                  </TableCell>
                </TableRow>
              )}

              {markets.map((m) => {
                const eligible = isEligible(m, settings);
                const watched = watch.has(m.outcomes[0]?.tokenId);
                return (
                  <TableRow key={m.id}>
                    <TableCell className="max-w-[320px]">
                      <div className="truncate font-medium" title={m.question}>
                        {m.question}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {m.outcomes.map((o) => o.label).join(" / ") || "—"}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{m.category}</TableCell>
                    <TableCell className="text-right tabular-nums">{cents(m.bestBid)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cents(m.bestAsk)}</TableCell>
                    <TableCell className="text-right tabular-nums">{cents(m.spread)}</TableCell>
                    <TableCell className="text-center">
                      <div className="flex justify-center">
                        <Sparkline data={priceHistory[m.outcomes[0]?.tokenId] ?? []} width={56} height={20} />
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{compactUsd(m.liquidity)}</TableCell>
                    <TableCell className="text-right tabular-nums">{compactUsd(m.volume24hr)}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {timeToResolution(m.timeToResolutionMs)}
                    </TableCell>
                    <TableCell className="text-right">
                      {watched ? (
                        <Badge variant="default">watching</Badge>
                      ) : eligible ? (
                        <Badge variant="success">eligible</Badge>
                      ) : (
                        <Badge variant="muted">—</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
