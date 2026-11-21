import json, sys, random, statistics as st
from datetime import datetime
d = json.load(open(sys.argv[1])); res = d["res"]
SLIP_SMALL, SLIP_BIG, R = 0.005, 0.015, 0.05
def ts(s):
    try: return datetime.fromisoformat(s.replace("Z","+00:00").replace(" ","T").split("+")[0]+"+00:00").timestamp()
    except Exception: return None
now = max(t[3] for v in d["trades"].values() for t in v)
DAY = 86400
# per wallet: list of resolved, copyable buys (first per token) and all-buy stats
W = {}
for w, trs in d["trades"].items():
    if not trs: continue
    first = min(r[3] for r in trs)
    buys, seen = [], set()
    for side, tok, price, t, size in sorted(trs, key=lambda r: r[3]):
        if side != "BUY": continue
        usd = price * size
        rec = {"t": t, "usd": usd, "price": price, "res": None}
        if tok in res and (w, tok) not in seen:
            payout, end, closed, cat = res[tok]; ct = ts(closed or "") or ts(end or "")
            if not (ct and ct - t > 14 * DAY):
                seen.add((w, tok))
                e = price + (SLIP_BIG if usd >= 500 else SLIP_SMALL)
                rec["res"] = payout / (e + R * e * (1 - e)) - 1
        buys.append(rec)
    W[w] = {"first": first, "n_all": len(trs), "buys": buys}
def a_stats(w, TA, TB):
    v = W[w]; A = [b for b in v["buys"] if TA <= b["t"] < TB]
    if v["first"] > TA + 5 * DAY or not A: return None   # need history covering the A window
    span = max(1.0, (TB - max(v["first"], TA)) / DAY)
    big = [b for b in A if b["usd"] >= 500]
    rA = [b["res"] for b in A if b["res"] is not None and 0.2 <= b["price"] < 0.85 and b["usd"] >= 2]
    rbig = [b["res"] for b in big if b["res"] is not None and 0.2 <= b["price"] < 0.85]
    pnl = sum(b["usd"] * b["res"] for b in A if b["res"] is not None)
    return {"n": len(A), "avg": st.mean(b["usd"] for b in A), "big_n": len(big), "bpd": len(A) / span,
            "copy": st.mean(rA) if rA else None, "copy_n": len(rA), "big_copy": st.mean(rbig) if rbig else None, "big_copy_n": len(rbig), "pnl": pnl}
RULES = {
  "R0 every buy (baseline)":                    (lambda a: True,                                   lambda b: True),
  "R1 buys >= $500":                            (lambda a: True,                                   lambda b: b["usd"] >= 500),
  "R2 buys >= $100":                            (lambda a: True,                                   lambda b: b["usd"] >= 100),
  "R3 traders averaging >= $200/buy":           (lambda a: a["avg"] >= 200,                        lambda b: True),
  "R4 R3, their buys >= $500":                  (lambda a: a["avg"] >= 200,                        lambda b: b["usd"] >= 500),
  "R5 earlier profit > 0, buys >= $500":        (lambda a: a["pnl"] > 0,                           lambda b: b["usd"] >= 500),
  "R6 earlier big-buy return > 0 (>=5), >=$500": (lambda a: a["big_copy_n"] >= 5 and a["big_copy"] > 0, lambda b: b["usd"] >= 500),
  "R7 slow (<=10 buys/day), buys >= $500":      (lambda a: a["bpd"] <= 10,                         lambda b: b["usd"] >= 500),
  "R8 earlier copy return top half (>=10)":     (None,                                              lambda b: True),
}
windows = [(0, 5), (5, 10), (10, 15)]
random.seed(4)
print(f"{'rule':46s} " + "  ".join(f"days {a}-{b} ago: ret/$ [CI] (buys/wallets)".ljust(40) for a, b in windows))
for name, (wsel, bsel) in RULES.items():
    cells = []
    for b0, b1 in windows:
        TB0, TB1 = now - b1 * DAY, now - b0 * DAY; TA = TB0 - 30 * DAY
        stats = {w: a_stats(w, TA, TB0) for w in W}
        stats = {w: s for w, s in stats.items() if s}
        if wsel is None:
            q = [w for w, s in stats.items() if s["copy_n"] >= 10]
            med = st.median([stats[w]["copy"] for w in q]) if q else 0
            chosen = {w for w in q if stats[w]["copy"] > med}
        else:
            chosen = {w for w, s in stats.items() if wsel(s)}
        byw = {}
        for w in chosen:
            for b in W[w]["buys"]:
                if TB0 <= b["t"] < TB1 and b["res"] is not None and 0.2 <= b["price"] < 0.85 and b["usd"] >= 2 and bsel(b):
                    byw.setdefault(w, []).append(b["res"])
        allr = [x for v in byw.values() for x in v]
        if len(allr) < 30: cells.append("n/a (too few)".ljust(40)); continue
        ws = list(byw)
        boots = sorted(st.mean([x for w in [random.choice(ws) for _ in ws] for x in byw[w]]) for _ in range(600))
        cells.append(f"{st.mean(allr)*100:+5.1f}% [{boots[15]*100:+.1f},{boots[585]*100:+.1f}] ({len(allr)}/{len(ws)})".ljust(40))
    print(f"{name:46s} " + "  ".join(cells))
