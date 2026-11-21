#!/usr/bin/env bash
# Shared helpers, concatenated in front of every scripts/vps/<task>.sh and run
# on the VPS as `bash -s`. Never print env values, keys or balances here.
set -u
export LC_ALL=C
export DEBIAN_FRONTEND=noninteractive

# New layout lives in /srv/bonk; the original install (pm2) is /opt/bonk.
BONK_ROOT=/srv/bonk
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

# The original (pre-systemd) checkout: the cwd of the pm2 "bonk" app, else of
# whatever node process listens on the app port, else a checkout that has an
# .env.local. Never a /srv/bonk release or a stray staging copy.
legacy_app_dir() {
  local d=""
  if have pm2; then
    d="$(pm2 jlist 2>/dev/null | node -e '
      let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{
        const apps=JSON.parse(s);const a=apps.find(p=>p.name==="bonk")||apps[0];
        if(a&&a.pm2_env&&a.pm2_env.pm_cwd)console.log(a.pm2_env.pm_cwd)}catch{}})' 2>/dev/null)"
  fi
  if [ -z "$d" ]; then
    local pid
    pid="$(ss -ltnpH "sport = :$(app_port)" 2>/dev/null | grep -o 'pid=[0-9]*' | head -n1 | cut -d= -f2)"
    [ -n "$pid" ] && d="$(readlink "/proc/$pid/cwd" 2>/dev/null)"
  fi
  if [ -z "$d" ]; then
    local c
    for c in $(legacy_app_dirs); do
      [ -f "$c/.env.local" ] && { d="$c"; break; }
    done
  fi
  case "$d" in ""|"$BONK_ROOT"|"$BONK_ROOT"/*) d="" ;; esac
  [ -n "$d" ] && [ -f "$d/package.json" ] && echo "$d"
}

# Env file the running app uses.
app_env_file() {
  if [ -f "$BONK_SHARED/.env.local" ]; then echo "$BONK_SHARED/.env.local"; return; fi
  local d
  d="$(legacy_app_dir)"
  [ -n "$d" ] && [ -f "$d/.env.local" ] && echo "$d/.env.local"
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
      if (j && j.data && j.data.state) j = j.data; // API envelope {ok, data}
      const st = j.state || {}, set = j.settings || {}, br = j.buyReadiness || {};
      const out = {
        runState: st.runState, desiredRunState: st.desiredRunState, mode: set.mode,
        riskPreset: set.riskPreset, panic: st.panic, dailyLossLockout: st.dailyLossLockout,
        lastPollAt: st.lastPollAt ? new Date(st.lastPollAt).toISOString() : null,
        lastHeartbeatAt: st.lastHeartbeatAt ? new Date(st.lastHeartbeatAt).toISOString() : null,
        followed: Array.isArray(j.traders) ? j.traders.filter(t => t.enabled && !t.exitOnly).length : undefined,
        recentDecisions: (j.recentTrades || []).slice(0, 8).map(t => `${t.status} ${t.side}: ${String(t.reason).slice(0, 140)}`),
        openPositions: Array.isArray(j.positions) ? j.positions.length : undefined,
        buyBlockers: (br.blockers || []).map((b) => b.detail || b.code).slice(0, 8),
        buyWarnings: (br.warnings || []).map((b) => b.detail || b.code).slice(0, 5),
        liveBalanceStatus: (j.metrics || {}).liveBalanceStatus,
        liveBalanceError: (j.metrics || {}).liveBalanceError || null,
        lastError: st.lastError ? String(st.lastError).slice(0, 300) : null,
        realTradingEnabled: j.realTradingEnabled ?? j.enableRealTrading,
      };
      const m = j.metrics || {};
      if (set.mode === "simulation") {
        // Paper results as percentages/counts only (no dollar balances in public logs).
        out.paperResults = {
          copiedTrades: m.totalTrades, winners: m.winners, losers: m.losers,
          winRatePct: m.winRate != null ? Math.round(m.winRate * 1000) / 10 : null,
          returnPctOfBankroll: m.roi != null ? Math.round(m.roi * 1000) / 10 : null,
          equityPctOfBankroll: set.startingBalance > 0 && m.equityUsd != null ? Math.round((m.equityUsd / set.startingBalance) * 1000) / 10 : null,
        };
      }
      out.followedSkill = (j.traders || []).filter(t => t.enabled && !t.exitOnly)
        .map(t => `${String(t.name || "").slice(0, 18)}: ${t.skill6hCents != null ? (t.skill6hCents >= 0 ? "+" : "") + t.skill6hCents + "c" : "n/a"} (n=${t.skillSamples ?? 0})`);
      console.log(JSON.stringify(out, null, 2));
    });'
}
