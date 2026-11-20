# deploy-release: install a prebuilt release tarball and switch to it atomically.
# Expects (exported by the workflow): RELEASE_SHA, RELEASE_TARBALL.
# Idempotent. On the first run it migrates the old checkout's .env.local and
# data/ into /opt/bonk/shared and stops the old process. Rolls back
# automatically if the new release doesn't become healthy.
set -euo pipefail

: "${RELEASE_SHA:?missing}"
: "${RELEASE_TARBALL:?missing}"
REL_DIR="$BONK_ROOT/releases/$RELEASE_SHA"
KEEP_RELEASES=2

hr "deploy $RELEASE_SHA"
mkdir -p "$BONK_ROOT/releases" "$BONK_SHARED/data"

# ── 1. Node runtime (standalone server needs Node >= 20.9) ────────────────────
node_major() { node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0; }
if ! have node || [ "$(node_major)" -lt 20 ]; then
  echo "Installing Node.js 22 (found: $(node -v 2>/dev/null || echo none))"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

# ── 2. First-run migration from the old checkout ──────────────────────────────
LEGACY_DIR="$(legacy_app_dirs | grep -v "^$BONK_ROOT" | head -n1 || true)"
if [ ! -f "$BONK_SHARED/.env.local" ]; then
  if [ -n "$LEGACY_DIR" ] && [ -f "$LEGACY_DIR/.env.local" ]; then
    cp -p "$LEGACY_DIR/.env.local" "$BONK_SHARED/.env.local"
    echo "migrated .env.local from the old checkout"
  else
    echo "::error::No .env.local found (expected $BONK_SHARED/.env.local or in the old checkout)."
    exit 1
  fi
fi
chmod 600 "$BONK_SHARED/.env.local"
if [ -n "$LEGACY_DIR" ] && [ -d "$LEGACY_DIR/data" ] && [ ! -f "$BONK_SHARED/data/.migrated" ]; then
  if [ -z "$(ls -A "$BONK_SHARED/data" 2>/dev/null)" ]; then
    # Copy runtime state but not old logs/analytics bulk (they're rebuilt).
    (cd "$LEGACY_DIR/data" && find . -maxdepth 1 -type f -name '*.json' -exec cp -p {} "$BONK_SHARED/data/" \;)
    echo "migrated bot state (settings, traders, positions, trades) from the old checkout"
  fi
  date -u +%FT%TZ > "$BONK_SHARED/data/.migrated"
fi

# Port: keep whatever nginx already proxies to.
PORT="$(app_port)"
printf 'PORT=%s\nHOSTNAME=127.0.0.1\n' "$PORT" > "$BONK_SHARED/runtime.env"
echo "app port: $PORT"

# ── 3. Unpack the release ────────────────────────────────────────────────────
rm -rf "$REL_DIR"
mkdir -p "$REL_DIR"
tar -xzf "$RELEASE_TARBALL" -C "$REL_DIR"
rm -f "$RELEASE_TARBALL"
ln -sfn "$BONK_SHARED/.env.local" "$REL_DIR/.env.local"
rm -rf "$REL_DIR/data"
ln -sfn "$BONK_SHARED/data" "$REL_DIR/data"
chmod +x "$REL_DIR/scripts/vps/"*.sh 2>/dev/null || true
echo "release size: $(du -sh "$REL_DIR" | cut -f1)"

# ── 4. System config: units, journald cap, swap ──────────────────────────────
install -m 644 "$REL_DIR/deploy/bonk.service" /etc/systemd/system/bonk.service
install -m 644 "$REL_DIR/deploy/bonk-watchdog.service" /etc/systemd/system/bonk-watchdog.service
install -m 644 "$REL_DIR/deploy/bonk-watchdog.timer" /etc/systemd/system/bonk-watchdog.timer
mkdir -p /etc/systemd/journald.conf.d
if ! cmp -s "$REL_DIR/deploy/journald-bonk.conf" /etc/systemd/journald.conf.d/bonk.conf 2>/dev/null; then
  install -m 644 "$REL_DIR/deploy/journald-bonk.conf" /etc/systemd/journald.conf.d/bonk.conf
  systemctl restart systemd-journald || true
  journalctl --vacuum-size=150M >/dev/null 2>&1 || true
fi
if [ -z "$(swapon --show --noheadings 2>/dev/null)" ] && [ ! -f /swapfile ]; then
  free_kb="$(df -Pk / | awk 'NR==2{print $4}')"
  if [ "${free_kb:-0}" -gt 3145728 ]; then
    echo "adding a 1G swapfile (no swap present)"
    fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024 status=none
    chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    sysctl -q vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-bonk-swap.conf
  else
    echo "skipping swapfile: less than 3 GB free"
  fi
