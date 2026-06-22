import { NextRequest, NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { wallet?: string; name?: string };
    if (!body.wallet) throw new Error("Missing wallet.");
    return NextResponse.json({
      ok: true,
      data: await getCopyBotEngine().addTrader(body.wallet, body.name),
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to add trader" },
      { status: 400 },
    );
  }
}
