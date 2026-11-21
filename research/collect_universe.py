import json, urllib.request, time, sys, random
from concurrent.futures import ThreadPoolExecutor
H = {"user-agent": "Mozilla/5.0"}
def get(u, tries=4):
    for i in range(tries):
        try: return json.load(urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=30))
        except Exception:
            if i == tries - 1: return None
            time.sleep(1.5 * (i + 1))
# 1. Universe: wallets active in the global trade feed right now (not picked by profit).
wallets, cursor = {}, None
for _ in range(16):
    d = get("https://data-api.polymarket.com/v2/trades?limit=500&taker_only=false" + (f"&cursor={cursor}" if cursor else ""))
    if not d: break
    for r in d.get("data") or []:
        w = (r.get("proxy_wallet") or "").lower()
        if w: wallets[w] = wallets.get(w, 0) + 1
    p = d.get("pagination") or {}
    if not p.get("has_more"): break
    cursor = p.get("next_cursor")
# plus current leaderboard wallets so the bot's own selection pool is represented
for period in ("week", "month"):
    d = get(f"https://data-api.polymarket.com/v2/leaderboard?time_period={period}&sort_by=PNL&limit=100") or {}
    for r in d.get("data") or []:
        w = (r.get("user_id") or "").lower()
        if w: wallets.setdefault(w, 0)
universe = list(wallets)
random.seed(11); random.shuffle(universe); universe = universe[:700]
print("universe", len(universe), flush=True)
def trades_for(w):
    out, cursor = [], None
    for _ in range(3):
        d = get(f"https://data-api.polymarket.com/v2/trades?user={w}&limit=500&taker_only=false" + (f"&cursor={cursor}" if cursor else ""))
        if not d: break
        out += d.get("data") or []
        p = d.get("pagination") or {}
        if not p.get("has_more"): break
        cursor = p.get("next_cursor")
    return w, [[r["side"], r["token_id"], r["price"], r["timestamp"], r.get("size", 0)] for r in out]
with ThreadPoolExecutor(8) as ex: trades = dict(ex.map(trades_for, universe))
print("fetched", sum(len(v) for v in trades.values()), "trades", flush=True)
tokens = sorted({t[1] for v in trades.values() for t in v if t[0] == "BUY" and 0.05 <= t[2] <= 0.97})
print("tokens", len(tokens), flush=True)
res = {}
def lookup(batch):
    q = "&".join("clob_token_ids=" + t for t in batch); got = []
    for extra in ("closed=true&", ""):
        got += get(f"https://gamma-api.polymarket.com/markets?{extra}limit=200&{q}") or []
    return got
with ThreadPoolExecutor(8) as ex:
    for ms in ex.map(lookup, [tokens[i:i+40] for i in range(0, len(tokens), 40)]):
        for m in ms:
            if not m.get("closed"): continue
            try: ids = json.loads(m.get("clobTokenIds") or "[]"); px = json.loads(m.get("outcomePrices") or "[]")
            except Exception: continue
            for t, p in zip(ids, px):
                p = float(p)
                if p in (0.0, 1.0): res[t] = [p, m.get("endDate"), m.get("closedTime"), m.get("category") or ""]
print("resolved", len(res), flush=True)
json.dump({"trades": trades, "res": res, "leader": [w for w, c in wallets.items() if c == 0]}, open(sys.argv[1], "w"))
