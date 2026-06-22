import { NextRequest, NextResponse } from "next/server";
import { loadSettings } from "@/lib/copybot/store";
import { recoverPortfolio } from "@/lib/recovery/recover";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isWallet(value: string): boolean {
  return /^0x[a-f0-9]{40}$/.test(value);
}

/**
 * Read-only portfolio recovery for a connected wallet. Returns an analyzed
 * snapshot of the account's existing positions. Never places orders.
 */
export async function GET(req: NextRequest) {
  try {
    const wallet = (req.nextUrl.searchParams.get("wallet") ?? "").trim().toLowerCase();
    if (!wallet) {
      return NextResponse.json({ ok: false, error: "Provide a wallet address to recover positions." }, { status: 400 });
    }
    if (!isWallet(wallet)) {
      return NextResponse.json({ ok: false, error: "Wallet must be a 0x-prefixed 40-hex address." }, { status: 400 });
    }

    const settings = await loadSettings();
    const snapshot = await recoverPortfolio(wallet, settings);
    return NextResponse.json({ ok: true, data: snapshot, fetchedAt: Date.now() });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Failed to recover portfolio" },
      { status: 502 },
    );
  }
}
