import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { mutationGuard } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Emergency kill switch.
 *
 *   POST /api/bot/panic            → engage panic stop (halt new BUYs)
 *   POST /api/bot/panic { flatten: true, confirmFlatten: "FLATTEN" }
 *                                  → also liquidate open positions
 *   POST /api/bot/panic { resume: true }
 *                                  → clear a latched panic stop
 *
 * Panic state is persisted, so a server restart never silently resumes trading.
 */
export async function POST(req: Request) {
  const blocked = mutationGuard(req);
  if (blocked) return blocked;
  try {
    let body: { flatten?: boolean; confirmFlatten?: string; reason?: string; resume?: boolean } = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object") body = parsed as typeof body;
    } catch {
      // No body — bare panic engage.
    }

    const engine = getCopyBotEngine();
    const data = body.resume
      ? await engine.resumeFromPanic()
      : await engine.panic({ flatten: body.flatten, confirmFlatten: body.confirmFlatten, reason: body.reason });

    return NextResponse.json({ ok: true, data, fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to process panic request" },
      { status: 500 },
    );
  }
}
