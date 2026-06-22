"use client";

import { useEffect, useRef } from "react";
import { TrendingDownIcon, TrendingUpIcon } from "lucide-animated";
import { Minus } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Direction-aware animated trend arrow (lucide-animated + motion). The icon
 * replays its animation whenever the underlying value changes — so it visibly
 * "ticks" on each live update — and also animates on hover. Flat renders a static
 * dash. Honors prefers-reduced-motion.
 */
interface AnimHandle {
  startAnimation: () => void;
  stopAnimation: () => void;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

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
  const handle = useRef<AnimHandle | null>(null);

  // Replay the animation on mount and whenever the value moves.
  useEffect(() => {
    if (v === 0 || prefersReducedMotion()) return;
    handle.current?.startAnimation();
  }, [v]);

  if (v > 0) {
    return (
      <TrendingUpIcon
        ref={(h) => {
          handle.current = (h as AnimHandle | null) ?? null;
        }}
        size={size}
        animateOnHover
        className={cn("inline-flex shrink-0 items-center text-success", className)}
      />
    );
  }
  if (v < 0) {
    return (
      <TrendingDownIcon
        ref={(h) => {
          handle.current = (h as AnimHandle | null) ?? null;
        }}
        size={size}
        animateOnHover
        className={cn("inline-flex shrink-0 items-center text-destructive", className)}
      />
    );
  }
  return <Minus className={cn("shrink-0 text-muted-foreground", className)} style={{ width: size, height: size }} />;
}
