/**
 * Strategy 3 · Tail-Scalp — large-diff entry at the tail of the window
 */

import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
} from "./types.js";

const WINDOW_MAX_REMAINING = 30;
const ENTRY_DIFF = 40;
const ENTRY_PROB_CAP = 80;
const STOP_LOSS_DIFF = 0;

export class D1Sweep implements IStrategy {
  readonly key: StrategyKey = "d1";
  readonly number: StrategyNumber = 1;
  readonly name = "Tail-Scalp";

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Diff 1 · Tail-Scalp",
      category: { id: "diff", label: "Diff", color: "#58a6ff" },
      supportedMarkets: ["btc-5m"],
      lines: [
        { text: `⏱ Checked when remaining ${WINDOW_MAX_REMAINING}s~0s (the very tail, highest win rate)` },
        { text: `📈 Buy up: diff >+${ENTRY_DIFF} and up probability <${ENTRY_PROB_CAP}%` },
        { text: `📉 Buy down: diff <-${ENTRY_DIFF} and down probability <${ENTRY_PROB_CAP}%` },
        { text: `Stop loss: diff crosses 0 (buy up diff≤0 / buy down diff≥0)`, color: "#f85149", marginTop: true },
        { text: "No take profit, hold to window end", color: "#3fb950" },
        { text: "Backtest 24 days: ~7 trades/day / 86% win rate / $0.70 per trade (passed all 5 validations)", color: "#888", marginTop: true },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > WINDOW_MAX_REMAINING || rem <= 0) return null;

    if (diff > ENTRY_DIFF && upPct < ENTRY_PROB_CAP) return { direction: "up" };
    if (diff < -ENTRY_DIFF && dnPct < ENTRY_PROB_CAP) return { direction: "down" };
    return null;
  }

  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal {
    const { diff } = ctx;
    if (diff == null) return null;
    if (direction === "up" && diff <= STOP_LOSS_DIFF) {
      return { signal: "sl", reason: `stop loss diff=${Math.round(diff)}≤${STOP_LOSS_DIFF}` };
    }
    if (direction === "down" && diff >= -STOP_LOSS_DIFF) {
      return { signal: "sl", reason: `stop loss diff=${Math.round(diff)}≥${-STOP_LOSS_DIFF}` };
    }
    return null;
  }

  resetState(): void {}

  getStatePayload(): Record<string, unknown> {
    return {};
  }
}
