/** Formatting helpers for currency, percentages, prices, and compact numbers. */

export function usd(value: number, fractionDigits = 2): string {
  if (!Number.isFinite(value)) return "$0.00";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function compactUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function compactNum(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

/** Format a 0..1 probability/price as cents (e.g. 0.42 -> "42.0¢"). */
export function cents(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}¢`;
}

export function pct(value: number, fractionDigits = 1): string {
  if (!Number.isFinite(value)) return "0%";
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

export function signedUsd(value: number): string {
  const s = usd(Math.abs(value));
  return value < 0 ? `-${s}` : `+${s}`;
}

export function signedPct(value: number, fractionDigits = 1): string {
  const s = pct(Math.abs(value), fractionDigits);
  return value < 0 ? `-${s}` : `+${s}`;
}
