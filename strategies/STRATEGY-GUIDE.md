# Strategy Development Guide

This document explains how to add / modify Polymarket up/down strategies in this project.

---

## 1. File naming

Strategies go under the `strategies/` directory, with filename format:

```
<prefix><number>.ts
```

- **prefix** by strategy type:
  - `d` — diff-based (market path)
  - `p` — prob-chase (market path)
  - `t` — trend arbitrage (market path)
  - `l` — limit-order (maker resting orders; see §6A)
  - `m` — momentum (reserved)
- **number** increments (e.g. d1.ts, d2.ts, d3.ts)

The bundled strategies are **d1 / p1 / p2** (market path). Limit-order strategies use the `l` prefix.

On startup `_runtime/loader.ts` automatically scans and registers them, **with no changes to the main project code**.

---

## 2. Strategy interface

Each strategy exports a **class implementing the `IStrategy` interface** as the default export.

Minimal skeleton (see [d1.ts](d1.ts) for a complete example):

```ts
import type {
  IStrategy, StrategyKey, StrategyNumber,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
  StrategyDirection,
} from "./types.js";

export default class MyStrategy implements IStrategy {
  readonly key: StrategyKey = "x1";
  readonly number: StrategyNumber = 1;
  readonly name = "My Strategy";

  // private state (must be cleared in resetState)
  private peakDiff = 0;

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Strategy description",
      category: { id: "diff", label: "Diff", color: "#58a6ff" },
      supportedMarkets: ["btc-5m"],   // see §3
      lines: [
        { text: "📈 Entry condition description..." },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {
    // maintain cooldown locks, cold-start checks, etc. each tick
  }

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    if (ctx.diffBps != null && ctx.diffBps >= 8) {
      return { direction: "up" };
    }
    return null;
  }

  checkExit(_ctx: StrategyTickContext, _direction: StrategyDirection): ExitSignal {
    // usually only return sl; take profit goes via GTC (see §6)
    return null;
  }

  resetState(): void {
    this.peakDiff = 0;
  }

  getStatePayload(): Record<string, unknown> {
    return { peakDiff: this.peakDiff };
  }
}
```

---

## 3. Market allowlist `supportedMarkets`

Declare **which markets this strategy supports**. Unsupported markets are not shown by the frontend and skipped during the backend tick.

```ts
supportedMarkets: ["btc-5m"]                 // BTC 5m only
supportedMarkets: ["btc-5m", "btc-15m"]      // both BTC periods
supportedMarkets: ["eth-5m", "sol-5m"]       // ETH and SOL 5m
// omitted / empty array = supports all markets (not recommended; most strategy thresholds are strongly coin-dependent)
```

**market key format**: `{symbol}-{period}`
- symbol: `btc` / `eth` / `sol` (see [market-configs.ts](../market-configs.ts))
- period: `5m` / `15m`

**Convention**: write a separate strategy file per coin + period.
- Example: BTC 5m uses d1.ts, ETH 5m uses d10.ts, BTC 15m uses d20.ts
- Do not split logic with if-else in the same file; it is hard to maintain

---

## 4. TickContext fields

`checkEntry` / `checkExit` / `updateGuards` all receive a `StrategyTickContext`:

| Field | Type | Meaning |
|---|---|---|
| `rem` | number | current window remaining seconds (5m 0~300, 15m 0~900) |
| `upPct` | number\|null | Polymarket up probability, 0-100 integer |
| `dnPct` | number\|null | down probability (= 100 - upPct) |
| `diff` | number\|null | Binance current price - window open price (**absolute USD value**) |
| `diffBps` | number\|null | diff as bps of PTB, **cross-market generic** |
| `prevUpPct` | number\|null | the previous tick's upPct, used to detect threshold crossings |
| `kline1m` | Kline[] | Binance 1m K-lines (latest at the end) |
| `kline5m` | Kline[] | Binance 5m K-lines |
| `marketHoursOnly` | boolean | user config: whether to enter only during US stock market hours |
| `now` | number | current timestamp (ms) |

