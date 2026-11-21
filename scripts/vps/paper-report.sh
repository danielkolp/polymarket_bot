# paper-report: how paper trading is doing, for tuning. Counts and percentages
# only (no dollar balances in public logs). Reads the bot's data files directly.
set -u
D="$BONK_SHARED/data"
[ -f "$D/trades.json" ] || { echo "no trades.json yet"; exit 0; }
have node || { echo "node missing"; exit 0; }
status_summary
hr "paper report"
D="$D" node <<'JS'
const fs = require("fs"), path = require("path");
const read = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(process.env.D, f), "utf8")); } catch { return d; } };
const trades = read("trades.json", []), skips = read("skips.json", []), positions = read("positions.json", []);
const traders = read("traders.json", []);
const now = Date.now(), H = 3600e3, DAY = 24 * H;
const pct = (x) => (x == null || !isFinite(x) ? "n/a" : (x >= 0 ? "+" : "") + (x * 100).toFixed(1) + "%");
// Paper period = simulation records after the last real-money record.
const lastReal = Math.max(0, ...trades.filter((t) => t.mode === "real").map((t) => t.processedAt || 0));
const sim = trades.filter((t) => t.mode === "simulation" && (t.processedAt || 0) > lastReal);
const since = sim.length ? Math.min(...sim.map((t) => t.processedAt)) : now;
console.log(`paper period: ${((now - since) / DAY).toFixed(1)} days; records ${sim.length}`);
const buys = sim.filter((t) => t.side === "BUY" && (t.status === "simulated" || t.status === "copied"));
const sells = sim.filter((t) => t.side === "SELL" && (t.status === "simulated" || t.status === "copied"));
// Per token: cost in, realized out.
const tok = new Map();
const get = (k) => tok.get(k) || (tok.set(k, { cost: 0, realized: 0, sold: false, trader: "", price: 0, slip: [], exit: "", opened: 0 }), tok.get(k));
for (const b of buys) {
  const g = get(b.tokenId); g.cost += (b.copyAmountUsd || 0) + (b.feeUsd || 0); g.trader = g.trader || b.traderName; g.price = g.price || b.price;
  g.opened = g.opened || b.processedAt;
  if (b.leaderPrice != null && b.botExecPrice != null) g.slip.push(b.botExecPrice - b.leaderPrice);
}
for (const s of sells) {
  if (!tok.has(s.tokenId)) continue;
  const g = get(s.tokenId); g.realized += s.realizedPnlUsd || 0;
  const r = String(s.reason || "");
  g.exit = /resolved/i.test(r) ? "resolution" : /take-profit|take profit/i.test(r) ? "take-profit" : /stop-loss|stop loss/i.test(r) ? "stop-loss" : /leader exited|no longer holds/i.test(r) ? "leader-gone" : /SELL/i.test(r) ? "leader-sold" : "other";
}
const open = new Map(positions.filter((p) => (p.mode || "simulation") === "simulation").map((p) => [p.tokenId, p]));
let cost = 0, realized = 0, unreal = 0, closedCost = 0, closedPnl = 0, wins = 0, closedN = 0;
const by = (key) => new Map();
const groups = { trader: new Map(), price: new Map(), exit: new Map() };
const add = (m, k, c, p) => { const g = m.get(k) || { n: 0, c: 0, p: 0 }; g.n++; g.c += c; g.p += p; m.set(k, g); };
const slips = [];
for (const [k, g] of tok) {
  if (g.cost <= 0) continue;
  const p = open.get(k);
  const u = p ? p.shares * ((p.markPrice ?? p.avgPrice) - p.avgPrice) : 0;
  const pnl = g.realized + u;
  cost += g.cost; realized += g.realized; unreal += u; slips.push(...g.slip);
  if (!p) { closedN++; closedCost += g.cost; closedPnl += g.realized; if (g.realized > 0) wins++; }
  add(groups.trader, g.trader || "?", g.cost, pnl);
  const b = g.price < 0.35 ? "20-35c" : g.price < 0.5 ? "35-50c" : g.price < 0.65 ? "50-65c" : "65-85c";
  add(groups.price, b, g.cost, pnl);
  add(groups.exit, p ? "still open" : g.exit || "other", g.cost, pnl);
}
const bankroll = read("settings.json", {}).startingBalance || 50;
console.log(`copies: ${buys.length} buys into ${tok.size} markets (last 24h: ${buys.filter((b) => now - b.processedAt < DAY).length})`);
console.log(`return per $ copied (realized + open marks): ${pct(cost ? (realized + unreal) / cost : null)}  | on the paper bankroll: ${pct((realized + unreal) / bankroll)}`);
console.log(`closed: ${closedN} markets, win rate ${closedN ? Math.round((wins / closedN) * 100) : "n/a"}%, return per $ ${pct(closedCost ? closedPnl / closedCost : null)} | open: ${open.size}, marked ${pct(cost - closedCost ? unreal / (cost - closedCost) : null)}`);
if (slips.length) console.log(`entry vs trader's price: avg ${(slips.reduce((a, b) => a + b, 0) / slips.length * 100).toFixed(2)}c over ${slips.length} fills`);
for (const [name, m] of Object.entries(groups)) {
  console.log(`by ${name}:`);
  for (const [k, g] of [...m.entries()].sort((a, b) => b[1].c - a[1].c)) console.log(`   ${String(k).slice(0, 22).padEnd(22)} ${String(g.n).padStart(3)} markets  ${pct(g.c ? g.p / g.c : null)} per $`);
}
const recentSkips = skips.filter((s) => now - (s.processedAt || 0) < DAY && s.side === "BUY");
const reasons = new Map();
for (const s of recentSkips) {
  const r = String(s.reason || "").replace(/[0-9]+(\.[0-9]+)?/g, "#").slice(0, 90);
  reasons.set(r, (reasons.get(r) || 0) + 1);
}
console.log(`BUY skips last 24h: ${recentSkips.length}`);
for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`   ${String(n).padStart(4)}  ${r}`);
const fol = traders.filter((t) => t.enabled && !t.exitOnly);
console.log(`following ${fol.length}: ` + fol.map((t) => `${String(t.name || "").slice(0, 14)} ${t.skill6hCents != null ? (t.skill6hCents >= 0 ? "+" : "") + t.skill6hCents + "c" : "?"}`).join(", "));
JS
