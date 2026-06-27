import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { mutationGuard } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const blocked = mutationGuard(req);
  if (blocked) return blocked;
  try {
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().forceDiscover(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Discovery failed" },
      { status: 500 },
    );
  }
}