### diff vs diffBps — which to use?

- **Writing a cross-market strategy → use diffBps** (recommended)
  - Example: BTC `diff=50` → `diffBps≈7`, SOL `diff=0.05` → `diffBps≈25`
  - Thresholds written in bps are cross-market readable: `if (ctx.diffBps >= 10)` means a 0.1% move
- **Writing a BTC-5m-only legacy strategy → use diff** (keep as is)
  - Do not casually change the USD thresholds of the legacy d1/d2/m1 etc.; they are already hand-tuned

### Unit conversion

- 1% = 100 bps
- 0.1% = 10 bps
- 0.01% = 1 bps
- diffBps is rounded to 2 decimal places

---

## 5. Entry signal `checkEntry`

```ts
checkEntry(ctx): EntrySignal | null {
  // return null for no entry
  // return { direction: "up" | "down" } to enter
}
```

**When called**: once every 250ms, only when `strategyRuntime.state === "SCANNING"` (the idle scanning period after IDLE).

**Notes**:
- Do not write state-machine transition logic here — after returning a signal, server.ts handles it itself
- With multiple concurrent strategies, **the first strategy to return non-null wins**, iterated in strategyKeys order
- Data guard: skip when `upPct == null` / `diff == null` (data not ready)

---

## 6. Exit signal `checkExit`

```ts
checkExit(ctx, direction): ExitSignal {
  // return null for no exit
  // return { signal: "sl", reason: "..." } for stop loss
  // take profit is generally not returned here (see below)
}
```

### Take profit goes via GTC limit order (important convention)

**Why**: Polymarket waives the taker fee (~1.56%) for makers and pays a rebate, so a complete buy+sell using maker orders saves ~3% in fees.

**Implementation** (market-path strategies, i.e. those that enter via `checkEntry`):
1. The strategy implements the optional method `getMarketTakeProfitPrice(): number | null` returning the absolute target price (0~1):
   ```ts
   getMarketTakeProfitPrice(): number | null {
     return 0.98;   // null = no take profit, hold to settlement
   }
   ```
2. After the buy is MINED, server.ts automatically places a GTC sell order at that price (via the cond system) using the real filled shares
3. **Do not write a tp branch in `checkExit`**; keep only sl
4. Fallback: GTC minimum is 5 shares; if insufficient or order placement fails, the server automatically falls back to a local market take profit

> Limit-path strategies (`orderType: "limit"`) do **not** use this method — they manage take profit / stop loss through `getLimitConditionOrder` instead. See §6A.

### No-take-profit strategies

The bundled strategies (d1 / p1 / p2) deliberately do not take profit — data proves that once BTC commits to a direction it reaches 99-100% at settlement, so taking profit actually earns less. They hold to settlement and return only an `sl` signal from `checkExit`, so none of them implement `getMarketTakeProfitPrice`.

---

## 6A. Limit-order strategies (`checkLimitOrder` / `checkCancelOrder` / `getLimitConditionOrder`)

Everything above (§5 `checkEntry`, §6 `checkExit`) is the **market path**: the server takes the order book and buys at market on a signal. A **limit-order strategy** is a separate path — it rests a GTC maker buy order on the book, manages its own cancellation, and on fill places a co-managed take-profit + stop-loss pair. Using maker orders on both legs is what saves the ~3% fee.

A strategy opts into this path purely by what it implements; the main project code never changes.

### Opting in

Set `orderType: "limit"` in `getDescription()` and implement `checkLimitOrder`. The market-path methods become no-ops:

```ts
getDescription(): StrategyDescription {
  return {
    key: this.key, number: this.number, name: this.name,
    title: "...",
    category: { id: "limit-diff", label: "Limit Diff", color: "#3fb950" },
    supportedMarkets: ["btc-5m"],
    orderType: "limit",            // ← declares this as a limit strategy
    lines: [ /* ... */ ],
  };
}

// market path unused — return nothing
checkEntry(_ctx) { return null; }
checkExit(_ctx, _dir) { return null; }
```

