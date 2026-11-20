/**
 * GET /api/health — liveness for the deploy pipeline and the systemd watchdog.
 *
 * Returns 200 when the server is up and, if the operator wants the bot running,
 * a poll has completed recently. Returns 503 when the bot should be running but
 * its heartbeat is stale (stuck or dead loop) so the watchdog can restart it.
 * Never includes balances, keys or addresses (safe to curl from scripts).
 */
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { loadBotState, loadSettings } from "@/lib/copybot/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = await loadSettings();
    const state = await loadBotState(settings);
    const engine = getCopyBotEngine().health();
    const now = Date.now();
    const desired = state.desiredRunState ?? state.runState;
    const wantsRunning = desired === "running" || desired === "draining";
    const intervalMs = settings.pollingIntervalSec * 1000;
    const heartbeatAgeMs = state.lastHeartbeatAt ? now - state.lastHeartbeatAt : null;
    // Allow discovery/slow polls: stale only after 3 intervals + 2 minutes.
    const staleAfterMs = 3 * intervalMs + 120_000;
    const heartbeatOk = !wantsRunning || (heartbeatAgeMs != null && heartbeatAgeMs <= staleAfterMs);
    const memory = process.memoryUsage();
    const body = {
      ok: heartbeatOk,
      mode: settings.mode,
      preset: settings.riskPreset,
      runState: state.runState,
      desiredRunState: desired,
      panic: state.panic,
      heartbeatAgeSec: heartbeatAgeMs == null ? null : Math.round(heartbeatAgeMs / 1000),
      staleAfterSec: Math.round(staleAfterMs / 1000),
      engine,
      realTradingEnabled: config.enableRealTrading,
      rssMb: Math.round(memory.rss / 1048576),
      heapMb: Math.round(memory.heapUsed / 1048576),
      uptimeSec: Math.round(process.uptime()),
      time: now,
    };
    return NextResponse.json(body, { status: heartbeatOk ? 200 : 503, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "health check failed" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
