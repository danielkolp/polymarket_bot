import { NextResponse } from "next/server";
import { loadPositions, loadSettings, loadTrades } from "@/lib/copybot/store";
import { calculateAvailableBalance } from "@/lib/copybot/accounting";
import { loadAnalyticsBundle } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Analytics dashboard payload: dashboard summary + trader/category/portfolio/
 * correlation analytics. Read-only and network-free (cash is derived from local
 * accounting), so it is safe to poll.
 */
export async function GET() {
  try {
    const [settings, positions, trades] = await Promise.all([loadSettings(), loadPositions(), loadTrades()]);
    const cashUsd = calculateAvailableBalance(settings, positions, trades);
    const bundle = await loadAnalyticsBundle(positions, cashUsd);
    return NextResponse.json({
      ok: true,
      data: {
        dashboard: bundle.dashboard,
        traders: bundle.traders,
        categories: bundle.categories,
        portfolio: bundle.portfolio,
        correlation: bundle.correlation,
        completedTradeCount: bundle.completed.length,
      },
      fetchedAt: Date.now(),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to load analytics summary" },
      { status: 500 },
    );
  }
}