(`orderType` may also be `"both"` if a strategy uses the market and limit paths together. Omitted defaults to `"market"`.)

### The three hooks and when the server calls them

The server runs a limit tick every cycle. For each enabled limit strategy it follows this state machine:

| Situation | Hook called | Return | Server action |
|---|---|---|---|
| No active resting order this window | `checkLimitOrder(ctx)` | `LimitOrderSignal` | place a GTC maker buy at the returned price/shares |
| | | `null` | do nothing this tick |
| An order is resting (unfilled / partially filled) | `checkCancelOrder(ctx, order)` | `true` | cancel the resting order |
| | | `false` | leave it on the book |
| A resting order is confirmed filled on-chain (MINED) | `getLimitConditionOrder()` | `{ stopProfit?, stopLoss? }` | place the TP + SL conditional pair for the filled shares |

Key timing rules the server enforces for you — you do **not** code these:

- **One order per window** by default. After placing, the window is marked; `checkLimitOrder` won't be called again that window. (Set `limitAllowReplaceAfterCancel = true` to allow re-placing after a cancel — see below.)
- **`checkLimitOrder` and `checkCancelOrder` are mutually exclusive per tick**: the place hook only runs when there is no resting order, the cancel hook only when there is one.
- **Remaining-shares cancellation after a fill is automatic** — your `checkCancelOrder` does not need to handle "cancel the unfilled remainder once partially filled".
- **All resting orders and presign caches are cleared on window switch.**

### `checkLimitOrder` — place a resting buy

Called each tick while the strategy has no active order. Return a `LimitOrderSignal` to rest a GTC maker buy, or `null` to wait.

```ts
checkLimitOrder(ctx: StrategyTickContext): LimitOrderSignal | null {
  // decide direction / price / shares from ctx (rem, diff, upPct, dnPct, ...)
  if (/* your entry condition */) {
    return {
      direction: "up",     // or "down"
      price: 0.50,         // 0~1 absolute limit price
      shares: this.shares, // minimum 5 (Polymarket maker minimum)
    };
  }
  return null;
}
```

### `checkCancelOrder` — pull the resting buy

Called each tick while an order is resting. Return `true` to cancel (e.g. the edge that justified the order has decayed, or the window is near its end), `false` to keep resting. The current order's runtime state is passed in:

```ts
checkCancelOrder(ctx: StrategyTickContext, order: LimitOrderRuntime): boolean {
  // order: { direction, price, shares, filledSize, windowStart }
  if (/* condition gone */) return true;
  return false;
}
```

### `getLimitConditionOrder` — TP + SL after fill

Called once the resting buy is confirmed filled on-chain. Return a take-profit and/or stop-loss spec; the server places them as a **shared group** (triggering either one auto-cancels the other), reusing the same conditional-order infrastructure as manual TP/SL.

```ts
getLimitConditionOrder() {
  return {
    // take profit (omit for no TP → hold to settlement):
    stopProfit: { pctDelta: 0.05 },   // tp price = entryPrice + 0.05
    //   ...or an absolute price instead: { targetPrice: 0.99 }
    // stop loss (diff-crossing, market sell):
    stopLoss: { diffValue: 10, slippage: 0.15 },
    //   buy up  → triggers when diff ≤ -diffValue
    //   buy down→ triggers when diff ≥ +diffValue
  };
}
```

- Omit `stopProfit` → no take profit, the filled shares are held to settlement.
- Omit `stopLoss` → no automatic stop loss.
- This interface **takes precedence over** the simpler `getLimitTakeProfitPrice()` (TP-only) fallback; implement one or the other.

### Optional refinements

- **`limitAllowReplaceAfterCancel?: boolean`** (default `false`). When `true`, the per-window mark is cleared after a cancel, so `checkLimitOrder` may place a fresh order again later in the same window (useful for full-window strategies that re-arm after a false start). When `false`, one cancel ends the strategy's activity for that window.

