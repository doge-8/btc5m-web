/**
 * Shared types for strategy modules
 */

// ── Strategy types (after plugin-ization: strategies are self-governing, no hard-coded list) ───────────
// Add a strategy: create a new sN.ts under strategies/ or strategies/extensions/
// Remove a strategy: delete the corresponding sN.ts
// The main project server.ts / index.html need no changes at all
export type StrategyKey = string;    // e.g. "s1" "s6" "s13"
export type StrategyNumber = number; // e.g. 1 6 13

// Populated at runtime by the loader. Uses a mutable array + in-place splice, so that the
// binding obtained via import sees the latest content (any array method like .map/.filter/.forEach works normally)
export const ALL_STRATEGY_KEYS: StrategyKey[] = [];
export const ALL_STRATEGY_NUMBERS: StrategyNumber[] = [];
export function __setStrategyKeys(keys: readonly StrategyKey[], numbers: readonly StrategyNumber[]): void {
  ALL_STRATEGY_KEYS.splice(0, ALL_STRATEGY_KEYS.length, ...keys);
  ALL_STRATEGY_NUMBERS.splice(0, ALL_STRATEGY_NUMBERS.length, ...numbers);
}

export type StrategyDirection = "up" | "down";
export type StrategyLifecycleState =
  | "IDLE"
  | "SCANNING"
  | "BUYING"
  | "WAIT_FILL"
  | "RECONCILING_FILL"
  | "HOLDING"
  | "SELLING"
  | "WAIT_SELL_FILL"
  | "DONE";

/** Binance K-line */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

/** Read-only market snapshot passed to strategies each tick */
export interface StrategyTickContext {
  rem: number;
  upPct: number | null;
  dnPct: number | null;
  diff: number | null;         // Binance current price - window open price (absolute USD value), strongly correlated with the coin's price magnitude
  diffBps: number | null;      // diff as a fraction of the window open price in bps (diff/PTB*10000), cross-coin generic
  volPct: number | null;       // 30-second rolling amplitude percentage = (max - min) / min * 100; null within the first 30s of startup / when data is insufficient
  now: number;
  prevUpPct: number | null;
  kline1m: readonly Kline[];   // Binance 1-minute K-lines (latest at the end)
  kline5m: readonly Kline[];   // Binance 5-minute K-lines
  marketHoursOnly: boolean;    // whether momentum strategies only enter during US stock market hours
}

/** Strategy entry signal */
export interface EntrySignal {
  direction: StrategyDirection;
}

/** Limit open-order signal (used by checkLimitOrder) */
export interface LimitOrderSignal {
  direction: StrategyDirection;
  /** Order price (0-1, absolute price) */
  price: number;
  /** Shares (minimum 5, limited by Polymarket maker minimum) */
  shares: number;
}

/** Presign request (strategy declares the limit-order parameters that need presigning)
 *
 * How it works (server implementation):
 * - When rem ∈ [remMin, remMax], the server asynchronously createOrder in the background and caches the signed package
 * - On trigger checkLimitOrder returns a LimitOrderSignal; if the server hits the presign cache it skips signing and postOrder directly
 * - All presign caches are cleared on window switch
 * - Conservative failure handling: a failed presign is not retried; if the cache is empty on trigger it falls back to live signing (the original path)
 */
export interface PresignRequest {
  /** Which rem interval to presign in (e.g. [152, 160] corresponds to elapsed 140~148s) */
  remMin: number;
  remMax: number;
  /** Directions to presign (e.g. ["up", "down"] for both sides or ["up"] for one side) */
  directions: StrategyDirection[];
  /** Limit price (0~1 absolute price) */
  price: number;
  /** Shares (minimum 5) */
  shares: number;
}

/** Limit-order runtime state (passed to checkCancelOrder) */
export interface LimitOrderRuntime {
  direction: StrategyDirection;
  price: number;
  shares: number;
  filledSize: number;
  windowStart: number;
}

/** Strategy exit signal */
export interface ExitSignalResult {
  signal: "tp" | "sl";
  reason: string;
}

export type ExitSignal = ExitSignalResult | null;

