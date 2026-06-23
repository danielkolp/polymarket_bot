import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FollowedTrader } from "./types";

const originalCwd = process.cwd();
let tempDir: string;

function makeTrader(wallet: string, overrides: Partial<FollowedTrader> = {}): FollowedTrader {
  return {
    wallet,
    name: "Test trader",
    enabled: true,
    source: "manual",
    rank: null,
    weeklyPnlUsd: 0,
    weeklyVolumeUsd: 0,
    weeklyTradeCount: 0,
    copiedTradeCount: 0,
    copiedSimPnlUsd: 0,
    lastTradeAt: null,
    addedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function importStore() {
  vi.resetModules();
  return import("./store");
}

describe("copybot JSON store", () => {
  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "copybot-store-"));
    process.chdir(tempDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    vi.resetModules();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("heals an empty JSON file without surfacing a parse error", async () => {
    const file = path.join(tempDir, "data", "trades.json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "", "utf8");

    const { loadTrades } = await importStore();

    await expect(loadTrades()).resolves.toEqual([]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("");
  });

  it("uses the last good snapshot when a state file is temporarily truncated", async () => {
    const { loadTraders, saveTraders } = await importStore();
    const trader = makeTrader("0xABC");
    const normalized = { ...trader, wallet: "0xabc" };

    await saveTraders([trader]);
    await expect(loadTraders()).resolves.toEqual([normalized]);

    const file = path.join(tempDir, "data", "traders.json");
    await fs.writeFile(file, "[", "utf8");

    await expect(loadTraders()).resolves.toEqual([normalized]);
    await expect(fs.readFile(file, "utf8")).resolves.toBe("[");
  });

  it("writes state through complete JSON replacement files", async () => {
    const { loadTraders, saveTraders } = await importStore();
    const trader = makeTrader("0xDEF", { enabled: false, addedAt: 2, updatedAt: 2 });
    const normalized = { ...trader, wallet: "0xdef" };

    await saveTraders([trader]);

    const file = path.join(tempDir, "data", "traders.json");
    const raw = await fs.readFile(file, "utf8");
    expect(JSON.parse(raw)).toEqual([normalized]);
    await expect(loadTraders()).resolves.toEqual([normalized]);

    const files = await fs.readdir(path.dirname(file));
    expect(files.some((name) => name.endsWith(".tmp"))).toBe(false);
  });
});