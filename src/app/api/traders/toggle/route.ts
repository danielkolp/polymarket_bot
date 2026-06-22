import { NextRequest, NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { appendLog, loadTraders, saveTraders } from "@/lib/copybot/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { wallet?: string; enabled?: boolean; pinned?: boolean };
    const wallet = body.wallet?.trim().toLowerCase();
    if (!wallet) throw new Error("Missing wallet.");
    const traders = await loadTraders();

    // Pin/unpin is a distinct operation from enable/disable. Pinning a wallet
    // exempts it from copy-score auto-disable (and clears any active auto-disable).
    if (body.pinned !== undefined) {
      await saveTraders(
        traders.map((trader) =>
          trader.wallet === wallet
            ? {
                ...trader,
                pinned: body.pinned,
                autoDisabled: body.pinned ? false : trader.autoDisabled,
                autoDisableReason: body.pinned ? null : trader.autoDisableReason,
                updatedAt: Date.now(),
              }
            : trader,
        ),
      );
      await appendLog("info", `${body.pinned ? "Pinned" : "Unpinned"} trader ${wallet}.`);
      return NextResponse.json({ ok: true, data: await getCopyBotEngine().status(), fetchedAt: Date.now() });
    }

    const enabled = body.enabled ?? !traders.find((t) => t.wallet === wallet)?.enabled;
    await saveTraders(
      traders.map((trader) =>
        trader.wallet === wallet
          ? {
              ...trader,
              enabled,
              // Manually re-enabling clears a scoring auto-disable so the operator's
              // decision wins until the next scoring pass.
              autoDisabled: enabled ? false : trader.autoDisabled,
              autoDisableReason: enabled ? null : trader.autoDisableReason,
              updatedAt: Date.now(),
            }
          : trader,
      ),
    );
    await appendLog("info", `${enabled ? "Enabled" : "Disabled"} trader ${wallet}.`);
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().status(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to toggle trader" },
      { status: 400 },
    );
  }
}