- **`getPresignRequest?(): PresignRequest | null`** — a pure latency optimization. Declare the rem interval / directions / price / shares you expect to use, and the server pre-signs the order package in the background so that when `checkLimitOrder` fires it can `postOrder` immediately and skip the signing round-trip. Your `checkLimitOrder` does not need to know whether the presign hit — it just returns the signal as usual; presigning is invisible to strategy logic and is invalidated on window switch.

### Minimal limit-strategy skeleton

```ts
import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
  LimitOrderSignal, LimitOrderRuntime,
} from "./types.js";

export class MyLimitStrategy implements IStrategy {
  readonly key: StrategyKey = "l9";
  readonly number: StrategyNumber = 9;
  readonly name = "My Limit Strategy";
  shares = 5;
  readonly limitAllowReplaceAfterCancel = true;

  getDescription(): StrategyDescription {
    return {
      key: this.key, number: this.number, name: this.name,
      title: "Limit example",
      category: { id: "limit-diff", label: "Limit Diff", color: "#3fb950" },
      supportedMarkets: ["btc-5m"],
      orderType: "limit",
      lines: [{ text: "..." }],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}
  checkEntry(_ctx: StrategyTickContext): EntrySignal | null { return null; }
  checkExit(_ctx: StrategyTickContext, _d: StrategyDirection): ExitSignal { return null; }

  checkLimitOrder(ctx: StrategyTickContext): LimitOrderSignal | null {
    // return { direction, price, shares } when conditions are met, else null
    return null;
  }

  checkCancelOrder(ctx: StrategyTickContext, _order: LimitOrderRuntime): boolean {
    // return true to cancel the resting order
    return false;
  }

  getLimitConditionOrder() {
    return { stopProfit: { pctDelta: 0.05 }, stopLoss: { diffValue: 10, slippage: 0.15 } };
  }

  resetState(): void {}
  getStatePayload(): Record<string, unknown> { return {}; }
}
```

> The filename prefix for limit strategies is `l` (see §1). The frontend renders a **shares** input box for `orderType: "limit"` strategies (instead of the amount box used by market strategies).

---

## 7. Strategy lifecycle

```
IDLE → SCANNING → BUYING → WAIT_FILL → HOLDING → SELLING → DONE
```

Methods called in each state:

| State | Calls | Description |
|---|---|---|
| SCANNING | `checkEntry` | look for entry opportunities |
| BUYING / WAIT_FILL | — | place order / wait for fill |
| HOLDING | `checkExit` | look for stop loss |
| SELLING | — | closing the position |

**`updateGuards`**: called every tick (regardless of state), used to maintain the strategy's private state (cooldown locks, consecutive observation counts, etc.).

**`onEntryFilled`** (optional): called once after a buy fills, used to record entryPrice etc.

**`resetState`**: called on window switch / strategy switch, clears private fields.

**`getStatePayload`**: returns the strategy's private state to display on the frontend (e.g. peakDiff).

---

## 8. Data tables (fair-prob / diff-extremes)

When a strategy needs to look up a table (e.g. the p-series looks up the fair-prob deviation):

```ts
import { getFairProb } from "./_core/fair-prob.js";

const fair = getFairProb(ctx.diff, ctx.rem);
if (fair == null) return null; // current market has no table, safely skip
```

### Adding a table for a new market

Data tables use a `Record<MarketKey, RawData>` structure; adding a new table changes only one place:

```ts
// strategies/_core/fair-prob.ts
export const FAIR_PROB_TABLES: Record<string, RawData> = {
  "btc-5m": BTC_5M,
  "eth-5m": ETH_5M,   // ← new
  "btc-15m": BTC_15M, // ← new
};
```

Generate data: run `python3 backtest-data/analyze.py --symbol <sym> --period <p>` and paste the output in.

### Guard mechanism

- Current market has no table → `getFairProb` returns null
- Strategy receives null → does not enter
- Combined with `supportedMarkets`, double protection

---

## 9. Observe panel (optional)

A strategy can display an observe panel in the frontend's top status bar (e.g. m1's factor scoring):

