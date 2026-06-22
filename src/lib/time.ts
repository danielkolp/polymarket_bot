/** Time / duration helpers. */

export function fromNow(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const abs = Math.abs(ms);
  const past = ms < 0;
  const sec = Math.round(abs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  let out: string;
  if (sec < 60) out = `${sec}s`;
  else if (min < 60) out = `${min}m`;
  else if (hr < 48) out = `${hr}h`;
  else out = `${day}d`;

  return past ? `${out} ago` : out;
}

/** Human duration until resolution from a milliseconds-remaining value. */
export function timeToResolution(ms: number | null): string {
  if (ms == null) return "—";
  if (ms <= 0) return "resolved";
  const min = ms / 60000;
  const hr = min / 60;
  const day = hr / 24;
  if (min < 60) return `${Math.round(min)}m`;
  if (hr < 48) return `${Math.round(hr)}h`;
  if (day < 60) return `${Math.round(day)}d`;
  return `${Math.round(day / 30)}mo`;
}

export function ageSeconds(fetchedAtMs: number | null | undefined, now = Date.now()): number {
  if (fetchedAtMs == null) return Infinity;
  return Math.max(0, (now - fetchedAtMs) / 1000);
}
