"use client";

/**
 * Client-side simulation store (zustand + localStorage persistence).
 * Holds the entire SimSnapshot and exposes user/engine actions. This is the
 * single source of truth for the dashboard; the engine tick mutates it.
 */
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { DEFAULT_SETTINGS, initialMetrics } from "./defaults";
import { makeLog, runTick, type EngineInputs } from "./engine";
import { simExecutor } from "@/lib/execution/simExecutor";
import type { RiskSettings, SimOrder, SimSnapshot, TradeLogEntry } from "./types";

const MAX_TRADES = 500;

function createSnapshot(settings: RiskSettings, now = Date.now()): SimSnapshot {
  return {
    running: false,
    haltedReason: null,
    strategyEnabled: true,
    settings,
    orders: [],
    positions: [],
    trades: [makeLog(now, "info", `Simulation initialized with $${settings.startingBalance.toLocaleString()} paper balance.`)],
    equityCurve: [{ ts: now, equity: settings.startingBalance }],
    metrics: initialMetrics(settings.startingBalance, now),
    watchTokenIds: [],
    priceHistory: {},
    followedWallets: [],
    lastCopiedTs: {},
    lastTickAt: null,
    createdAt: now,
  };
}

function prependLog(trades: TradeLogEntry[], entry: TradeLogEntry): TradeLogEntry[] {
  const merged = [entry, ...trades];
  return merged.length > MAX_TRADES ? merged.slice(0, MAX_TRADES) : merged;
}

export interface SimStore extends SimSnapshot {
  start: () => void;
  pause: () => void;
  reset: () => void;
  setStrategyEnabled: (enabled: boolean) => void;
  setStrategyMode: (mode: RiskSettings["strategyMode"]) => void;
  setFollowed: (wallets: string[]) => void;
  toggleFollow: (wallet: string) => void;
  updateSettings: (patch: Partial<RiskSettings>) => void;
  tick: (inputs: Omit<EngineInputs, "now">) => void;
  manualCancel: (orderId: string) => void;
  manualFlatten: (tokenId: string) => void;
  exportJson: () => string;
  importJson: (json: string) => boolean;
}

