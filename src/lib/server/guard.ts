/**
 * Security guard for mutating API routes (start/stop/reset/settings/traders/
 * panic/flatten/...). Layers, cheapest-first:
 *
 *  1. Same-origin (CSRF) check: if the browser sent an Origin/Referer, its host
 *     must match the request Host. Cross-site form/script POSTs are rejected.
 *  2. Optional shared-secret auth: when DASHBOARD_AUTH_TOKEN is set, the request
 *     must present it via the `x-dashboard-token` header or `dashboard_token`
 *     cookie (constant-time compared).
 *  3. In-memory rate limiting per client+route.
 *
 * SERVER-ONLY. Returns a NextResponse to short-circuit the route when blocked, or
 * null when the request may proceed. Never leaks the configured token.
 */
import { NextResponse } from "next/server";
import { config } from "@/lib/config";

const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40;
const buckets = new Map<string, { count: number; resetAt: number }>();

function hostOf(value: string | null): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function clientKey(req: Request, pathname: string): string {
  const fwd = req.headers.get("x-forwarded-for");
  const ip = (fwd ? fwd.split(",")[0] : "") || req.headers.get("x-real-ip") || "local";
  return `${ip.trim()}::${pathname}`;
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function deny(reason: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: reason }, { status });
}

/**
 * Enforce the mutation guard. Returns a NextResponse when the request must be
 * rejected, or null when it may proceed.
 */
export function mutationGuard(req: Request): NextResponse | null {
  const url = new URL(req.url);
  const pathname = url.pathname;

  // 1) Same-origin / CSRF. Only enforced when the browser provided an origin.
  const requestHost = req.headers.get("host");
  const originHost = hostOf(req.headers.get("origin")) ?? hostOf(req.headers.get("referer"));
  if (originHost && requestHost && originHost !== requestHost) {
    return deny("Cross-origin request rejected.", 403);
  }

  // 2) Optional shared-secret auth.
  const expected = config.dashboardAuthToken.trim();
  if (expected) {
    const headerToken = req.headers.get("x-dashboard-token")?.trim() ?? "";
    const cookieToken = parseCookies(req.headers.get("cookie")).dashboard_token?.trim() ?? "";
    const provided = headerToken || cookieToken;
    if (!provided || !constantTimeEqual(provided, expected)) {
      return deny("Unauthorized: missing or invalid dashboard token.", 401);
    }
  }

  // 3) Rate limiting.
  const key = clientKey(req, pathname);
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
  } else {
    bucket.count += 1;
    if (bucket.count > RATE_MAX) {
      return deny("Too many requests. Slow down.", 429);
    }
  }

  return null;
}
