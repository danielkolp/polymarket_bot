#!/usr/bin/env bash
# Shared helpers, concatenated in front of every scripts/vps/<task>.sh and run
# on the VPS as `bash -s`. Never print env values, keys or balances here.
set -u
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

BONK_ROOT=/opt/bonk
BONK_SHARED=$BONK_ROOT/shared
BONK_CURRENT=$BONK_ROOT/current
BONK_PORT_DEFAULT=3000

hr() { printf '\n===== %s =====\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# Directories that contain this app's checkout (package.json name "bonk").
legacy_app_dirs() {
  find /root /home /opt /srv /var/www /usr/local -maxdepth 4 \
    \( -name node_modules -o -name .git -o -name .next -o -path "$BONK_ROOT/releases" \) -prune -o \
    -name package.json -size -20k -print 2>/dev/null \
    | xargs -r grep -l '"name": "bonk"' 2>/dev/null \
    | xargs -r -n1 dirname | sort -u
}

# Env var names in a dotenv file, with "set"/"empty". Values are only shown
# for a short allow-list of non-secret settings.
env_summary() {
  local f="$1"
  [ -f "$f" ] || { echo "(no $f)"; return; }
  grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=' "$f" | while IFS= read -r line; do
    name="${line%%=*}"; name="$(echo "$name" | tr -d '[:space:]')"
    val="${line#*=}"; val="$(echo "$val" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/")"
    case "$name" in
      ENABLE_REAL_TRADING|ENABLE_AUTO_REDEEM|POLYMARKET_SIGNATURE_TYPE|POLYMARKET_CHAIN_ID|LIVE_MAX_ORDER_USD|LIVE_REQUIRE_MANUAL_RESUME_AFTER_PANIC|LIVE_MAX_UNRECONCILED_ORDERS|LIVE_PENDING_STALE_SECONDS|LIVE_POSITIONS_STALE_SECONDS|NODE_ENV|PORT|HOSTNAME)
        echo "  $name = $val" ;;
      *)
        if [ -n "$val" ]; then echo "  $name = (set, ${#val} chars)"; else echo "  $name = (empty)"; fi ;;
    esac
  done
}

# Read one value from a dotenv file (for use on the VPS only, never printed).
env_get() {
  local f="$1" k="$2"
  [ -f "$f" ] || return 0
  grep -E "^[[:space:]]*${k}=" "$f" | tail -n1 | sed -e "s/^[[:space:]]*${k}=//" -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" | tr -d '\r'
}

# Port the app listens on (nginx proxy_pass first, then a listening node).
app_port() {
  local p
  p="$(grep -rhoE 'proxy_pass[[:space:]]+http://(127\.0\.0\.1|localhost):[0-9]+' /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null | grep -oE '[0-9]+$' | head -n1)"
  [ -n "$p" ] && { echo "$p"; return; }
  echo "$BONK_PORT_DEFAULT"
}

# Env file the running app uses.
app_env_file() {
  if [ -f "$BONK_SHARED/.env.local" ]; then echo "$BONK_SHARED/.env.local"; return; fi
  local d
  for d in $(legacy_app_dirs); do
    [ -f "$d/.env.local" ] && { echo "$d/.env.local"; return; }
  done
}

# curl the local app (bypasses nginx Basic auth). Adds the dashboard token
# header for mutations when one is configured.
app_curl() {
  local method="$1" path="$2" body="${3:-}"
  local port envf token
  port="$(app_port)"; envf="$(app_env_file)"
  token="$( [ -n "$envf" ] && env_get "$envf" DASHBOARD_AUTH_TOKEN )"
  local args=(-sS -m 30 -X "$method" -H "Content-Type: application/json" -H "Origin: http://127.0.0.1:$port")
  [ -n "$token" ] && args+=(-H "x-dashboard-token: $token")
  [ -n "$body" ] && args+=(--data "$body")
  curl "${args[@]}" "http://127.0.0.1:$port$path"
}

# Compact, non-sensitive bot status summary (no balances, no addresses).
status_summary() {
  local port; port="$(app_port)"
  local json
  json="$(curl -sS -m 30 "http://127.0.0.1:$port/api/bot/status" 2>&1)" || { echo "status request failed: $json" | head -c 400; echo; return; }
  if ! have node; then echo "(node missing; raw status suppressed)"; return; fi
  printf '%s' "$json" | node -e '
    let s = ""; process.stdin.on("data", c => s += c).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { console.log("non-JSON status: " + s.slice(0, 200)); return; }
      const st = j.state || {}, set = j.settings || {}, br = j.buyReadiness || {};
      const out = {
        runState: st.runState, desiredRunState: st.desiredRunState, mode: set.mode,
        riskPreset: set.riskPreset, panic: st.panic, dailyLossLockout: st.dailyLossLockout,
        lastPollAt: st.lastPollAt, nextPollAt: st.nextPollAt, lastHeartbeatAt: st.lastHeartbeatAt,
        followed: Array.isArray(j.traders) ? j.traders.filter(t => t.enabled).length : undefined,
        openPositions: Array.isArray(j.positions) ? j.positions.length : undefined,
        buyBlockers: (br.blockers || br.reasons || []).slice(0, 8),
        lastError: st.lastError ? String(st.lastError).slice(0, 300) : null,
        realTradingEnabled: j.realTradingEnabled ?? j.enableRealTrading,
      };
      console.log(JSON.stringify(out, null, 2));
    });'
}
