import json, sys, time, random, statistics as st, math
from datetime import datetime
d = json.load(open(sys.argv[1])); res = d["res"]; leaders = set(d["leader"])
B_DAYS = float(sys.argv[2]) if len(sys.argv) > 2 else 7
A_DAYS = 30
now = max(t[3] for v in d["trades"].values() for t in v)  # latest trade seen
TB = now - B_DAYS * 86400; TA = TB - A_DAYS * 86400
R, SLIP = 0.05, 0.005
def ts(s):
    try: return datetime.fromisoformat(s.replace("Z","+00:00").replace(" ","T").split("+")[0]+"+00:00").timestamp()
    except Exception: return None
def ret(price, payout):
    e = price + SLIP; return payout / (e + R * e * (1 - e)) - 1
W = {}
for w, rows in d["trades"].items():
    if not rows: continue
    first = min(r[3] for r in rows)
    span_days = max(1.0, (now - first) / 86400)
    A = {"pnl": 0.0, "vol": 0.0, "wpnl": 0.0, "wvol": 0.0, "n": 0, "copyable": 0, "rets": [], "wins": 0, "res_n": 0}
    Bc, seen = [], set()
    for side, tok, price, t, size in sorted(rows, key=lambda r: r[3]):
        if side != "BUY": continue
        usd = price * size
        if TA <= t < TB:
            A["n"] += 1; A["vol"] += usd; A["copyable"] += 0.2 <= price < 0.85
            if t >= TB - 7 * 86400: A["wvol"] += usd
            if tok in res:
                r = ret(price, res[tok][0]); A["pnl"] += usd * r; A["res_n"] += 1; A["wins"] += res[tok][0] == 1
                if t >= TB - 7 * 86400: A["wpnl"] += usd * r
                if 0.2 <= price < 0.85 and usd >= 2: A["rets"].append(r)
        elif t >= TB and tok in res and 0.2 <= price < 0.85 and usd >= 2 and (w, tok) not in seen:
            payout, end, closed, cat = res[tok]; ct = ts(closed or "") or ts(end or "")
            if ct and ct - t > 14 * 86400: continue
            seen.add((w, tok)); Bc.append(ret(price, payout))
    if A["n"] == 0: continue
    A["tpd"] = len(rows) / span_days; A["avg"] = A["vol"] / A["n"]; A["cshare"] = A["copyable"] / A["n"]
    A["roi"] = A["pnl"] / A["vol"] if A["vol"] else 0; A["wroi"] = A["wpnl"] / A["wvol"] if A["wvol"] else A["roi"]
    W[w] = (A, Bc)
evalset = {w: v for w, v in W.items() if len(v[1]) >= 3}
print(f"wallets with A-period buys: {len(W)}; with >=3 resolved copyable buys in last {B_DAYS:.0f}d: {len(evalset)}")
def discovery_ok(A):
    return A["pnl"] > 0 and A["wpnl"] >= 0 and A["roi"] >= 0.02 and A["tpd"] <= 150 and 20 <= A["avg"] <= 5000 and A["cshare"] >= 0.3 and A["n"] >= 10
def pct(vals):
    o = sorted(range(len(vals)), key=lambda i: vals[i]); r = [0.0]*len(vals)
    for k, i in enumerate(o): r[i] = k / max(1, len(vals) - 1)
    return r
def discovery_rank(cands):
    ws = list(cands); A = [cands[w][0] for w in ws]
    mr, wr, mp, cp = pct([a["roi"] for a in A]), pct([a["wroi"] for a in A]), pct([math.log10(1 + max(0, a["pnl"])) for a in A]), pct([a["cshare"] for a in A])
    score = {w: 0.3*mr[i] + 0.2*wr[i] + 0.15*mp[i] + 0.1*cp[i] for i, w in enumerate(ws)}
    return sorted(ws, key=lambda w: -score[w])
def report(name, ws):
    if not ws: print(f"  {name:48s} (none)"); return
    pooled = [r for w in ws for r in evalset[w][1]]; per_w = [st.mean(evalset[w][1]) for w in ws]
    random.seed(9); boots = sorted(st.mean(r for w in [random.choice(ws) for _ in ws] for r in evalset[w][1]) for _ in range(1000))
    print(f"  {name:48s} {len(ws):4d} wallets {len(pooled):5d} buys | later copy return {st.mean(pooled)*100:+6.1f}%/$ [95% CI {boots[25]*100:+.1f}, {boots[975]*100:+.1f}] | median wallet {st.median(per_w)*100:+.1f}%")
E = evalset
report("everyone (baseline)", list(E))
report("current leaderboard wallets (look-ahead!)", [w for w in E if w in leaders])
ok = {w: v for w, v in E.items() if discovery_ok(v[0])}
report("pass the bot's filters (earlier data only)", list(ok))
report("bot's ranking: top 16 of those", discovery_rank(ok)[:16])
report("bot's ranking: top 40 of those", discovery_rank(ok)[:40])
report("top 16 by earlier $ profit (any filters)", sorted(E, key=lambda w: -E[w][0]["pnl"])[:16])
report("top 40 by earlier $ profit", sorted(E, key=lambda w: -E[w][0]["pnl"])[:40])
q = [w for w in E if len(E[w][0]["rets"]) >= 10]
report("top third by earlier copy return (>=10 buys)", sorted(q, key=lambda w: -st.mean(E[w][0]["rets"]))[:len(q)//3])
report("bottom third by earlier copy return", sorted(q, key=lambda w: st.mean(E[w][0]["rets"]))[:len(q)//3])
report("earlier win rate top third (>=10 resolved)", sorted([w for w in E if E[w][0]["res_n"] >= 10], key=lambda w: -E[w][0]["wins"]/E[w][0]["res_n"])[:max(1,len([w for w in E if E[w][0]['res_n']>=10])//3)])
report("slow traders (<=20 trades/day)", [w for w in E if E[w][0]["tpd"] <= 20])
report("fast traders (>20 trades/day)", [w for w in E if E[w][0]["tpd"] > 20])
report("small avg buy (<$50)", [w for w in E if E[w][0]["avg"] < 50])
report("large avg buy ($200-5000)", [w for w in E if 200 <= E[w][0]["avg"] <= 5000])
