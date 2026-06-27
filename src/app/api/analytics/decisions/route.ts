import { NextResponse } from "next/server";
import { ANALYTICS_FILES, readNdjson } from "@/lib/analytics";
import type { DecisionRecord } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Query the decision log. Supports filtering by action / reason code / wallet /
 * category / mode and a tail `limit` (default 500, max 5000). Returns most-recent
 * first so the dashboard can render without re-sorting.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action")?.toUpperCase();
    const reasonCode = url.searchParams.get("reasonCode");
    const wallet = url.searchParams.get("wallet")?.toLowerCase();
    const category = url.searchParams.get("category");
    const mode = url.searchParams.get("mode");
    const limit = Math.min(5000, Math.max(1, Number(url.searchParams.get("limit") ?? 500) || 500));

    const rows = await readNdjson<DecisionRecord>(ANALYTICS_FILES.decisions, {
      limit,
      filter: (d) => {
        if (action && d.action !== action) return false;
        if (reasonCode && d.reasonCode !== reasonCode) return false;
        if (wallet && d.copiedWallet.toLowerCase() !== wallet) return false;
        if (category && d.market.category !== category) return false;
        if (mode && d.mode !== mode) return false;
        return true;
      },
    });

    return NextResponse.json({ ok: true, data: rows.reverse(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to load decisions" },
      { status: 500 },
    );
  }
}
