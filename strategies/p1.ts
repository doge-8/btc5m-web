/**
 * Strategy 5 · Prob Chase — when diff crosses, the probability is too low; hold to window settlement
 *
 * Core logic: at the moment diff breaks the threshold, if the probability has not caught up yet (deviates from the historical fair probability),
 * it means the market is reacting slowly, so enter and buy.
 *
 * Exit: no take profit, no timeout; only stop loss when diff crosses to the reverse ±5; otherwise hold to window-end settlement.
 */

import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
} from "./types.js";
import { getFairProb } from "./_core/fair-prob.js";

// ── Entry parameters ────────────────────────────────────────────────
const ENTRY_DIFF = 25;                   // check the deviation when diff crosses this threshold
const ENTRY_BIAS_MIN = 10;              // enter only when the probability deviation is at least this many percentage points (fair probability - actual probability ≥ 10)
const WINDOW_MAX_REMAINING = 90;         // entry scan start: remaining ≤90s
const WINDOW_MIN_REMAINING = 30;         // entry scan end: remaining ≤30s

// ── Exit parameters ────────────────────────────────────────────────
const STOP_LOSS_DIFF = 5;                // cross -5 stop loss: buy up diff≤-5 / buy down diff≥5

interface S5State {
  lastDiff: number | null;
  entryBias: number;       // deviation value at entry
  entryTs: number;         // entry timestamp
}

function createState(): S5State {
  return {
    lastDiff: null,
    entryBias: 0,
    entryTs: 0,
  };
}

export class P1ProbChase implements IStrategy {
  readonly key: StrategyKey = "p1";
  readonly number: StrategyNumber = 1;
  readonly name = "Prob Chase";

  private s: S5State = createState();

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Prob Chase 1",
      category: { id: "prob-chase", label: "Prob Chase", color: "#f0a500" },
      supportedMarkets: ["btc-5m"],
      lines: [
        { text: `⏱ Checked when remaining ${WINDOW_MAX_REMAINING}s~${WINDOW_MIN_REMAINING}s` },
        { text: `📈 Enter when diff crosses ±${ENTRY_DIFF} and the probability deviation ≥${ENTRY_BIAS_MIN}%` },
        { text: "deviation = historical fair probability - current probability (probability has not caught up with diff)" },
        { text: `Stop loss: buy up diff≤-${STOP_LOSS_DIFF} / buy down diff≥${STOP_LOSS_DIFF}`, color: "#f85149", marginTop: true },
        { text: "No take profit, no timeout; hold to window end and let settlement decide", color: "#f0a500" },
        { text: "Fair probability judged from a diff+rem 2D mapping table", color: "#888", marginTop: true },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= WINDOW_MIN_REMAINING) return null;

    const lastDiff = this.s.lastDiff;
    if (lastDiff == null) return null;

    // buy-up crossing
    if (lastDiff <= ENTRY_DIFF && diff > ENTRY_DIFF) {
      const fair = getFairProb(diff, rem);
      if (fair != null && fair - upPct >= ENTRY_BIAS_MIN) {
        this.s.entryBias = fair - upPct;
        return { direction: "up" };
      }
    }

    // buy-down crossing
    if (lastDiff >= -ENTRY_DIFF && diff < -ENTRY_DIFF) {
      const fair = getFairProb(diff, rem);
      if (fair != null) {
        const fairDn = 100 - fair;
        const bias = fairDn - dnPct;
        if (bias >= ENTRY_BIAS_MIN) {
          this.s.entryBias = bias;
          return { direction: "down" };
        }
      }
    }

    return null;
  }

  onEntryFilled(ctx: StrategyTickContext, _direction: StrategyDirection): void {
    this.s.entryTs = ctx.now;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { diff } = ctx;
    if (diff == null) return null;

    // cross -5 stop loss: buy up diff≤-5 / buy down diff≥5
    if (direction === "up" && diff <= -STOP_LOSS_DIFF) {
      return { signal: "sl", reason: `reverse-cross stop loss diff ${Math.round(diff)}≤-${STOP_LOSS_DIFF}` };
    }
    if (direction === "down" && diff >= STOP_LOSS_DIFF) {
      return { signal: "sl", reason: `reverse-cross stop loss diff ${Math.round(diff)}≥${STOP_LOSS_DIFF}` };
    }

    // no take profit, no timeout, no forced close → return null, hold to window-end settlement
    return null;
  }

  finalizeTick(diff: number | null): void {
    this.s.lastDiff = diff;
  }

  resetState(): void {
    this.s = createState();
  }

  getStatePayload(): Record<string, unknown> {
    return {
      lastDiff: this.s.lastDiff,
      entryBias: this.s.entryBias,
      entryTs: this.s.entryTs,
    };
  }
}
