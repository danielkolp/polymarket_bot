import json, urllib.request, time, random, sys
from concurrent.futures import ThreadPoolExecutor
H = {"user-agent": "Mozilla/5.0"}
def get(u, tries=3):
    for i in range(tries):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=25))
        except Exception:
            if i == tries - 1: return None
            time.sleep(1 + i)
d = json.load(open(sys.argv[1]))
now = max(t[3] for v in d["trades"].values() for t in v); DAY = 86400
TB = now - 7 * DAY; TA = TB - 23 * DAY
random.seed(21)
sample = []  # (wallet, period, token, price, t, usd)
for w, trs in d["trades"].items():
    seen = set(); A, B = [], []
    for side, tok, price, t, size in trs:
        if side != "BUY" or not (0.2 <= price < 0.85) or price * size < 2 or (tok, t // 600) in seen: continue
        seen.add((tok, t // 600))
        (A if TA <= t < TB else B if t >= TB and t < now - 6 * 3600 else []).append((tok, price, t, price * size))
    if len(A) >= 15 and len(B) >= 15:
        for per, lst in (("A", A), ("B", B)):
            for x in random.sample(lst, min(30, len(lst))): sample.append((w, per) + x)
print("wallets", len({s[0] for s in sample}), "buys", len(sample), flush=True)
bytok = {}
for s in sample: bytok.setdefault(s[2], []).append(s[4])
def hist(tok):
    ts = bytok[tok]; a, b = min(ts) - 600, max(ts) + 6 * 3600 + 600
    r = get(f"https://clob.polymarket.com/prices-history?market={tok}&startTs={a}&endTs={b}&fidelity=1")
    return tok, (r or {}).get("history") or []
H_ = {}
with ThreadPoolExecutor(10) as ex:
    for i, (tok, h) in enumerate(ex.map(hist, list(bytok))):
        H_[tok] = [(p["t"], p["p"]) for p in h]
        if i % 2000 == 0: print("tokens", i, "/", len(bytok), flush=True)
def price_at(h, t):
    best = None
    for tt, p in h:
        if tt <= t: best = p
        else: break
    return best
out = []
for w, per, tok, price, t, usd in sample:
    h = H_.get(tok) or []
    if not h: continue
    row = [w, per, tok, price, t, usd]
    for lag in (300, 3600, 6 * 3600):
        p = price_at(h, t + lag); row.append(None if p is None else p)
    out.append(row)
json.dump(out, open(sys.argv[2], "w"))
print("done", len(out), flush=True)