/** Description line for the frontend hover tooltip */
export interface StrategyDescriptionLine {
  text: string;
  color?: string;
  marginTop?: boolean;
}

/** Strategy category (for frontend grouped display) */
export interface StrategyCategory {
  id: string;       // category id, e.g. "momentum"
  label: string;    // display name, e.g. "Momentum"
  color: string;    // category primary color, e.g. "#3fb950"
}

/** A single row of the observe panel (generic rendering) */
export type ObserveRow =
  | { type: "score"; label: string; value: number | null; threshold?: number; unit?: string }
  | { type: "direction"; label: string; value: "up" | "down" | "neutral" | null; extra?: string }
  | { type: "text"; label: string; value: string | number | null; color?: string }
  | { type: "separator" };

/** Strategy observe panel (generic display area in the top status bar) */
export interface ObservePanelData {
  title: string;        // panel title, e.g. "Entry factors"
  color?: string;       // title color
  rows: ObserveRow[];   // data rows
}

/** Strategy description (used by the frontend to dynamically generate the UI) */
export interface StrategyDescription {
  key: StrategyKey;
  number: StrategyNumber;
  name: string;
  title: string;
  lines: StrategyDescriptionLine[];
  /** Frontend category (defaults to "Uncategorized" if omitted) */
  category?: StrategyCategory;
  /** List of supported markets (market key, e.g. ["btc-5m", "btc-15m"]). Omitted or empty array = all markets */
  supportedMarkets?: string[];
  /** Order type: market (market only, frontend shows amount box) / limit (limit only, shows shares box) / both (shows both). Defaults to "market" if omitted */
  orderType?: "market" | "limit" | "both";
  /** Tunable parameter declarations (frontend renders extra input boxes accordingly). Each item has key/label/default value/minimum/step */
  tunableParams?: TunableParam[];
  /** Parameter groups (optional; frontend renders by group with separators between groups). Each group lists the parameter keys it contains.
   *  Parameters not specified are automatically placed in a trailing "Other" group. If paramGroups is omitted entirely, parameters are rendered flat. */
  paramGroups?: StrategyParamGroup[];
}

export interface StrategyParamGroup {
  /** Group display name (e.g. "Trigger" "Position" "Session") */
  label: string;
  /** List of parameter keys contained in this group (must appear in tunableParams) */
  params: string[];
  /** Optional: group color (side bar / label color) */
  color?: string;
}

/** Strategy tunable parameter definition (frontend renders input box, server persists to strategyConfig.params) */
export interface TunableParam {
  /** Parameter key (e.g. "tpDelta" "slDiff"), matching the strategy instance field name */
  key: string;
  /** Display name (e.g. "Take profit" "Stop loss diff") */
  label: string;
  /** Default value (used for the frontend's first render) */
  defaultValue: number;
  /** Minimum (inclusive) */
  min: number;
  /** Maximum (inclusive); unbounded if omitted */
  max?: number;
  /** Step (input step) */
  step: number;
  /** Unit hint (shown to the right of the input box, e.g. "￠" "USD") */
  unit?: string;
  /** hover tooltip */
  title?: string;
}

/** Strategy interface — every strategy must implement it */
export interface IStrategy {
  readonly key: StrategyKey;
  readonly number: StrategyNumber;
  readonly name: string;

  /** Return the frontend hover description */
  getDescription(): StrategyDescription;

  /** Update internal guard state (cooldown locks, etc.) each tick, called before checkEntry */
  updateGuards(ctx: StrategyTickContext): void;

  /** Check entry conditions (called during the SCANNING phase) */
  checkEntry(ctx: StrategyTickContext): EntrySignal | null;

  /** Check exit conditions (called during the HOLDING phase) */
  checkExit(ctx: StrategyTickContext, direction: StrategyDirection): ExitSignal;

  /** Reset the strategy's private state on window switch */
  resetState(): void;

  /** Serialize the strategy's private state for broadcasting to the frontend */
  getStatePayload(): Record<string, unknown>;

  /** Notify the strategy that it has entered a position (called after a buy fills) */
  onEntryFilled?(ctx: StrategyTickContext, direction: StrategyDirection): void;

