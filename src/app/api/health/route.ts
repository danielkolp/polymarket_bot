/**
 * GET /api/health — upstream reachability + config/flag status for the UI.
 */
import { NextResponse } from "next/server";
import { config } from "@/lib/config";
import { fetchMarkets } from "@/lib/polymarket/gamma";

export const dynamic = "force-dynamic";

export async function GET() {
  let gammaOk = false;
  let gammaError: string | null = null;
  try {
    const markets = await fetchMarkets({ limit: 1 });
    gammaOk = markets.length >= 0;
  } catch (err) {
    gammaError = err instanceof Error ? err.message : "unknown error";
  }

  return NextResponse.json({
    ok: true,
    data: {
      appName: config.appName,
      realTradingEnabled: config.enableRealTrading,
      simulationOnly: !config.enableRealTrading,
      upstream: { gamma: gammaOk, gammaError },
      time: Date.now(),
    },
    fetchedAt: Date.now(),
  });
}