```ts
readonly alwaysComputeData = true; // run computeData even when the strategy is disabled

computeData(ctx: StrategyTickContext): void {
  // compute panel data, store to this.xxx
}

getObservePanel(): ObservePanelData {
  return {
    title: "Entry factors",
    color: "#3fb950",
    rows: [
      { type: "score", label: "Momentum", value: this.score, threshold: 60 },
      { type: "direction", label: "Direction", value: "up" },
    ],
  };
}
```

The frontend's generic renderer displays it automatically, with no extra frontend code.

---

## 10. New strategy checklist

After writing a new strategy, self-check against this list:

- [ ] filename `<prefix><number>.ts` is unique
- [ ] `key` matches the filename
- [ ] `number` matches the filename's number and is globally unique
- [ ] implements `getDescription` / `updateGuards` / `checkEntry` / `checkExit` / `resetState` / `getStatePayload`
- [ ] **`supportedMarkets` is declared** (otherwise it shows in all markets but uses the wrong thresholds)
- [ ] **all private state is cleared in `resetState`**
- [ ] data guard: correctly handles when `upPct == null` / `diff == null` / `getFairProb()` returns null
- [ ] cross-market strategy: use `ctx.diffBps` instead of `ctx.diff`
- [ ] take profit goes via GTC: implement `getTargetPrice`, do not write a tp branch in `checkExit`
- [ ] after restarting the service, `/api/strategy/descriptions` shows the new strategy
- [ ] switching to the corresponding market on the frontend shows the strategy toggle
- [ ] after enabling, the logs `[Strategy]` / `[Order]` show entry behavior

---

## 11. Debugging tips

### Dry-run (no order) test

Add a temporary `console.log` to the strategy file, start the service but **do not check enable on the frontend** — `updateGuards` / `computeData` are still called (if `alwaysComputeData` is declared), so you can observe scoring without actually placing orders.

### View live data

Open the frontend → look at the "Prob Chase" panel at the top for the fair / bias values, or the "Momentum" panel for the factor values.

### Historical data backtest

Run `npx tsx backtest/<your-script>.ts` to replay historical jsonl — for how to write the script, refer to [backtest/diff-extremes.ts](../backtest/diff-extremes.ts).

### Test a single market in isolation

Before starting, change `.active-market.json` to `{"key":"eth-5m"}` and restart the service. Or switch via the top dropdown on the frontend.

---

## 12. Common pitfalls

1. **Forgetting to clear state** — `resetState` not cleaned thoroughly, leaving stale peakDiff and the like across windows.
2. **Using ctx.diff in a cross-market strategy** — a BTC threshold of $35 triggers at $0.35 on ETH, inevitably causing bad entries. **Use diffBps**.
3. **Writing a tp branch in checkExit** — conflicts with GTC and may sell twice. Take profit always via `getTargetPrice`.
4. **Wrong supportedMarkets key** — e.g. `["BTC-5m"]` (uppercase) → never matches, strategy not shown. Must be lowercase `["btc-5m"]`.
5. **Depending on fair-prob but forgetting to check null** — switching to a market without a table makes `getFairProb` return null; not handling it makes NaN comparisons always false (seemingly harmless but hard to spot).
6. **Static field sharing** — using `static` fields shares them across all strategy instances. Use `private` instance fields for private state.

---

## Appendix: related file index

- [types.ts](types.ts) — interface definitions
- [registry.ts](registry.ts) — registry (usually no need to change)
- [_runtime/loader.ts](_runtime/loader.ts) — auto loader
- [_core/fair-prob.ts](_core/fair-prob.ts) — fair probability table
- [_core/diff-extremes.ts](_core/diff-extremes.ts) — diff extremes table
- [_core/s6-core.ts](_core/s6-core.ts) — momentum scoring shared logic
- [../market-configs.ts](../market-configs.ts) — market config (symbol / period / slug etc.)
- [../server.ts](../server.ts) — main service (strategy scheduling, order placement)
- [../CLAUDE.md](../CLAUDE.md) — project overview
