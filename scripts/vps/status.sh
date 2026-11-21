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
hr "last hour: decisions by reason (counts only)"
node -e '
  const fs=require("fs"); const dir=process.argv[1]; const hour=Date.now()-3600e3;
  const read=(f)=>{try{return JSON.parse(fs.readFileSync(dir+"/"+f,"utf8"))}catch{return []}};
  const skips=read("skips.json").filter(r=>r.processedAt>=hour);
  const trades=read("trades.json").filter(r=>r.processedAt>=hour);
  const norm=(s)=>String(s).replace(/-?\d[\d,]*\.?\d*/g,"#").replace(/\s+/g," ").slice(0,140);
  const count=(rows)=>{const m=new Map();for(const r of rows){const k=r.status+" "+r.side+": "+norm(r.reason);m.set(k,(m.get(k)||0)+1)}return [...m].sort((a,b)=>b[1]-a[1])};
  console.log("skipped:",skips.length," copied/failed:",trades.length);
  for(const [k,n] of count([...trades,...skips]).slice(0,15)) console.log(String(n).padStart(4),k);
' "$BONK_SHARED/data"
hr "run-state changes (bot log)"
f="$BONK_SHARED/data/errors.log"
[ -f "$f" ] && grep -E '"message":"(Bot (started|paused|stopped|resumed)|Server restarted|PANIC|Panic|Daily loss|Account is|Drawdown|Discovery (v2 )?refreshed|Real-time trade feed)' "$f" | tail -n 12 | node -e '
  let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{for(const l of s.split("\n")){if(!l)continue;try{const j=JSON.parse(l);console.log(new Date(j.ts).toISOString().slice(5,19),String(j.message).slice(0,160))}catch{}}})'
