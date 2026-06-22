"use client";

import { useEffect } from "react";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { useAnimationControls, motion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * Direction-aware animated trend arrow (lucide-react + motion). The icon replays
 * a short "tick" animation whenever the underlying value changes — so it visibly
 * reacts on each live update — and also animates on hover. Flat renders a static
 * dash. Honors prefers-reduced-motion.
 *
 * Note: deliberately built from `lucide-react` + `motion` (both reputable,
 * already-vendored deps) rather than the unmaintained/unattributed
 * `lucide-animated` package, which was removed during the dependency audit.
 */
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
  const controls = useAnimationControls();

  // Replay the animation whenever the value moves (up = nudge up, down = nudge down).
  useEffect(() => {
    if (v === 0 || prefersReducedMotion()) return;
    const dy = v > 0 ? -3 : 3;
    void controls.start({ y: [0, dy, 0], transition: { duration: 0.4, ease: "easeOut" } });
  }, [v, controls]);

  if (v === 0) {
    return (
      <Minus className={cn("shrink-0 text-muted-foreground", className)} style={{ width: size, height: size }} />
    );
  }

  const Icon = v > 0 ? TrendingUp : TrendingDown;
  return (
    <motion.span
      animate={controls}
      whileHover={{ y: v > 0 ? -2 : 2 }}
      className={cn(
        "inline-flex shrink-0 items-center",
        v > 0 ? "text-success" : "text-destructive",
        className,
      )}
    >
      <Icon style={{ width: size, height: size }} />
    </motion.span>
  );
}
