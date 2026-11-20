#!/usr/bin/env bash
# Restart bonk when /api/health says the poll loop is stuck (HTTP 503) or the
# server stops answering while the unit is active, twice in a row.
set -u
PORT="$(grep -E '^PORT=' /srv/bonk/shared/runtime.env 2>/dev/null | cut -d= -f2)"
PORT="${PORT:-3000}"
COUNT_FILE=/run/bonk-watchdog.count
systemctl is-active --quiet bonk || exit 0
code="$(curl -s -o /dev/null -m 20 -w '%{http_code}' "http://127.0.0.1:${PORT}/api/health" || echo 000)"
if [ "$code" = "200" ]; then
  echo 0 > "$COUNT_FILE"
  exit 0
fi
n="$(cat "$COUNT_FILE" 2>/dev/null || echo 0)"
n=$((n + 1))
echo "$n" > "$COUNT_FILE"
echo "bonk health returned $code (strike $n)"
if [ "$n" -ge 2 ]; then
  echo "restarting bonk"
  echo 0 > "$COUNT_FILE"
  systemctl restart bonk
fi
