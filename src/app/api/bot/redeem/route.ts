import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";
import { mutationGuard } from "@/lib/server/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Resolved-position redemption.
 *
 *   GET  /api/bot/redeem            → read-only plan of redeemable winnings
 *   POST /api/bot/redeem            → redeem (real mode). Requires:
 *                                       - dashboard auth (mutationGuard), AND
 *                                       - { confirm: "REDEEM" } in the body.
 *                                     Optional { includeUnknown: true } also
 *                                     redeems unknown/manual positions.
 *
 * Fully-automatic redemption happens on the poll loop only when ENABLE_AUTO_REDEEM
 * is set; this route is the explicit, confirmed manual path.
 */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: await getCopyBotEngine().redeemablePlan(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to build redeemable plan" },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  const blocked = mutationGuard(req);
  if (blocked) return blocked;
  try {
    let body: { confirm?: string; includeUnknown?: boolean } = {};
    try {
      const parsed = await req.json();
      if (parsed && typeof parsed === "object") body = parsed as typeof body;
    } catch {
      // No body — will fail the confirmation check below.
    }

    const result = await getCopyBotEngine().redeemResolved({
      confirm: body.confirm,
      includeUnknown: body.includeUnknown === true,
    });
    if (result.error) {
      return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    }
    return NextResponse.json({ ok: true, data: result, fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to redeem positions" },
      { status: 500 },
    );
  }
}
