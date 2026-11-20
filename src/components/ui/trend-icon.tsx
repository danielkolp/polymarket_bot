import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Direction-aware trend arrow: up (green), down (red) or flat (muted dash).
 * Static on purpose — the animated version pulled in a whole animation library
 * for one icon.
 */
export function TrendIcon({
  value,
  size = 14,
  className,
}: {
  value: number | null | undefined;
  size?: number;
  className?: string;
}) {
  const v = value ?? 0;
  if (v === 0) {
    return <Minus className={cn("shrink-0 text-muted-foreground", className)} style={{ width: size, height: size }} />;
  }
  const Icon = v > 0 ? TrendingUp : TrendingDown;
  return (
    <span className={cn("inline-flex shrink-0 items-center", v > 0 ? "text-success" : "text-destructive", className)}>
      <Icon style={{ width: size, height: size }} />
    </span>
  );
}
