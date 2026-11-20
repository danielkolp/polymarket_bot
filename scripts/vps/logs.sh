# logs: recent bot log lines and service journal (redacted by the workflow).
hr "bot log (newest last)"
f="$BONK_SHARED/data/errors.log"
[ -f "$f" ] && tail -n 80 "$f" | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const l of s.split("\n")){if(!l)continue;try{const j=JSON.parse(l);console.log(new Date(j.ts).toISOString().slice(5,19),j.level.padEnd(7),String(j.message).slice(0,240))}catch{}}})'
hr "service journal"
journalctl -u bonk --no-pager -n 40 2>/dev/null | cut -c1-220
journalctl -u bonk-watchdog --no-pager -n 10 2>/dev/null | cut -c1-200
