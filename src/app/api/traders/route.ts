import { NextResponse } from "next/server";
import { loadTraders } from "@/lib/copybot/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, data: await loadTraders(), fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to load traders" },
      { status: 500 },
    );
  }
}
