import { NextRequest, NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { loadSettings } from "@/lib/copybot/store";
import type { BotSettings } from "@/lib/copybot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: await loadSettings(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to load settings" },
      { status: 500 },
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const patch = (await req.json()) as Partial<BotSettings>;
    return NextResponse.json({
      ok: true,
      data: await getCopyBotEngine().updateSettings(patch),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to update settings" },
      { status: 400 },
    );
  }
}
