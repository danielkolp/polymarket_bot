import { NextResponse } from "next/server";
import { loadPositions, loadSettings, loadTrades } from "@/lib/copybot/store";
import { calculateAvailableBalance } from "@/lib/copybot/accounting";
import { buildAnalyticsExport } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Full analytics export as a single JSON document, intended for download and
 * upload into an LLM for strategy analysis. `?download=1` sets a filename;
 * `?maxDecisions=N` caps the raw decision log; `?decisions=0` omits it.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const maxDecisions = Number(url.searchParams.get("maxDecisions") ?? 0) || 0;
    const includeDecisions = url.searchParams.get("decisions") !== "0";
    const download = url.searchParams.get("download") === "1";

    const [settings, positions, trades] = await Promise.all([loadSettings(), loadPositions(), loadTrades()]);
    const cashUsd = calculateAvailableBalance(settings, positions, trades);
    const data = await buildAnalyticsExport(positions, cashUsd, { maxDecisions, includeDecisions });

    const headers: Record<string, string> = { "content-type": "application/json" };
    if (download) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      headers["content-disposition"] = `attachment; filename="bonk-analytics-${stamp}.json"`;
    }
    return new NextResponse(JSON.stringify(data, null, 2), { status: 200, headers });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to build analytics export" },
      { status: 500 },
    );
  }
}
