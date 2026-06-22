import { NextResponse } from "next/server";
import { loadLogs } from "@/lib/copybot/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: await loadLogs(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to load logs" },
      { status: 500 },
    );
  }
}
