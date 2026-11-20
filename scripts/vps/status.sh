# status: service + bot health summary (no balances, keys or addresses).
hr "service"
systemctl is-active bonk 2>/dev/null | sed 's/^/bonk: /'
systemctl is-active bonk-watchdog.timer 2>/dev/null | sed 's/^/watchdog timer: /'
readlink -f "$BONK_CURRENT" 2>/dev/null | sed 's/^/current release: /'
hr "health"
curl -sS -m 15 "http://127.0.0.1:$(app_port)/api/health"; echo
hr "bot"
status_summary
hr "resources"
df -h / | tail -n1 | awk '{print "disk: " $5 " used (" $4 " free)"}'
free -m | awk '/Mem:/{printf "ram: %d/%d MB used\n", $3, $2} /Swap:/{printf "swap: %d/%d MB used\n", $3, $2}'
systemctl show bonk -p MemoryCurrent --value 2>/dev/null | awk '{ if ($1 ~ /^[0-9]+$/) printf "bonk memory: %d MB\n", $1/1048576 }'
