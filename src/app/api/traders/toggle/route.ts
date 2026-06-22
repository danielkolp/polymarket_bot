import { NextRequest, NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { appendLog, loadTraders, saveTraders } from "@/lib/copybot/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { wallet?: string; enabled?: boolean };
    const wallet = body.wallet?.trim().toLowerCase();
    if (!wallet) throw new Error("Missing wallet.");
    const traders = await loadTraders();
    await saveTraders(
      traders.map((trader) =>
        trader.wallet === wallet ? { ...trader, enabled: body.enabled ?? !trader.enabled, updatedAt: Date.now() } : trader,
      ),
    );
    await appendLog("info", `${body.enabled ? "Enabled" : "Disabled"} trader ${wallet}.`);
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().status(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to toggle trader" },
      { status: 400 },
    );
  }
}
