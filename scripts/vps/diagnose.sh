# diagnose: read-only snapshot of VPS health and how the bot is run.
hr "system"
uname -srm
[ -f /etc/os-release ] && . /etc/os-release && echo "OS: ${PRETTY_NAME:-?}"
uptime
nproc | sed 's/^/CPUs: /'

hr "disk"
df -hT -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -h
hr "biggest directories"
du -xh --max-depth=2 / 2>/dev/null | sort -rh | head -n 30
hr "biggest directories under /root /home /opt /var"
for d in /root /home /opt /var /srv /usr/local; do
  [ -d "$d" ] && du -xh --max-depth=2 "$d" 2>/dev/null | sort -rh | head -n 12
done
hr "large files (>100MB)"
find / -xdev -type f -size +100M -printf '%s\t%p\n' 2>/dev/null | sort -rn | head -n 20 | awk -F'\t' '{printf "%7.0fMB  %s\n", $1/1048576, $2}'

hr "caches and logs"
have journalctl && journalctl --disk-usage 2>/dev/null
du -sh /var/cache/apt /var/log /tmp /root/.npm /root/.cache /root/.pm2 /home/*/.npm /home/*/.cache /home/*/.pm2 2>/dev/null
ls /boot 2>/dev/null | grep -E '^vmlinuz' | sed 's/^/kernel: /'
dpkg -l 'linux-image-*' 2>/dev/null | awk '/^ii/{print "installed:", $2}'
have snap && snap list --all 2>/dev/null | head -n 20
have docker && docker system df 2>/dev/null

hr "memory"
free -m
swapon --show 2>/dev/null || true
cat /proc/sys/vm/swappiness 2>/dev/null | sed 's/^/swappiness: /'
hr "top processes by RSS"
ps -eo pid,ppid,rss,etime,comm,args --sort=-rss | head -n 16 | cut -c1-200

hr "runtime"
have node && echo "node $(node -v)" || echo "node: not installed"
have npm && echo "npm $(npm -v 2>/dev/null)"
have pm2 && { echo "pm2 present"; pm2 ls 2>/dev/null | cut -c1-160; }
have nginx && nginx -v 2>&1
systemctl list-units --type=service --state=running --no-pager 2>/dev/null | grep -Ei 'node|bonk|next|pm2|polymarket' || echo "no node-related systemd services"
systemctl list-unit-files --no-pager 2>/dev/null | grep -Ei 'bonk|pm2|polymarket|next' || true
have screen && screen -ls 2>/dev/null | head
have tmux && tmux ls 2>/dev/null | head
echo "-- node processes (cwd + command) --"
for pid in $(pgrep -x node 2>/dev/null; pgrep -f 'next-server|next start|next dev|npm' 2>/dev/null); do
  [ -d "/proc/$pid" ] || continue
  printf 'pid %s rss=%sKB cwd=%s cmd=%s\n' "$pid" "$(awk '/VmRSS/{print $2}' /proc/$pid/status 2>/dev/null)" \
    "$(readlink /proc/$pid/cwd 2>/dev/null)" "$(tr '\0' ' ' < /proc/$pid/cmdline 2>/dev/null | cut -c1-160)"
done | sort -u
echo "-- listening ports --"
ss -ltnp 2>/dev/null | awk 'NR==1 || /node|nginx|next/' | cut -c1-160
echo "-- crontab --"
crontab -l 2>/dev/null | grep -v '^#' | cut -c1-200 || echo "(none)"
ls /etc/cron.d 2>/dev/null

hr "app checkouts"
for d in $(legacy_app_dirs) $( [ -d "$BONK_ROOT" ] && echo "$BONK_ROOT" ); do
  echo "## $d"
  du -sh "$d" "$d/node_modules" "$d/.next" "$d/.next/cache" "$d/data" 2>/dev/null
  [ -d "$d/data" ] && du -ah "$d/data" 2>/dev/null | sort -rh | head -n 15
  ls -la "$d" 2>/dev/null | grep -E '\.log$|\.out$|\.err$' || true
  if [ -d "$d/.git" ]; then
    git -C "$d" log --oneline -1 2>/dev/null | sed 's/^/HEAD: /'
    git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null | sed 's/^/branch: /'
    git -C "$d" status --porcelain 2>/dev/null | head -n 10
  fi
  echo "-- env keys ($d/.env.local) --"
  env_summary "$d/.env.local"
  [ -f "$d/.env" ] && { echo "-- env keys ($d/.env) --"; env_summary "$d/.env"; }
done

hr "nginx sites"
for f in /etc/nginx/sites-enabled/* /etc/nginx/conf.d/*.conf; do
  [ -f "$f" ] || continue
  echo "## $f"
  grep -vE '^\s*(#|$)' "$f" | cut -c1-160
done

hr "polymarket reachability from VPS"
curl -sS -m 15 https://polymarket.com/api/geoblock 2>&1 | head -c 300; echo
curl -sS -m 15 -o /dev/null -w 'clob /time: HTTP %{http_code} in %{time_total}s\n' https://clob.polymarket.com/time 2>&1
curl -sS -m 15 -o /dev/null -w 'data-api: HTTP %{http_code} in %{time_total}s\n' 'https://data-api.polymarket.com/trades?limit=1' 2>&1

hr "bot status (redacted summary)"
status_summary

hr "recent app log lines"
for d in $(legacy_app_dirs); do
  [ -f "$d/data/errors.log" ] && { echo "## $d/data/errors.log (last 25 lines, messages only)"; tail -n 25 "$d/data/errors.log" | cut -c1-220; }
done
have journalctl && journalctl -u bonk --no-pager -n 30 2>/dev/null | cut -c1-220
echo "-- recent OOM kills --"
(journalctl -k --no-pager --since "-14 days" 2>/dev/null || dmesg 2>/dev/null) | grep -iE 'out of memory|oom-kill|killed process' | tail -n 10 | cut -c1-200 || true
echo "done."
