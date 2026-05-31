# Strategy Guide

> **Version:** v4.2.0
> **Author:** Penguin Sensei · 岳 · [@x_188888_x](https://x.com/x_188888_x)

## ⚠ Important Disclaimer

The strategies built into this tool are **examples only**, intended to demonstrate how to use the strategy framework, and **cannot guarantee profits**.
The Polymarket BTC 5-minute market is highly volatile, and any strategy with fixed parameters carries the risk of becoming ineffective.

**Recommendations:**

- Run one or two windows with the smallest amount and observe whether the entry/exit logic matches your judgment
- Hover in the frontend to see each strategy's entry/exit conditions
- If you have good entry/exit ideas, new data patterns, or want to work on backtest optimization together, **feel free to contact the author and refine them jointly**,
  to achieve a 1+1 > 2 effect

---

## Overview

There are currently 3 built-in example strategies (only the diff and momentum types are shown; the prob-chase type is not included as an example):

| Key | Name | Type | Summary |
|-----|------|------|------|
| D1  | Diff 1 · Standard Enhanced | Diff | diff cross entry + trailing stop + drawdown take-profit + stepped take-profit |
| D2  | Diff 2 · Tail Sweep | Diff | large-diff entry at the window tail + stepped take-profit |
| M1  | Momentum 1 | Momentum | 6-factor scoring entry, holds to window end and is decided by settlement |

Core principles:

- The authoritative state of automated strategies lives in the backend `server.ts`
- Buy confirmation relies on the local position `localSize` advanced by `UserWS`
- API positions are used only for reconciliation, releasing timed-out buy orders, and clearing residual positions after a sell
- Closing the frontend does not affect the backend strategy from continuing to run

---

## Common Terms

- **`diff`** — Binance latest price - (PriceToBeat - BinanceOffset); the core indicator for diff-strategy entry
- **`upPct / dnPct`** — the current up/down order book implied probability
- **`rem`** — seconds remaining in the current 5-minute window
- **`localSize`** — the local position advanced by UserWS; both buy confirmation and sell tracking rely on it
- **`apiVerified`** — the API and local positions are aligned

---

## Backend State Machine

- `IDLE` — no strategy is enabled
- `SCANNING` — scanning for entry conditions
- `BUYING` — buy triggered, order being sent
- `WAIT_FILL` — the first 10 seconds after the buy order is sent, only waiting for UserWS fill confirmation
- `RECONCILING_FILL` — not confirmed within 10 seconds, entering the deferred-confirmation state; after 15 seconds, only if the API also confirms no position does it return to `SCANNING`
- `HOLDING` — position confirmed, starting to run take-profit/stop-loss
- `SELLING` / `WAIT_SELL_FILL` — selling / waiting for sell confirmation
- `DONE` — round ended; when the position is not reconciled, it waits for API reconciliation before checking for residual positions

---

## Strategy D1 · Standard Enhanced (Diff Type)

### Entry Window

- Detected between `210s ~ 50s` remaining

### Entry Conditions

- **Buy up**: previous tick diff ≤ +35, current tick diff > +35, up probability < 80%
- **Buy down**: previous tick diff ≥ -35, current tick diff < -35, down probability < 80%

("Re-cross above/below triggers," not "buy whenever the current value is met")

### Cooldown Lock (Prevents Chasing Highs and Flip-Flopping)

**Neutral reset**: `|diff| ≤ 25` sustained for 3 seconds → release all cooldown locks

**Single-direction lock** (locks that direction if any is met, until returning to neutral):

- High-probability contamination seen first: while diff is within the trigger threshold, the up/down probability is already ≥ 80%
- Overheated: diff ≥ +55 and up probability ≥ 85% (buy-up direction) / diff ≤ -55 and down probability ≥ 85% (buy-down direction)

### Exit Mechanisms (Multiple)

1. **Stepped take-profit** — rises linearly from 90% at 210s to 100% at 10s; sells when the current probability reaches the threshold of the moment
2. **Drawdown take-profit** — after the probability peak during holding reaches ≥ 85%, sells once it pulls back 8 percentage points
3. **Trailing stop** — enabled after a minimum holding of 3 seconds; triggered when diff pulls back 20 points from its peak
4. **Backstop stop-loss** — buy-up diff ≤ +5 / buy-down diff ≥ -5, stop out immediately
5. **Forced close** — when rem ≤ 10s: take profit if probability ≥ 70%, otherwise stop out

---

## Strategy D2 · Tail Sweep (Diff Type)

### Entry Window

- Detected between `60s ~ 1s` remaining

### Entry Conditions

- **Buy up**: diff > +50 and up probability < 95%
- **Buy down**: diff < -50 and down probability < 95%

### Exit Mechanisms

**Stepped take-profit** (tightened in tiers by time remaining):

- `rem ≥ 40s`: probability ≥ 98%
- `20s ≤ rem < 40s`: probability ≥ 99%
- `10s ≤ rem < 20s`: probability ≥ 100%
- `rem < 10s`: hold to the end, decided by settlement

**Stop-loss**:

- Buy-up diff ≤ +5
- Buy-down diff ≥ -5

---

## Strategy M1 · Momentum (Momentum Type)

### Entry Window

- Detected when more than 60s remain (the final segment of the window does not participate in momentum evaluation)

### Entry Logic

Based on **6-factor momentum scoring** (see `strategies/_core/s6-core.ts` for details):

- RSI deviation
- Volume expansion
- 1-minute candle direction
- Price change magnitude
- Candle body ratio
- Number of consecutive same-color candles
- MA7 position
- (Auxiliary filter) MA120 long-term trend + 5-minute structure

An UP threshold triggers buy up, a DOWN threshold triggers buy down (the short threshold is stricter).

### Exit Mechanisms

**No take-profit, no stop-loss, no forced close**; holds to the window end and the win/loss is decided by Polymarket settlement.

This is a "pure settlement" style strategy example: verifying "whether the momentum direction judgment is accurate" rather than "agonizing over mid-window take-profit/stop-loss."

---

## Buy/Sell Confirmation and Residual-Position Handling

### Buy Confirmation Flow

1. Strategy triggers → `BUYING` sends order → `WAIT_FILL` waits for UserWS
2. Not confirmed within 10 seconds: enter `RECONCILING_FILL`, keep waiting for UserWS
3. After 15 seconds, only if the API also confirms no position is the buy order released and it returns to scanning

### Selling

- When selling an unaligned position, reserve a `0.05`-share buffer to avoid insufficient balance
- If residual positions remain after API alignment, clear them again

---

## Configuration Source

- On startup, strategy config is read from `.env` (`STRATEGY_{D1,D2,M1}_ENABLED`, etc.)
- Frontend changes only affect the current process and are not persisted across restarts
- After restart, `.env` still takes precedence

---

## Usage Recommendations

- We recommend running on the premise that "the account has no position in the current window at startup"
- If you need to view status remotely, prefer `APP_MODE=full` + an SSH tunnel
- The example strategy parameters are all empirical values under historical data; please backtest and verify them yourself before live trading

---

## Co-Development

Got a good strategy? Let's optimize it together! Contact the author: [@x_188888_x](https://x.com/x_188888_x)
