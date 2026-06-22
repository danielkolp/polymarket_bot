"use client";

import { Trophy, Users, Star } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { compactUsd, cents } from "@/lib/format";
import { fromNow } from "@/lib/time";
import { useSimStore } from "@/lib/sim/store";
import type { Leader, TraderTrade } from "@/lib/polymarket/types";

export function CopyTradingPanel({
  leaders,
  leadersLoading,
  trades,
}: {
  leaders: Leader[];
  leadersLoading: boolean;
  trades: TraderTrade[];
}) {
  const settings = useSimStore((s) => s.settings);
  const followed = useSimStore((s) => s.followedWallets);
  const toggleFollow = useSimStore((s) => s.toggleFollow);
  const setFollowed = useSimStore((s) => s.setFollowed);
  const updateSettings = useSimStore((s) => s.updateSettings);

  const followedSet = new Set(followed);
  const recentTrades = trades.slice(0, 25);

  return (
    <Card>
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Trophy className="size-4 text-primary" /> Copy Trading
          </CardTitle>
          <Badge variant="muted" className="gap-1">
            <Users className="size-3" /> {followed.length} followed
          </Badge>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="h-8 w-auto text-xs"
            value={settings.copyLeaderMetric}
            onChange={(e) => updateSettings({ copyLeaderMetric: e.target.value as "profit" | "volume" })}
          >
            <option value="profit">By profit</option>
            <option value="volume">By volume</option>
          </Select>
          <Select
            className="h-8 w-auto text-xs"
            value={settings.copyLeaderWindow}
            onChange={(e) => updateSettings({ copyLeaderWindow: e.target.value as "1d" | "7d" | "all" })}
          >
            <option value="1d">24h</option>
            <option value="7d">7d</option>
            <option value="all">All-time</option>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFollowed(leaders.slice(0, settings.copyMaxLeaders).map((l) => l.wallet))}
          >
            Follow top {settings.copyMaxLeaders}
          </Button>
          {followed.length > 0 && (
            <Button size="sm" variant="ghost" onClick={() => setFollowed([])}>
              Clear
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Leaderboard */}
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Top traders</div>
          <div className="space-y-1">
            {leadersLoading && leaders.length === 0 &&
              Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            {leaders.slice(0, 10).map((l) => {
              const isFollowed = followedSet.has(l.wallet);
              return (
                <button
                  key={l.wallet}
                  onClick={() => toggleFollow(l.wallet)}
                  className={cn(
                    "flex w-full items-center justify-between rounded-md border px-2 py-1.5 text-left transition-colors",
                    isFollowed ? "border-primary/50 bg-primary/10" : "border-border hover:bg-muted/40",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-5 text-xs tabular-nums text-muted-foreground">#{l.rank}</span>
                    <span className="text-sm font-medium">{l.name}</span>
                    <Star className={cn("size-3", isFollowed ? "fill-primary text-primary" : "text-muted-foreground")} />
                  </div>
                  <span className="text-xs tabular-nums text-success">{compactUsd(l.amount)}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Mirrored / incoming trades feed */}
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Followed traders' recent trades</div>
          <div className="max-h-[260px] space-y-1 overflow-auto scrollbar-thin pr-1">
            {recentTrades.length === 0 && (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {followed.length === 0 ? "Follow a trader to see their trades." : "Waiting for trades…"}
              </p>
            )}
            {recentTrades.map((t) => (
              <div key={t.txHash + t.tokenId} className="flex items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-muted/40">
                <span className="w-12 shrink-0 truncate text-muted-foreground">{t.traderName}</span>
                <Badge variant={t.side === "BUY" ? "success" : "warning"} className="shrink-0">
                  {t.side}
                </Badge>
                <span className="flex-1 truncate" title={t.title}>
                  {t.outcome ? `${t.outcome} · ` : ""}
                  {t.title}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{cents(t.price)}</span>
                <span className="w-10 shrink-0 text-right tabular-nums text-muted-foreground">
                  {fromNow(t.timestamp * 1000 - Date.now())}
                </span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
