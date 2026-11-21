# Research scripts

Offline tests used to tune trader selection. They read only public Polymarket
APIs (Data API trades, Gamma markets, CLOB price history) and write JSON into
`research/data/` (git-ignored). Python 3, standard library only.

The core question each script answers: **does a rule chosen on older data
still work on newer data?** Anything tuned without that check is fitting noise.

| Step | Command | Time |
|---|---|---|
| 1. Collect ~700 active wallets' trades + how their markets resolved | `python3 research/collect_universe.py research/data/study.json` | ~15 min |
| 2. Old vs new selection rules, scored on the last N days | `python3 research/selection_test.py research/data/study.json 7` | seconds |
| 3. Candidate rules across three later windows | `python3 research/selection_walkforward.py research/data/study.json` | ~1 min |
| 4. Does the trader's own buy size predict outcomes? | `python3 research/buy_size_test.py research/data/study.json` | seconds |
| 5. Price 5 min / 1 h / 6 h after each buy (for skill) | `python3 research/markout_collect.py research/data/study.json research/data/markout.json` | ~15 min |
| 6. Does the 6-hour move persist (the bot's skill score)? | `python3 research/markout_test.py research/data/markout.json research/data/study.json` | seconds |

Returns are "per dollar copied", held to resolution, after a 5% taker-fee
model (`r * p * (1-p)` per share) and 0.5c entry slippage (1.5c for $500+
buys). Confidence intervals bootstrap over wallets, because one wallet's
trades are correlated.

Findings so far are recorded in `docs/tuning-log.md`.
