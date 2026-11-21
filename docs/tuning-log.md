# Tuning log (paper mode)

The bot trades on paper (no real money) while it is tuned. It goes back to
real money **only when the owner says so**, after the target below is met.

## Target ("good profit")

All three, measured from the paper report (`ops/task` → `paper-report N`):

1. At least **60 closed markets** copied on paper (enough to tell skill from luck).
2. **Closed return per dollar copied ≥ +5%**, after fees and slippage.
3. The result holds in **two separate halves** of the period (not one lucky week).

If no setting gets there after about four weeks, say so plainly rather than
keep fiddling: it may mean copying these traders has no edge after costs.

## Rules for changing anything

- **One change at a time**, and no more than one every 3 days (or per ~30 newly
  closed markets), so each change's effect can be read. Bugs are fixed at once.
- Every change needs evidence from **data it wasn't tuned on**: either a
  walk-forward test in `research/` on freshly collected data, or paper results
  with **≥ 30 markets** in the group the change affects.
- Never loosen trade-quality rules or the live $50 caps to make paper numbers
  look better. Paper runs with **evaluation settings** (set by the `paper` ops
  task): $500 paper bankroll, up to 40 open positions, up to 30 traders. These
  only remove throttles that exist because the real account is tiny; the
  per-trade size ($3 max), price band, 2c cap, cost limit and 14-day limit are
  the Safe ones. When judging results for a live $50 account, look at the
  20–47c bucket: above ~47c the 5-share minimum exceeds a $50 account's cap.
- Log every review and change below: date, numbers, what changed, why.

## Levers

| Area | Setting (where) | Now |
|---|---|---|
| Who to follow | skill = price move 6 h after their buys (`traderSkill.ts`) | follow only score > 0 |
| | skill sample size / shrinkage (`SKILL_MIN_SAMPLES`, `SHRINK_N`) | ≥ 8 buys, shrink 10 |
| | candidates measured per refresh (`SKILL_CANDIDATES`) | 60, leaderboard pool |
| | number followed (`topTradersToFollow`) | up to 30 on paper (16 live Safe) |
| What to copy | price band (`min/maxBuyTokenPrice`) | 20–85c |
| | max price above the trader's fill (`maxAdverseEntryMoveCents`) | 2c |
| | fee + premium limit (`maxEntryCostPercent`) | 6% |
| | smallest trader buy copied (`MIN_LEADER_BUY_USD`) | $2 |
| | max time to resolution (`maxHoursToResolution`) | 14 days |
| Exits | take-profit / stop-loss (`autoExit*`) | +30% / -25% |
| | copy the trader's sells | yes (real-time feed) |
| Size | per trade / per market (Safe) | 3% / 5% of balance |

## Evidence so far (Nov 2026, `research/`)

- Leaderboard profit / ROI / win rate did **not** predict later copy returns
  (old selection's picks ≈ average trader ≈ -2.6% per $ after costs).
- **6-hour price move after a trader's buys persists**: top 20% on older buys
  → +2.9c move and **+6.3% per $** on later buys; bottom third -6.2%.
  5-minute and 1-hour moves did not persist. Not yet statistically proven.
- Buys priced 85c+ had no edge after fees; 20–80c is where returns were.
- Trader's own buy size: $500+ buys looked better (+1.5% to +2.9%) but not
  consistently across windows.
- $50 sizing: 3% per trade halves the account far less often than 6% when
  the edge is uncertain (Monte Carlo on resolved trades).

## Reviews

### 2026-11-21 — start of paper tuning
- Switched to paper mode; trader selection changed to the 6-hour skill score.
  10 of 21 measured traders qualified.
- Fixed: false "trader exited" sells on fresh copies; paper mode touching real positions.
- Baseline: no paper copies yet.

### 2026-11-21 (03:40 UTC) — not enough signals
- No paper copies in ~2 h. Followed traders (9 active) made 21 distinct buys in
  24 h; only 4 passed the static filters (8 priced >85c, 4 blocked by the 5-share
  minimum vs the $50 per-market cap, 3 resolving >14 days, 2 other). At that
  rate 60 closed markets would take 1–2 months.
- Bug fixed: paper mode sized trades from the real wallet balance whenever a
  live key was configured; it now uses the paper bankroll only.
- Changes (throughput only; trade-quality rules untouched):
  - paper evaluation settings (above);
  - discovery: dropped the "losing this week" filter (leaderboard P&L showed no
    predictive value), pool 110 → 200 lookups, skill measured for up to 120
    candidates, new activity floor of ≥ 1 in-band buy/day.
