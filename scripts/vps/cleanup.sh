# cleanup: reclaim disk from caches and logs. Never touches bot data or source.
hr "before"
df -h / | tail -n1
if have apt-get; then
  apt-get clean -y >/dev/null 2>&1 || true
  apt-get autoremove -y --purge >/dev/null 2>&1 || true
  echo "apt cache cleaned, unused packages/kernels removed"
fi
have journalctl && journalctl --vacuum-size=150M 2>&1 | tail -n1
for d in /root/.npm /root/.cache /home/*/.npm /home/*/.cache; do
  [ -d "$d" ] && { echo "removing $(du -sh "$d" | cut -f1) $d"; rm -rf "$d"; }
done
have npm && npm cache clean --force >/dev/null 2>&1 || true
have pm2 && pm2 flush >/dev/null 2>&1 && echo "pm2 logs flushed"
for d in /root/.pm2/logs /home/*/.pm2/logs; do [ -d "$d" ] && find "$d" -type f -name '*.log' -size +5M -exec truncate -s 0 {} \; ; done
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -mtime +3 -delete 2>/dev/null || true
if have snap; then
  snap list --all 2>/dev/null | awk '/disabled/{print $1, $3}' | while read -r n r; do snap remove "$n" --revision="$r" >/dev/null 2>&1 && echo "removed snap $n rev $r"; done
fi
if have docker; then
  docker image prune -f >/dev/null 2>&1 && echo "dangling docker images pruned"
  docker builder prune -f >/dev/null 2>&1 || true
fi
# Old checkout build output (the service runs from /opt/bonk now).
for d in $(legacy_app_dirs | grep -v "^$BONK_ROOT"); do
  for b in "$d/node_modules" "$d/.next"; do
    [ -d "$b" ] && [ -d "$BONK_CURRENT" ] && { echo "removing $(du -sh "$b" | cut -f1) $b"; rm -rf "$b"; }
  done
  for l in "$d"/next-*.log "$d"/*.out "$d"/nohup.out; do [ -f "$l" ] && { echo "removing $(du -sh "$l" | cut -f1) $l"; rm -f "$l"; }; done
done
hr "after"
df -h / | tail -n1
free -m | awk '/Mem:/{printf "ram: %d/%d MB used\n", $3, $2}'
