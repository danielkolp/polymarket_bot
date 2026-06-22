import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { mutationGuard } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pull live Polymarket marks for open positions and recompute equity. */
export async function POST(req: Request) {
  const blocked = mutationGuard(req);
  if (blocked) return blocked;
  try {
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().refreshMarks(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to refresh marks" },
      { status: 500 },
    );
  }
}
