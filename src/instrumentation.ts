/**
 * Next.js server-boot hook (runs once per server start, Node runtime only).
 *
 * Before this existed, the bot loop only came alive when someone opened the
 * dashboard — and after any restart (crash, deploy, reboot, `npm run dev`
 * reload) the bot was marked "stopped" and stayed that way until a human
 * clicked Start. Now a bot that was running resumes on its own, and stray
 * promise rejections are logged instead of taking the process down.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NEXT_PHASE === "phase-production-build") return;

  const { appendLog } = await import("@/lib/copybot/store");

  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.stack || reason.message : String(reason);
    console.error("[bot] unhandledRejection:", message);
    void appendLog("error", `Unhandled promise rejection (process kept alive): ${message.slice(0, 500)}`).catch(() => {});
  });
  process.on("uncaughtException", (err) => {
    console.error("[bot] uncaughtException:", err);
    void appendLog("error", `Uncaught exception (process kept alive): ${(err.stack || err.message).slice(0, 500)}`).catch(() => {});
  });

  // Give the server a moment to finish booting (and the network to come up on a
  // fresh machine) before resuming; resumeAfterRestart retries with backoff.
  const timer = setTimeout(async () => {
    try {
      const { getCopyBotEngine } = await import("@/lib/copybot/bot");
      await getCopyBotEngine().resumeAfterRestart("server boot");
    } catch (err) {
      console.error("[bot] auto-resume on boot failed:", err);
    }
  }, 3000);
  timer.unref?.();
}
