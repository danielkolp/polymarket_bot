# pause: stop opening new positions (open positions are kept).
app_curl POST /api/bot/pause >/dev/null && echo "paused"
status_summary
