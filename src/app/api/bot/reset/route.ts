import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wipe simulation results (positions, trades, logs, equity curve, state) to a clean slate. */
export async function POST() {
  try {
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().reset(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to reset simulation" },
      { status: 500 },
    );
  }
}
