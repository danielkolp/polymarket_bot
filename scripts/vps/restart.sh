# restart: restart the service and wait for health (tests auto-resume).
systemctl restart bonk
for i in $(seq 1 30); do
  sleep 5
  code="$(curl -s -o /tmp/bonk-health.json -m 10 -w '%{http_code}' "http://127.0.0.1:$(app_port)/api/health" || echo 000)"
  if [ "$code" = "200" ] && grep -q '"heartbeatAgeSec":[0-9]' /tmp/bonk-health.json; then break; fi
done
echo "health ($code):"; cat /tmp/bonk-health.json; echo
status_summary
