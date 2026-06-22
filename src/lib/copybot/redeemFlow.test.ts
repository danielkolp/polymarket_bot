import { describe, expect, it, vi } from "vitest";
import { makeSettings } from "./testFixtures";
import type { BotSettings } from "./types";

// Control the mode the engine sees without touching disk. Only loadSettings is
// overridden; the confirmation / auto gates return BEFORE any other store access
// or network call, so the rest of the real store is never reached in these tests.
let mode: BotSettings["mode"] = "real";
vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return { ...actual, loadSettings: vi.fn(async () => makeSettings({ mode })) };
});

import { getCopyBotEngine } from "./bot";

describe("redeemResolved — gates", () => {
  it("refuses in simulation mode (sim settles automatically)", async () => {
    mode = "simulation";
    const result = await getCopyBotEngine().redeemResolved({ confirm: "REDEEM" });
    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/real mode/i);
  });

  it("requires the REDEEM confirmation text for a manual run", async () => {
    mode = "real";
    const result = await getCopyBotEngine().redeemResolved({ confirm: "yes please" });
    expect(result.ran).toBe(false);
    expect(result.error).toMatch(/REDEEM/);
    expect(result.redeemed).toBe(0);
  });

  it("is a no-op for an automatic run when ENABLE_AUTO_REDEEM is off (default)", async () => {
    mode = "real";
    const result = await getCopyBotEngine().redeemResolved({ auto: true });
    expect(result.ran).toBe(false);
    expect(result.attempted).toBe(0);
    expect(result.error).toBeNull(); // silent no-op, not an error
  });
});
