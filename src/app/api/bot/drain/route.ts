import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import type { BotSettings } from "@/lib/copybot/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enter exit-only ("drain") mode: stop opening new positions, keep auto-selling
 * open ones per the optional take-profit / stop-loss / max-hold rules in the body.
 */
export async function POST(req: Request) {
  try {
    let rules: Partial<BotSettings> | undefined;
    try {
      const body = await req.json();
      if (body && typeof body === "object") rules = body as Partial<BotSettings>;
    } catch {
      // No body — drain using whatever rules are already saved in settings.
    }
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().drain(rules), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to start auto-exit" },
      { status: 400 },
    );
  }
}