export const useSimStore = create<SimStore>()(
  persist(
    (set, get) => ({
      ...createSnapshot(DEFAULT_SETTINGS),

      start: () =>
        set((s) => ({
          running: true,
          trades: prependLog(s.trades, makeLog(Date.now(), "info", "▶ Simulation started.")),
        })),

      pause: () =>
        set((s) => ({
          running: false,
          trades: prependLog(s.trades, makeLog(Date.now(), "info", "⏸ Simulation paused.")),
        })),

      reset: () =>
        set((s) => createSnapshot(s.settings)),

      setStrategyEnabled: (enabled) =>
        set((s) => ({
          strategyEnabled: enabled,
          trades: prependLog(
            s.trades,
            makeLog(Date.now(), "info", enabled ? "Strategy enabled." : "Strategy disabled (no new quotes)."),
          ),
        })),

      setStrategyMode: (mode) =>
        set((s) => ({
          settings: { ...s.settings, strategyMode: mode },
          trades: prependLog(
            s.trades,
            makeLog(Date.now(), "info", `Strategy mode → ${mode === "copy" ? "Copy Trading" : "Spread Capture"}.`),
          ),
        })),

      setFollowed: (wallets) =>
        set(() => ({ followedWallets: [...new Set(wallets.map((w) => w.toLowerCase()))].filter(Boolean) })),

      toggleFollow: (wallet) =>
        set((s) => {
          const w = wallet.toLowerCase();
          const has = s.followedWallets.includes(w);
          return {
            followedWallets: has ? s.followedWallets.filter((x) => x !== w) : [...s.followedWallets, w],
          };
        }),

      updateSettings: (patch) =>
        set((s) => {
          const settings = { ...s.settings, ...patch };
          // If nothing has happened yet, let a starting-balance change take effect.
          const pristine = s.positions.length === 0 && s.orders.length === 0 && s.metrics.realizedPnl === 0;
          const metrics =
            pristine && patch.startingBalance != null
              ? initialMetrics(settings.startingBalance)
              : s.metrics;
          const equityCurve =
            pristine && patch.startingBalance != null
              ? [{ ts: Date.now(), equity: settings.startingBalance }]
              : s.equityCurve;
          return { settings, metrics, equityCurve };
        }),

      tick: (inputs) => {
        const s = get();
        if (!s.running) return;
        set(runTick(s, { ...inputs, now: Date.now() }));
      },

      manualCancel: (orderId) =>
        set((s) => {
          const order = s.orders.find((o) => o.id === orderId);
          if (!order) return s;
          const cancelled = simExecutor.cancel(order, Date.now());
          return {
            orders: s.orders.filter((o) => o.id !== orderId),
            trades: prependLog(
              s.trades,
              makeLog(Date.now(), "cancel", `Manually cancelled ${cancelled.side} @ ${(cancelled.price * 100).toFixed(1)}¢`),
            ),
          };
        }),

      manualFlatten: (tokenId) =>
        set((s) => {
          const pos = s.positions.find((p) => p.tokenId === tokenId);
          if (!pos || pos.shares <= 0) return s;
          const mid = pos.markPrice;
          const proceeds = mid * pos.shares;
          const pnl = (mid - pos.avgPrice) * pos.shares;
          const win = pnl >= 0;
          return {
            positions: s.positions.filter((p) => p.tokenId !== tokenId),
            orders: s.orders.filter((o) => o.tokenId !== tokenId),
            metrics: {
              ...s.metrics,
              cash: s.metrics.cash + proceeds,
              wins: s.metrics.wins + (win ? 1 : 0),
              losses: s.metrics.losses + (win ? 0 : 1),
            },
            trades: prependLog(
              s.trades,
              makeLog(
                Date.now(),
                "flatten",
                `Manually flattened ${pos.shares.toFixed(0)} ${pos.outcomeLabel} @ ${(mid * 100).toFixed(1)}¢ (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)})`,
              ),
            ),
          };
        }),

      exportJson: () => {
        const s = get();
        const snapshot: SimSnapshot = {
          running: false,
          haltedReason: s.haltedReason,
          strategyEnabled: s.strategyEnabled,
          settings: s.settings,
          orders: s.orders,
          positions: s.positions,
          trades: s.trades,
          equityCurve: s.equityCurve,
          metrics: s.metrics,
          watchTokenIds: s.watchTokenIds,
          priceHistory: s.priceHistory,
          followedWallets: s.followedWallets,
          lastCopiedTs: s.lastCopiedTs,
          lastTickAt: s.lastTickAt,
          createdAt: s.createdAt,
        };
        return JSON.stringify(snapshot, null, 2);
      },

      importJson: (json) => {
        try {
          const parsed = JSON.parse(json) as Partial<SimSnapshot>;
          if (!parsed.settings || !parsed.metrics) return false;
          set({
            ...createSnapshot(parsed.settings),
            ...parsed,
            running: false,
            trades: prependLog(parsed.trades ?? [], makeLog(Date.now(), "info", "State imported from JSON.")),
          });
          return true;
        } catch {
          return false;
        }
      },
    }),
    {
      name: "bonk-sim-state",
      version: 4,
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        running: false, // never auto-resume on reload
        haltedReason: s.haltedReason,
        strategyEnabled: s.strategyEnabled,
        settings: s.settings,
        orders: s.orders,
        positions: s.positions,
        trades: s.trades,
        equityCurve: s.equityCurve,
        metrics: s.metrics,
        watchTokenIds: s.watchTokenIds,
        priceHistory: s.priceHistory,
        followedWallets: s.followedWallets,
        lastCopiedTs: s.lastCopiedTs,
        lastTickAt: s.lastTickAt,
        createdAt: s.createdAt,
      }),
      // Heal state saved by older versions: backfill new settings and repair
      // any non-finite numeric state (e.g. equity that NaN'd from a missing fee).
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<SimSnapshot>;
        const settings = { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) };
        const m = p.metrics;
        const corrupt =
          !m || !Number.isFinite(m.equity) || !Number.isFinite(m.cash) || !Number.isFinite(m.realizedPnl);
        if (corrupt) {
          return { ...createSnapshot(settings), settings } as unknown as SimStore;
        }
        return { ...p, settings } as unknown as SimStore;
      },
      // Always ensure settings carry every key, even on the current version.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<SimStore>;
        return {
          ...current,
          ...p,
          settings: { ...DEFAULT_SETTINGS, ...(p.settings ?? {}) },
          running: false,
        };
      },
    },
  ),
);

export type { SimOrder };