fi
systemctl daemon-reload

# ── 5. Stop the old way of running the app (first run only) ──────────────────
if [ -n "$LEGACY_DIR" ]; then
  if have pm2; then
    for name in $(pm2 jlist 2>/dev/null | node -e '
      let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{for(const p of JSON.parse(s)){const cwd=(p.pm2_env&&p.pm2_env.pm_cwd)||"";if(cwd.startsWith(process.argv[1]))console.log(p.name)}}catch{}})' "$LEGACY_DIR"); do
      echo "stopping pm2 app '$name' (old checkout)"
      pm2 delete "$name" >/dev/null 2>&1 || true
      pm2 save >/dev/null 2>&1 || true
    done
  fi
  for unit in $(systemctl list-units --type=service --state=running --no-legend 2>/dev/null | awk '{print $1}' | grep -v '^bonk'); do
    wd="$(systemctl show -p WorkingDirectory --value "$unit" 2>/dev/null || true)"
    if [ -n "$wd" ] && [ "${wd#"$LEGACY_DIR"}" != "$wd" ]; then
      echo "stopping and disabling old service $unit"
      systemctl disable --now "$unit" >/dev/null 2>&1 || true
    fi
  done
  for pid in $(pgrep -f 'next|node' 2>/dev/null || true); do
    cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    if [ -n "$cwd" ] && [ "${cwd#"$LEGACY_DIR"}" != "$cwd" ]; then
      echo "stopping old process $pid"
      kill "$pid" 2>/dev/null || true
    fi
  done
  sleep 2
fi

# ── 6. Switch and health-check, with rollback ────────────────────────────────
PREVIOUS="$(readlink -f "$BONK_CURRENT" 2>/dev/null || true)"
ln -sfn "$REL_DIR" "$BONK_ROOT/current.new" && mv -Tf "$BONK_ROOT/current.new" "$BONK_CURRENT"
systemctl enable bonk >/dev/null 2>&1
systemctl restart bonk
systemctl enable --now bonk-watchdog.timer >/dev/null 2>&1

healthy() {
  local deadline=$((SECONDS + 150)) body code
  while [ $SECONDS -lt $deadline ]; do
    sleep 5
    code="$(curl -s -o /tmp/bonk-health.json -m 10 -w '%{http_code}' "http://127.0.0.1:$PORT/api/health" || echo 000)"
    if [ "$code" = "200" ]; then
      body="$(cat /tmp/bonk-health.json)"
      # A wanted-running bot must have completed a poll since this start.
      if printf '%s' "$body" | node -e '
        let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);
          const wants=j.desiredRunState==="running"||j.desiredRunState==="draining";
          process.exit(!wants||(j.heartbeatAgeSec!=null&&j.heartbeatAgeSec<j.uptimeSec)?0:1)})'; then
        return 0
      fi
    fi
  done
  return 1
}

if healthy; then
  echo "healthy:"
  sed -e 's/,"/,\n  "/g' /tmp/bonk-health.json | head -n 20; echo
else
  echo "::error::new release did not become healthy"
  journalctl -u bonk --no-pager -n 40 | cut -c1-220 || true
  if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ "$PREVIOUS" != "$REL_DIR" ]; then
    echo "rolling back to $(basename "$PREVIOUS")"
    ln -sfn "$PREVIOUS" "$BONK_ROOT/current.new" && mv -Tf "$BONK_ROOT/current.new" "$BONK_CURRENT"
    systemctl restart bonk
  fi
  exit 1
fi

# ── 7. Housekeeping ──────────────────────────────────────────────────────────
cd "$BONK_ROOT/releases"
ls -1t | tail -n +$((KEEP_RELEASES + 1)) | while read -r old; do
  [ "$BONK_ROOT/releases/$old" = "$REL_DIR" ] && continue
  rm -rf "$BONK_ROOT/releases/$old" && echo "removed old release $old"
done
# The old checkout's build output is no longer used; keep its source and data.
if [ -n "$LEGACY_DIR" ]; then
  for d in "$LEGACY_DIR/node_modules" "$LEGACY_DIR/.next"; do
    if [ -d "$d" ]; then
      echo "freeing $(du -sh "$d" | cut -f1) from $d"
      rm -rf "$d"
    fi
  done
fi
df -h / | tail -n1 | awk '{print "disk: " $5 " used (" $4 " free)"}'
free -m | awk '/Mem:/{printf "ram: %d/%d MB used\n", $3, $2}'
echo "deploy complete"
