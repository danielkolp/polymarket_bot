import { NextRequest, NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { mutationGuard } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const blocked = mutationGuard(req);
  if (blocked) return blocked;
  try {
    const body = (await req.json()) as { wallet?: string };
    if (!body.wallet) throw new Error("Missing wallet.");
    return NextResponse.json({
      ok: true,
      data: await getCopyBotEngine().removeTrader(body.wallet),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to remove trader" },
      { status: 400 },
    );
  }
}
