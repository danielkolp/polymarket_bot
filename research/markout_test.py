import json, sys, random, statistics as st
rows = json.load(open(sys.argv[1])); d = json.load(open(sys.argv[2])); res = d["res"]
SLIP, R = 0.005, 0.05
per = {}
for r in rows:
    w, p, tok, price, t, usd, m5, m1, m6 = r
    e = price + SLIP
    cr = res[tok][0] / (e + R * e * (1 - e)) - 1 if tok in res else None
    per.setdefault(w, {"A": [], "B": []})[p].append({"m6": None if m6 is None else m6 - e, "cr": cr, "usd": usd})
random.seed(13)
def agg(xs, k): v = [x[k] for x in xs if x[k] is not None]; return v
W = []
for w, v in per.items():
    a6 = agg(v["A"], "m6"); b6 = agg(v["B"], "m6"); bcr = agg(v["B"], "cr")
    if len(a6) >= 8 and len(b6) >= 5:
        W.append({"w": w, "a6": st.mean(a6), "na": len(a6), "b6": b6, "bcr": bcr})
print("wallets", len(W))
def group_stats(g, label):
    b6 = [x for w in g for x in w["b6"]]; bcr = [x for w in g for x in w["bcr"]]
    def boot(key):
        vals = []
        for _ in range(1000):
            s = [random.choice(g) for _ in g]; pool = [x for w in s for x in w[key]]
            if pool: vals.append(st.mean(pool))
        vals.sort(); return vals[25], vals[975]
    l6, h6 = boot("b6"); lc, hc = boot("bcr")
    print(f"  {label:34s} {len(g):3d} wallets | later 6h move {st.mean(b6)*100:+5.2f}c [{l6*100:+.2f},{h6*100:+.2f}] | later copy return {st.mean(bcr)*100 if bcr else float('nan'):+5.1f}%/$ [{lc*100:+.1f},{hc*100:+.1f}] ({len(bcr)} resolved buys)")
W.sort(key=lambda x: -x["a6"])
n = len(W)
group_stats(W, "everyone")
group_stats(W[: n // 5], "top 20% by earlier 6h move")
group_stats(W[: n // 3], "top third")
group_stats([w for w in W if w["a6"] > 0.02], "earlier 6h move > +2c")
group_stats([w for w in W if w["a6"] > 0.02 and w["na"] >= 20], "earlier > +2c with >= 20 buys")
group_stats(W[-(n // 3):], "bottom third")
