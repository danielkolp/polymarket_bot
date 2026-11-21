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
- Never loosen the $50 risk caps (size per trade, per-market cap, cash cushion,
  daily-loss stop) to make paper numbers look better.
- Log every review and change below: date, numbers, what changed, why.

## Levers

| Area | Setting (where) | Now |
|---|---|---|
| Who to follow | skill = price move 6 h after their buys (`traderSkill.ts`) | follow only score > 0 |
| | skill sample size / shrinkage (`SKILL_MIN_SAMPLES`, `SHRINK_N`) | ≥ 8 buys, shrink 10 |
| | candidates measured per refresh (`SKILL_CANDIDATES`) | 60, leaderboard pool |
| | number followed (`topTradersToFollow`) | up to 16 (Safe) |
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
