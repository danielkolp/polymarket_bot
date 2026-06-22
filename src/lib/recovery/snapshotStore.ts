"use client";

/**
 * Client-side persistence for recovered portfolio snapshots. For now this lives
 * in localStorage (per the spec) so a recovery survives reloads without a
 * backend. Keyed by wallet; also keeps a short rolling history per wallet.
 */
import type { PortfolioSnapshot } from "./types";

const LATEST_PREFIX = "bonk.recovery.latest.";
const HISTORY_PREFIX = "bonk.recovery.history.";
const WALLETS_KEY = "bonk.recovery.wallets";
const MAX_HISTORY = 10;

function hasStorage(): boolean {
  return typeof window !== "undefined" && !!window.localStorage;
}

function read<T>(key: string): T | null {
  if (!hasStorage()) return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  if (!hasStorage()) return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota or serialization failure — non-fatal for a local convenience cache.
  }
}

function walletKey(wallet: string): string {
  return wallet.trim().toLowerCase();
}

export function saveSnapshot(snapshot: PortfolioSnapshot): void {
  const wallet = walletKey(snapshot.wallet);
  if (!wallet) return;

  write(`${LATEST_PREFIX}${wallet}`, snapshot);

  const history = read<PortfolioSnapshot[]>(`${HISTORY_PREFIX}${wallet}`) ?? [];
  write(`${HISTORY_PREFIX}${wallet}`, [snapshot, ...history].slice(0, MAX_HISTORY));

  const wallets = read<string[]>(WALLETS_KEY) ?? [];
  if (!wallets.includes(wallet)) write(WALLETS_KEY, [wallet, ...wallets].slice(0, 25));
}

export function loadLatestSnapshot(wallet: string): PortfolioSnapshot | null {
  const key = walletKey(wallet);
  if (!key) return null;
  return read<PortfolioSnapshot>(`${LATEST_PREFIX}${key}`);
}

export function loadSnapshotHistory(wallet: string): PortfolioSnapshot[] {
  const key = walletKey(wallet);
  if (!key) return [];
  return read<PortfolioSnapshot[]>(`${HISTORY_PREFIX}${key}`) ?? [];
}

export function loadKnownWallets(): string[] {
  return read<string[]>(WALLETS_KEY) ?? [];
}

/** Most recently recovered wallet across sessions, if any. */
export function loadMostRecentWallet(): string | null {
  return loadKnownWallets()[0] ?? null;
}
