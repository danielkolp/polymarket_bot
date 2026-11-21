# paper: switch the bot to paper trading (no real orders) on the Safe trade
# rules with paper evaluation settings, and keep it running. Real-money positions, if
# any, are left untouched. Switch back with the go-live task.
set -u
systemctl is-active --quiet bonk || { echo "::error::bonk service is not running - deploy first"; exit 1; }
hr "switch to paper trading"
app_curl POST /api/settings '{"riskPreset":"safe","mode":"simulation","startingBalance":50}' >/dev/null && echo "settings applied"
# Paper evaluation settings: same trade-quality rules as Safe (price band, 2c
# price cap, cost limit, 14-day limit, $3 max per trade), minus the throttles
# that only exist because the real account is $50 (5% per-market cap vs the
# 5-share minimum, 8 open positions, 16 traders). Return per dollar copied does
# not depend on the bankroll. go-live re-applies the full Safe preset.
app_curl POST /api/settings '{"startingBalance":500,"maxOpenPositions":40,"topTradersToFollow":30}' >/dev/null && echo "paper evaluation settings applied (bankroll 500, 40 positions, 30 traders)"
out="$(app_curl POST /api/bot/start)"
if printf '%s' "$out" | grep -q '"ok":true'; then echo "bot running in paper mode"; else echo "start response: $(printf '%s' "$out" | head -c 300)"; fi
sleep 20
status_summary
