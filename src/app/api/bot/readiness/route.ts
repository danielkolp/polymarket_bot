import { NextResponse } from "next/server";
import { getCopyBotEngine } from "@/lib/copybot/bot";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Structured live-readiness checklist: can the bot open a new BUY right now, and
 * if not, exactly why. SELL / flatten / read-only actions are not gated by this.
 */
export async function GET() {
  try {
    const status = await getCopyBotEngine().status();
    return NextResponse.json({
      ok: true,
      data: {
        buyReadiness: status.buyReadiness,
        realTradingEnabled: status.realTradingEnabled,
        simulationOnly: status.simulationOnly,
        accountingConfidence: status.metrics.accountingConfidence,
        unreconciledLiveOrders: status.metrics.unreconciledLiveOrders,
        panic: status.metrics.panic,
        dailyLossLockout: status.metrics.dailyLossLockout,
        livePositions: status.livePositions,
      },
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to evaluate readiness" },
      { status: 500 },
    );
  }
}
