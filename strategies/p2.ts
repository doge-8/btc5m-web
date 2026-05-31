/**
 * Strategy p2 · Prob Chase · End-Game Crossing version
 *
 * Entry (checked each tick):
 *   - 30 < rem ≤ 90 (window remaining 90s ~ 30s)
 *   - diff crosses ±25 (previous tick within ±25 / current tick crosses out)
 *   - entry-direction current probability < 65% (market has not caught up)
 *   - entry-direction deviation = historical fair probability - current probability ≥ 10%
 *
 * Exit:
 *   - no take profit
 *   - stop loss: buy up diff ≤ -5 / buy down diff ≥ 5
 *   - no timeout; with no stop loss, hold to window end and let settlement decide
 */

import type {
  IStrategy, StrategyKey, StrategyNumber, StrategyDirection,
  StrategyTickContext, EntrySignal, ExitSignal, StrategyDescription,
} from "./types.js";
import { getFairProb } from "./_core/fair-prob.js";

const REM_MAX = 90;
const REM_MIN = 30;
const ENTRY_DIFF = 25;
const ENTRY_BIAS_MIN = 10;
const ENTRY_PCT_MAX = 65;
const SL_DIFF = 5;

interface P2State {
  lastDiff: number | null;
  entryBias: number;
  entryTs: number;
}

function createState(): P2State {
  return { lastDiff: null, entryBias: 0, entryTs: 0 };
}

export class P2ProbChaseTail implements IStrategy {
  readonly key: StrategyKey = "p2";
  readonly number: StrategyNumber = 2;
  readonly name = "Prob Chase · End-Game Crossing";

  private s: P2State = createState();

  getDescription(): StrategyDescription {
    return {
      key: this.key,
      number: this.number,
      name: this.name,
      title: "Prob Chase 2 · End-Game Crossing",
      category: { id: "prob-chase", label: "Prob Chase", color: "#f0a500" },
      supportedMarkets: ["btc-5m"],
      lines: [
        { text: `⏱ Checked when remaining ${REM_MIN}s ~ ${REM_MAX}s` },
        { text: `📈 Enter when diff crosses ±${ENTRY_DIFF} and deviation ≥ ${ENTRY_BIAS_MIN}%` },
        { text: "deviation = historical fair probability - current probability (probability has not caught up with diff)" },
        { text: `🔒 Entry-direction current probability < ${ENTRY_PCT_MAX}% (enter only when the market has not caught up)` },
        { text: `Stop loss: buy up diff≤-${SL_DIFF} / buy down diff≥${SL_DIFF}`, color: "#f85149", marginTop: true },
        { text: "No take profit, no timeout; hold to window end and let settlement decide", color: "#3fb950" },
        { text: "Fair probability judged from a diff+rem 2D mapping table", color: "#888", marginTop: true },
      ],
    };
  }

  updateGuards(_ctx: StrategyTickContext): void {}

  checkEntry(ctx: StrategyTickContext): EntrySignal | null {
    const { rem, upPct, dnPct, diff } = ctx;
    if (upPct == null || dnPct == null || diff == null) return null;
    if (rem > REM_MAX || rem <= REM_MIN) return null;

    const lastDiff = this.s.lastDiff;
    if (lastDiff == null) return null;

    // cross up over +ENTRY_DIFF → buy up
    if (lastDiff <= ENTRY_DIFF && diff > ENTRY_DIFF && upPct < ENTRY_PCT_MAX) {
      const fair = getFairProb(diff, rem);
      if (fair != null) {
        const upBias = fair - upPct;
        if (upBias >= ENTRY_BIAS_MIN) {
          this.s.entryBias = upBias;
          return { direction: "up" };
        }
      }
    }

    // cross down below -ENTRY_DIFF → buy down
    if (lastDiff >= -ENTRY_DIFF && diff < -ENTRY_DIFF && dnPct < ENTRY_PCT_MAX) {
      const fair = getFairProb(diff, rem);
      if (fair != null) {
        const fairDn = 100 - fair;
        const dnBias = fairDn - dnPct;
        if (dnBias >= ENTRY_BIAS_MIN) {
          this.s.entryBias = dnBias;
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

    if (direction === "up" && diff <= -SL_DIFF) {
      return { signal: "sl", reason: `reverse cross diff=${Math.round(diff)} ≤ -${SL_DIFF}` };
    }
    if (direction === "down" && diff >= SL_DIFF) {
      return { signal: "sl", reason: `reverse cross diff=${Math.round(diff)} ≥ +${SL_DIFF}` };
    }
    return null;
  }

  /** Called externally at the end of each tick to record lastDiff for crossing detection */
  finalizeTick(diff: number | null): void {
    this.s.lastDiff = diff;
  }

  resetState(): void {
    this.s = createState();
  }

  getStatePayload(): Record<string, unknown> {
    return {
      entryBias: this.s.entryBias,
      entryTs: this.s.entryTs,
      lastDiff: this.s.lastDiff,
    };
  }
}
