# go-live: switch the bot to real money on the Safe preset and start it.
# Checks the env (names/flags only), raises a too-small LIVE_MAX_ORDER_USD,
# then uses the local API (no Basic auth hop). Never prints secrets/balances.
set -u
ENVF="$BONK_SHARED/.env.local"
[ -f "$ENVF" ] || { echo "::error::$ENVF missing - deploy first"; exit 1; }
systemctl is-active --quiet bonk || { echo "::error::bonk service is not running - deploy first"; exit 1; }

hr "env check"
env_summary "$ENVF" | grep -E 'ENABLE_REAL_TRADING|POLYMARKET_PRIVATE_KEY|POLYMARKET_FUNDER_ADDRESS|POLYMARKET_SIGNATURE_TYPE|LIVE_MAX_ORDER_USD|DASHBOARD_AUTH_TOKEN|ANALYTICS_EXPORT_TOKEN'
problems=""
[ "$(env_get "$ENVF" ENABLE_REAL_TRADING)" = "true" ] || problems="$problems ENABLE_REAL_TRADING!=true"
[ -n "$(env_get "$ENVF" POLYMARKET_PRIVATE_KEY)" ] || problems="$problems POLYMARKET_PRIVATE_KEY-missing"
sig="$(env_get "$ENVF" POLYMARKET_SIGNATURE_TYPE)"
if [ "${sig:-0}" != "0" ] && [ -z "$(env_get "$ENVF" POLYMARKET_FUNDER_ADDRESS)" ]; then problems="$problems POLYMARKET_FUNDER_ADDRESS-missing"; fi
if [ -n "$problems" ]; then
  echo "::error::Cannot go live:$problems"
  exit 1
fi

changed=0
cap="$(env_get "$ENVF" LIVE_MAX_ORDER_USD)"
if [ -z "$cap" ] || awk "BEGIN{exit !($cap < 5)}"; then
  cp -p "$ENVF" "$ENVF.bak.$(date +%s)"
  if grep -qE '^[[:space:]]*LIVE_MAX_ORDER_USD=' "$ENVF"; then
    sed -i -E 's/^[[:space:]]*LIVE_MAX_ORDER_USD=.*/LIVE_MAX_ORDER_USD=10/' "$ENVF"
  else
    printf '\nLIVE_MAX_ORDER_USD=10\n' >> "$ENVF"
  fi
  echo "LIVE_MAX_ORDER_USD raised to 10 (Polymarket orders need ~5 shares)"
  changed=1
fi
if [ "$changed" = 1 ]; then
  systemctl restart bonk
  sleep 15
fi

hr "switch to Safe + real money"
app_curl POST /api/settings '{"riskPreset":"safe","mode":"real","depositBaselineUsd":50}' | head -c 0
echo "settings applied"
hr "start"
out="$(app_curl POST /api/bot/start)"
if printf '%s' "$out" | grep -q '"ok":true'; then echo "bot started"; else echo "start response: $(printf '%s' "$out" | head -c 400)"; fi
sleep 30
status_summary
