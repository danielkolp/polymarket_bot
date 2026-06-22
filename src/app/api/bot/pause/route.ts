import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().pause(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to pause bot" },
      { status: 500 },
    );
  }
}
