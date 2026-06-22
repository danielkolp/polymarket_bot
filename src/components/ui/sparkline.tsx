import { cn } from "@/lib/utils";

/**
 * Tiny inline SVG sparkline for a price series. Colors by overall direction
 * (last vs first). No chart library — cheap enough to render per table row.
 */
export function Sparkline({
  data,
  width = 72,
  height = 22,
  className,
}: {
  data: number[];
  width?: number;
  height?: number;
  className?: string;
}) {
  if (!data || data.length < 2) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / (data.length - 1);

  const points = data
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const up = data[data.length - 1] >= data[0];
  const stroke = up ? "hsl(var(--success))" : "hsl(var(--destructive))";

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("overflow-visible", className)}
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
