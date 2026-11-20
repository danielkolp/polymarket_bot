/**
 * GET /api/bot/heartbeat — lightweight liveness probe for an uptime monitor
 * (UptimeRobot, Healthchecks.io, cron + curl, ...).
 *
 * 200 when the bot is running/draining and has completed a poll recently;
 * 503 otherwise (stopped, panicked, or polls are stale/failing), so the monitor
 * alerts you. Read-only and cheap: no upstream calls, no balances, no trades.
 */
import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const hb = await getCopyBotEngine().heartbeat();
    return NextResponse.json({ ok: hb.healthy, data: hb, fetchedAt: Date.now() }, { status: hb.healthy ? 200 : 503 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Heartbeat failed" },
      { status: 503 },
    );
  }
}
