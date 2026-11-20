/**
 * Optional push alerts so you find out when the bot needs attention instead of
 * discovering hours later that it silently stopped.
 *
 * Configure either (or both):
 *  - ALERT_WEBHOOK_URL: a Discord or Slack incoming-webhook URL (payload carries
 *    both `content` and `text`, so either service accepts it);
 *  - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID.
 *
 * Alerts are best-effort: they never throw and never block the trading loop,
 * and each alert key is rate-limited so an outage can't spam you.
 */
import { config } from "@/lib/config";

export type AlertLevel = "info" | "warning" | "critical";

const DEFAULT_COOLDOWN_MS = 15 * 60 * 1000;
const lastSentAt = new Map<string, number>();

export function alertsConfigured(): boolean {
  return Boolean(config.alertWebhookUrl || (config.telegramBotToken && config.telegramChatId));
}

const ICON: Record<AlertLevel, string> = { info: "ℹ️", warning: "⚠️", critical: "🚨" };

/**
 * Send an alert. `key` groups repeats for rate limiting (defaults to the title);
 * pass `cooldownMs: 0` for one-off events that should always go out.
 */
export async function sendAlert(
  level: AlertLevel,
  title: string,
  message: string,
  opts: { key?: string; cooldownMs?: number } = {},
): Promise<void> {
  if (!alertsConfigured()) return;
  const key = opts.key ?? title;
  const cooldownMs = opts.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const now = Date.now();
  const last = lastSentAt.get(key) ?? 0;
  if (cooldownMs > 0 && now - last < cooldownMs) return;
  lastSentAt.set(key, now);

  const text = `${ICON[level]} [${config.appName}] ${title}\n${message}`.slice(0, 1900);
  const sends: Promise<unknown>[] = [];
  if (config.alertWebhookUrl) {
    sends.push(
      fetch(config.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text, text }),
        signal: AbortSignal.timeout(5000),
      }),
    );
  }
  if (config.telegramBotToken && config.telegramChatId) {
    sends.push(
      fetch(`https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(5000),
      }),
    );
  }
  await Promise.allSettled(sends);
}

/** Test hook. */
export function resetAlertCooldowns(): void {
  lastSentAt.clear();
}
