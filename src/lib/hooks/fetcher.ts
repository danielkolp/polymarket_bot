"use client";

import type { ApiEnvelope } from "@/lib/polymarket/types";

/** SWR fetcher that unwraps the standard API envelope and throws on errors. */
export async function jsonFetcher<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = (await res.json().catch(() => null)) as ApiEnvelope<T> | null;
  if (!res.ok || !body || body.ok === false) {
    const message = body && body.ok === false ? body.error : `Request failed (${res.status})`;
    throw new Error(message);
  }
  return body.data;
}
