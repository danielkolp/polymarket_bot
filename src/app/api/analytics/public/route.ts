import { NextResponse } from "next/server";
import { loadPositions, loadSettings, loadTrades } from "@/lib/copybot/store";
import { calculateAvailableBalance } from "@/lib/copybot/accounting";
import { buildAnalyticsExport } from "@/lib/analytics";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public, token-gated analytics export — intended to be served WITHOUT the
 * dashboard's Basic Auth (see the dedicated nginx location) so an external AI can
 * fetch the JSON on a schedule. Access requires `?token=` to match
 * ANALYTICS_EXPORT_TOKEN; when that env var is unset the endpoint is disabled.
 *
 * Defaults to a compact digest (aggregations + completed trades + missed
 * opportunities, no raw decision/exit logs). Pass `?decisions=1` for the full
 * log, or `?maxDecisions=N` to cap it.
 *
 * The in-dashboard export stays at /api/analytics/export (behind login).
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function GET(req: Request) {
  const expected = config.analyticsExportToken.trim();
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "Public analytics export is disabled (ANALYTICS_EXPORT_TOKEN not set)." },
      { status: 404, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }

  const url = new URL(req.url);
  const provided = (url.searchParams.get("token") ?? "").trim();
  if (!provided || !constantTimeEqual(provided, expected)) {
    return NextResponse.json(
      { ok: false, error: "Unauthorized: missing or invalid export token." },
      { status: 401, headers: { "X-Robots-Tag": "noindex, nofollow" } },
    );
  }

  try {
    const includeDecisions = url.searchParams.get("decisions") === "1";
    const maxDecisions = Number(url.searchParams.get("maxDecisions") ?? 0) || 0;
    const download = url.searchParams.get("download") === "1";

    const [settings, positions, trades] = await Promise.all([loadSettings(), loadPositions(), loadTrades()]);
    const cashUsd = calculateAvailableBalance(settings, positions, trades);
    const data = await buildAnalyticsExport(positions, cashUsd, { includeDecisions, maxDecisions });

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": "no-store",
      // Belt-and-suspenders against search-engine indexing of the token URL.
      "X-Robots-Tag": "noindex, nofollow",
    };
    if (download) {
      const stamp = new Date().toISOString().slice(0, 10);
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
