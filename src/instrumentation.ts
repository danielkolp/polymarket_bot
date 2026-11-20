/**
 * Next.js server boot hook. Runs once per server process (Node runtime only).
 *
 * - Brings the bot back automatically after a restart/deploy/crash when the
 *   operator last left it running (never overrides a panic stop).
 * - Logs unhandled promise rejections / exceptions instead of letting a stray
 *   error take the whole process (and the bot) down silently.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  process.on("unhandledRejection", (reason) => {
    console.error("[bonk] unhandled rejection:", reason instanceof Error ? reason.stack ?? reason.message : reason);
  });
  process.on("uncaughtException", (err) => {
    console.error("[bonk] uncaught exception:", err.stack ?? err.message);
  });

  if (process.env.BONK_DISABLE_AUTORESUME === "true") return;
  // Give the HTTP server a moment to come up, then resume.
  setTimeout(() => {
    void import("@/lib/copybot/bot")
      .then(({ getCopyBotEngine }) => getCopyBotEngine().resumeIfDesired())
      .catch((err) => console.error("[bonk] auto-resume failed:", err));
  }, 3_000).unref?.();
}