  // ── Plugin extension points (all optional) ────────────────────────────

  /** Whether the strategy needs to "compute data every tick even when disabled" (e.g. s6's factor panel) */
  readonly alwaysComputeData?: boolean;

  /** Compute data each tick (called when alwaysComputeData=true, regardless of whether the strategy is enabled) */
  computeData?(ctx: StrategyTickContext): void;

  /** Return observe panel data (the frontend's generic renderer will render this) */
  getObservePanel?(): ObservePanelData | null;

  // ── Limit-order strategy extension points (only implemented by strategies with orderType=limit/both) ──

  /**
   * Check whether a limit order needs to be placed (called each tick, only when this strategy has no active open order)
   * Returns LimitOrderSignal → server will place a GTC limit order
   * Returns null → skip this tick
   */
  checkLimitOrder?(ctx: StrategyTickContext): LimitOrderSignal | null;

  /**
   * Check whether an already-placed order needs to be canceled (called each tick, only when there is an active open order)
   * Returns true → server cancels the order
   *
   * Note: the strategy does not need to manage "whether to cancel the remainder after a fill" — the server cancels automatically
   */
  checkCancelOrder?(ctx: StrategyTickContext, order: LimitOrderRuntime): boolean;

  /**
   * Market strategy: the absolute target price (0~1) for the GTC sell take-profit placed after entry
   * - Returns a number → server places a sell @ targetPrice via the cond system after MINED
   * - Returns null / not implemented → no take profit placed, exit controlled by checkExit
   * Note: stop loss still goes through checkExit's sl signal (market sell), unaffected by this interface
   */
  getMarketTakeProfitPrice?(): number | null;

  /**
   * Limit strategy: declare presign requirements (not implemented = no presigning needed)
   * - Returns PresignRequest → server pre-signs and caches in the background when rem ∈ [remMin, remMax]
   * - When checkLimitOrder triggers, the server preferentially sends using the presign package; a hit = skip the signing latency
   * - All presign packages are invalidated on window switch
   * - Conservative on failure: a failed presign is not retried; if the cache is empty on trigger it falls back to live signing
   *
   * Note: strategy code does not need to be aware of whether the presign hit; it only needs to return a LimitOrderSignal.
   * Presigning is purely a server-side latency optimization.
   */
  getPresignRequest?(): PresignRequest | null;

  /**
   * Limit strategy: whether placing a new order is allowed in this window after a cancel (default false, only one order per window)
   * - false (default): no further order after cancel, wait for the next window
   * - true: the window marker is cleared after cancel, and a new order may be placed on the next tick if conditions are met
   */
  readonly limitAllowReplaceAfterCancel?: boolean;

  /**
   * The price (0~1 absolute price) for the take-profit sell order placed after a limit maker order is confirmed filled on-chain
   * - Returns a number → server immediately places a same-direction GTC sell order after MINED (partial fills are placed in batches)
   * - Returns null / not implemented → no take profit placed; filled shares are held to settlement
   *
   * Note: mutually exclusive with getLimitConditionOrder. If the strategy implements getLimitConditionOrder,
   *     the server preferentially uses the cond system (TP+SL managed in a shared group) and ignores this interface.
   */
  getLimitTakeProfitPrice?(): number | null;

  /**
   * Create a conditional order (take profit + stop loss, both directions) after a limit maker order is confirmed filled on-chain
   * - Reuses the manual conditional-order infrastructure (cond-tp / cond-sl); TP/SL share a groupId and clean each other up
   * - stopProfit.pctDelta: take-profit price = entryPrice + pctDelta (e.g. entry=0.50, delta=0.05 → tp=0.55)
   * - stopProfit.targetPrice: take-profit absolute price (e.g. 0.99); choose one of this or pctDelta
   * - stopLoss.diffValue: triggered by diff crossing (buy up: diff ≤ -diffValue / buy down: diff ≥ diffValue)
   * - Returns null / not implemented → falls back to the getLimitTakeProfitPrice path
   */
  getLimitConditionOrder?(): {
    stopProfit?: { pctDelta?: number; targetPrice?: number };
    stopLoss?: { diffValue?: number; slippage?: number };
  } | null;
}
