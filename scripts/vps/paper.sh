# paper: switch the bot to paper trading (no real orders) on the Safe preset,
# with a $50 paper bankroll, and keep it running. Real-money positions, if
# any, are left untouched. Switch back with the go-live task.
set -u
systemctl is-active --quiet bonk || { echo "::error::bonk service is not running - deploy first"; exit 1; }
hr "switch to paper trading"
app_curl POST /api/settings '{"riskPreset":"safe","mode":"simulation","startingBalance":50}' >/dev/null && echo "settings applied"
out="$(app_curl POST /api/bot/start)"
if printf '%s' "$out" | grep -q '"ok":true'; then echo "bot running in paper mode"; else echo "start response: $(printf '%s' "$out" | head -c 300)"; fi
sleep 20
status_summary
