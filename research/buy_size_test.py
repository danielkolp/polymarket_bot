import json, random, statistics as st
from datetime import datetime
d = json.load(open(__import__("sys").argv[1])); res = d["res"]
R, SLIP = 0.05, 0.005
def ts(s):
    try: return datetime.fromisoformat(s.replace("Z","+00:00").replace(" ","T").split("+")[0]+"+00:00").timestamp()
    except Exception: return None
now = max(t[3] for v in d["trades"].values() for t in v)
buckets = [(2,20),(20,100),(100,500),(500,2000),(2000,10000),(10000,1e12)]
rows = {b: [] for b in buckets}
for w, trs in d["trades"].items():
    seen = set()
    for side, tok, price, t, size in trs:
        if side != "BUY" or tok not in res or not (0.2 <= price < 0.85) or (w, tok) in seen: continue
        payout, end, closed, cat = res[tok]; ct = ts(closed or "") or ts(end or "")
        if ct and ct - t > 14 * 86400: continue
        seen.add((w, tok)); usd = price * size; e = price + SLIP
        r = payout / (e + R * e * (1 - e)) - 1
        for b in buckets:
            if b[0] <= usd < b[1]: rows[b].append((r, w, t)); break
print("Copy return of a single buy, by how big the trader's own buy was (all 700 wallets, resolved, 20-85c):")
random.seed(2)
for b in buckets:
    r = rows[b]
    if len(r) < 20: continue
    # cluster bootstrap by wallet (a wallet's buys are correlated)
    byw = {}
    for x in r: byw.setdefault(x[1], []).append(x[0])
    ws = list(byw)
    boots = sorted(st.mean([v for w in [random.choice(ws) for _ in ws] for v in byw[w]]) for _ in range(800))
    print(f"  ${b[0]:>6,.0f}-{'' if b[1]>1e11 else f'${b[1]:,.0f}':<8} {len(r):6d} buys {len(ws):4d} wallets  {st.mean(x[0] for x in r)*100:+6.1f}%/$  [95% CI {boots[20]*100:+.1f}, {boots[780]*100:+.1f}]")
