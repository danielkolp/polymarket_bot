/**
 * Centralized "can the bot open a new BUY right now?" evaluator.
 *
 * Default rule (from the real-money readiness plan): if any live data source,
 * position state, balance state, reconciliation state, or risk gate is uncertain,
 * the bot must refuse NEW BUYs. SELL / flatten / read-only recovery stay allowed
 * and are intentionally NOT gated here.
 *
 * This function is pure (no I/O) so it can be unit-tested exhaustively and reused
 * by both the bot loop's BUY path and the /api/bot/readiness route.
 */
import { config } from "@/lib/config";
import { tradeIsAuthoritative, tradeIsUnsafeForAccounting } from "./ledger";
import type {
  BotSettings,
  BotState,
  BuyReadiness,
  CopyTradeRecord,
  LivePositionReconciliation,
  ReadinessGate,
} from "./types";

export interface ReadinessThresholds {
  pendingStaleSeconds: number;
  maxUnreconciledOrders: number;
  livePositionsStaleSeconds: number;
}

export function defaultReadinessThresholds(): ReadinessThresholds {
  return {
    pendingStaleSeconds: config.livePendingStaleSeconds,
    maxUnreconciledOrders: config.liveMaxUnreconciledOrders,
    livePositionsStaleSeconds: config.livePositionsStaleSeconds,
  };
}

export interface ReadinessInput {
  settings: BotSettings;
  state: BotState;
  trades: CopyTradeRecord[];
  livePositions: LivePositionReconciliation | null;
  now?: number;
  thresholds?: Partial<ReadinessThresholds>;
}

function gate(code: string, label: string, ok: boolean, severity: ReadinessGate["severity"], detail: string): ReadinessGate {
  return { code, label, ok, severity, detail };
}

export function evaluateBuyReadiness(input: ReadinessInput): BuyReadiness {
  const { settings, state, trades, livePositions } = input;
  const now = input.now ?? Date.now();
  const t = { ...defaultReadinessThresholds(), ...input.thresholds };
  const real = settings.mode === "real";
  const gates: ReadinessGate[] = [];
  const dailyLossCapValid = Number.isFinite(settings.maxDailyLossPercent) && settings.maxDailyLossPercent > 0;

  // ── Apply to every mode ─────────────────────────────────────────────────────
  gates.push(
    gate("panic", "Panic stop", !state.panic, "block", state.panic ? state.panicReason ?? "Panic stop is engaged." : "Not engaged."),
  );
  gates.push(
    gate(
      "daily-loss-cap-configured",
      "Daily-loss cap configured",
      dailyLossCapValid,
      "block",
      dailyLossCapValid
        ? `${settings.maxDailyLossPercent}% daily-loss cap configured.`
        : `Daily-loss cap is ${settings.maxDailyLossPercent}%; set it above 0% before opening new BUYs.`,
    ),
  );
  gates.push(
    gate(
      "daily-loss-lockout",
      "Daily-loss lockout",
      !state.dailyLossLockout,
      "block",
      state.dailyLossLockout ? "Daily-loss lockout active; new BUYs disabled until the next day." : "Within daily loss cap.",
    ),
  );
  // ── Real-mode-only live-state gates ─────────────────────────────────────────
  if (real) {
    const realCopied = trades.filter((r) => r.mode === "real" && r.status === "copied");
    const unsafe = realCopied.filter(tradeIsUnsafeForAccounting);
    const unmatchedOrErrored = unsafe.filter(
      (r) => r.reconciliationStatus === "unmatched" || r.reconciliationStatus === "error",
    );
    const unreconciledCount = realCopied.filter((r) => !tradeIsAuthoritative(r)).length;
    const stalePending = realCopied.filter(
      (r) =>
        r.side === "BUY" &&
        (r.reconciliationStatus == null || r.reconciliationStatus === "pending") &&
        now - r.processedAt > t.pendingStaleSeconds * 1000,
    );

    gates.push(
      gate(
        "reconciliation-clean",
        "Live fills reconciled",
        unmatchedOrErrored.length === 0,
        "block",
        unmatchedOrErrored.length === 0
          ? "No unmatched/errored live orders."
          : `${unmatchedOrErrored.length} live order(s) are unmatched/errored against the CLOB.`,
      ),
    );
    gates.push(
      gate(
        "no-stale-pending",
        "No stale pending orders",
        stalePending.length === 0,
        "block",
        stalePending.length === 0
          ? "No live BUY pending past the staleness window."
          : `${stalePending.length} live BUY(s) still pending after ${t.pendingStaleSeconds}s.`,
      ),
    );
    if (t.maxUnreconciledOrders > 0) {
      gates.push(
        gate(
          "unreconciled-cap",
          "Unreconciled order cap",
          unreconciledCount < t.maxUnreconciledOrders,
          "block",
          `${unreconciledCount} unreconciled live order(s) (cap ${t.maxUnreconciledOrders}).`,
        ),
      );
    }

    // Live positions must be present, healthy, and fresh.
    const haveSnapshot = livePositions != null && livePositions.ok;
    gates.push(
      gate(
        "live-positions-fetched",
        "Live positions fetched",
        haveSnapshot,
        "block",
        haveSnapshot
          ? "Authoritative account positions loaded."
          : livePositions?.error
            ? `Live position fetch failed: ${livePositions.error}`
            : "Live account positions have not been reconciled yet.",
      ),
    );
    if (haveSnapshot) {
      const ageMs = now - livePositions!.fetchedAt;
      const fresh = ageMs <= t.livePositionsStaleSeconds * 1000;
      gates.push(
        gate(
          "live-positions-fresh",
          "Live positions fresh",
          fresh,
          "block",
          fresh
            ? `Snapshot ${Math.round(ageMs / 1000)}s old.`
            : `Live position snapshot is stale (${Math.round(ageMs / 1000)}s > ${t.livePositionsStaleSeconds}s).`,
        ),
      );
      gates.push(
        gate(
          "no-unknown-positions",
          "No unknown live positions",
          livePositions!.unknownPositionCount === 0,
          "block",
          livePositions!.unknownPositionCount === 0
            ? "No unknown/manual live positions."
            : `${livePositions!.unknownPositionCount} unknown live position(s); mark them manual/adopt before new BUYs.`,
        ),
      );
      gates.push(
        gate(
          "no-stale-local-positions",
          "No stale local positions",
          livePositions!.stalePositionCount === 0,
          "warn",
          livePositions!.stalePositionCount === 0
            ? "Local positions match the account."
            : `${livePositions!.stalePositionCount} stale local position(s) not seen on-chain.`,
        ),
      );
      if (livePositions!.redeemableCount > 0) {
        // Resolved/won positions are NOT a problem and need no operator action:
        // Polymarket auto-redeems winning positions to cash when the market
        // closes. Surface it as a satisfied, informational gate — never a warning
        // or a block on new BUYs.
        gates.push(
          gate(
            "redeemable-positions",
            "Redeemable positions",
            true,
            "warn",
            `${livePositions!.redeemableCount} resolved position(s) will auto-redeem to cash on settlement; no action needed.`,
          ),
        );
      }
    }
  }

  const blockers = gates.filter((g) => !g.ok && g.severity === "block");
  const warnings = gates.filter((g) => !g.ok && g.severity === "warn");
  return {
    mode: settings.mode,
    buysAllowed: blockers.length === 0,
    evaluatedAt: now,
    gates,
    blockers,
    warnings,
  };
}
