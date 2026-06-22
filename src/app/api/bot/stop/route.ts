import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    let opts: { liquidate?: boolean; source?: "session-close" | "auto-exit" } = {};
    // Body is optional. The window-close beacon and the stop modal both send one;
    // a bare Stop click sends nothing.
    try {
      const body = await req.json();
      if (body && typeof body === "object") opts = body as typeof opts;
    } catch {
      // No/invalid body — fall back to a plain stop.
    }
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().stop(opts), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to stop bot" },
      { status: 500 },
    );
  }
}
