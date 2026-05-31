/**
 * Momentum strategy shared core — entry logic + factor computation
 *
 * Implemented strictly per the original strategy spec, shared by s6/s13:
 * 1. Current candle direction + 5-bar 1-minute momentum direction must agree
 * 2. 6-factor scoring (RSI 25% / volume 20% / price 20% / candle 15% / consecutive 15% / MA7 5%)
 * 3. Bonus when the 5-minute trend agrees (strength * 0.1)
 * 4. MA120 long-term trend filter + 5-minute trend filter
 * 5. UP threshold 0.55 / DOWN threshold 0.60
 */

import type { Kline, StrategyTickContext, StrategyDirection } from "../types.js";

// ── Entry parameters ────────────────────────────────────────────────
export const UP_THRESHOLD = 0.55;
export const DOWN_THRESHOLD = 0.60;
export const WINDOW_MIN_REMAINING = 30;   // do not enter when the window's remaining seconds are below this value

// ── Momentum parameters ────────────────────────────────────────────────
export const MOMENTUM_BARS = 5;            // use the latest 5 1-minute K-lines to judge momentum
export const MOMENTUM_THRESHOLD_PCT = 0.05; // a 0.05% move determines the momentum direction

// ── K-line indicator computation functions ────────────────────────────

export function calcRSI(klines: readonly Kline[], period = 14): number | null {
  if (klines.length < period + 1) return null;
  let gain = 0, loss = 0;
  const start = klines.length - period;
  for (let i = start; i < klines.length; i++) {
    const change = klines[i].close - klines[i - 1].close;
    if (change >= 0) gain += change; else loss -= change;
  }
  if (loss === 0) return 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

export function calcMA(klines: readonly Kline[], period: number): number | null {
  if (klines.length < period) return null;
  let sum = 0;
  for (let i = klines.length - period; i < klines.length; i++) {
    sum += klines[i].close;
  }
  return sum / period;
}

/** Overall momentum direction of the latest N K-lines */
export function momentumDirection(klines: readonly Kline[], bars: number, thresholdPct: number): "up" | "down" | "neutral" {
  if (klines.length < bars) return "neutral";
  const first = klines[klines.length - bars];
  const last = klines[klines.length - 1];
  const change = (last.close - first.open) / first.open * 100;
  if (change > thresholdPct) return "up";
  if (change < -thresholdPct) return "down";
  return "neutral";
}

/** Current candle direction (strictly by bullish/bearish close, no body-ratio filter) */
export function currentCandleDirection(klines: readonly Kline[]): "up" | "down" | "neutral" {
  if (!klines.length) return "neutral";
  const k = klines[klines.length - 1];
  if (k.close > k.open) return "up";
  if (k.close < k.open) return "down";
  return "neutral";
}

/** Number of consecutive same-direction K-lines */
export function consecutiveSameDirection(klines: readonly Kline[], dir: "up" | "down"): number {
  let count = 0;
  for (let i = klines.length - 1; i >= 0; i--) {
    const k = klines[i];
    const kDir = k.close > k.open ? "up" : k.close < k.open ? "down" : "neutral";
    if (kDir === dir) count++;
    else break;
  }
  return count;
}

// ── Individual scoring functions ────────────────────────────

export function scoreConsecutive(count: number): number {
  return Math.min(count / 3, 1.0);
}

export function scoreRSI(rsi: number): number {
  if (rsi > 70) return 1.0;
  if (rsi > 60) return 0.8;
  if (rsi > 50) return 0.6;
  if (rsi > 40) return 0.4;
  return 0.2;
}

export function scoreVolume(klines: readonly Kline[]): number {
  if (klines.length < 20) return 0;
  let sum = 0;
  for (let i = klines.length - 20; i < klines.length - 1; i++) {
    sum += klines[i].volume;
  }
  const avg = sum / 19;
  if (avg === 0) return 0;
  const ratio = Math.max(0.1, Math.min(5.0, klines[klines.length - 1].volume / avg));
  if (ratio > 1) return Math.min(ratio / 2, 1.0);
  return ratio * 0.5;
}

export function scorePriceChange(klines: readonly Kline[], bars: number): number {
  if (klines.length < bars + 1) return 0;
  const from = klines[klines.length - 1 - bars].close;
  const to = klines[klines.length - 1].close;
  const changePct = Math.abs((to - from) / from * 100);
  return Math.min(changePct / 0.1, 1.0);
}

export function scoreCandle(klines: readonly Kline[]): number {
  if (!klines.length) return 0;
  const k = klines[klines.length - 1];
  const range = k.high - k.low;
  if (range === 0) return 0;
  const body = Math.abs(k.close - k.open);
  const upperWick = k.high - Math.max(k.open, k.close);
  const lowerWick = Math.min(k.open, k.close) - k.low;
  const bodyRatio = body / range;
  const wickPenalty = (upperWick + lowerWick) / range;
  return Math.max(0, Math.min(1, bodyRatio - wickPenalty * 0.3));
}

export function scoreMA7(klines: readonly Kline[], dir: "up" | "down"): number {
  const ma7 = calcMA(klines, 7);
  if (ma7 == null) return 0;
  const price = klines[klines.length - 1].close;
  if (dir === "up") return price > ma7 ? 1.0 : 0;
  return price < ma7 ? 1.0 : 0;
}

// ── 5-minute trend analysis ───────────────────────────────────────────

export interface Trend5m {
  direction: "up" | "down" | "neutral";
  strength: number;
}

export function analyze5mTrend(klines5m: readonly Kline[]): Trend5m {
  if (klines5m.length < 20) return { direction: "neutral", strength: 0 };

  const ma5 = calcMA(klines5m, 5);
  const ma10 = calcMA(klines5m, 10);
  const ma20 = calcMA(klines5m, 20);
  if (ma5 == null || ma10 == null || ma20 == null) return { direction: "neutral", strength: 0 };

  let upVotes = 0, downVotes = 0;

  // a. MA structure
  if (ma5 > ma10 && ma10 > ma20) upVotes++;
  else if (ma5 < ma10 && ma10 < ma20) downVotes++;

  // b. momentum of the latest 5 bars
  const mom = momentumDirection(klines5m, 5, 0.05);
  if (mom === "up") upVotes++;
  else if (mom === "down") downVotes++;

  // c. consecutive same-direction
  const consecUp = consecutiveSameDirection(klines5m, "up");
  const consecDown = consecutiveSameDirection(klines5m, "down");
  if (consecUp >= 2) upVotes++;
  if (consecDown >= 2) downVotes++;

  const total = upVotes + downVotes;
  if (total === 0) return { direction: "neutral", strength: 0 };
  if (upVotes > downVotes) return { direction: "up", strength: upVotes / 3 };
  if (downVotes > upVotes) return { direction: "down", strength: downVotes / 3 };
  return { direction: "neutral", strength: 0 };
}

// ── Long-term trend (MA120) ────────────────────────────────────────

export function longTermTrend(klines1m: readonly Kline[]): "up" | "down" | "neutral" {
  const ma120 = calcMA(klines1m, 120);
  if (ma120 == null || !klines1m.length) return "neutral";
  const price = klines1m[klines1m.length - 1].close;
  const diffPct = (price - ma120) / ma120 * 100;
  if (diffPct > 1) return "up";
  if (diffPct < -1) return "down";
  return "neutral";
}

// ── Factor aggregation ────────────────────────────────────────────────

export interface S6Factors {
  currDir: "up" | "down" | "neutral";
  momDir: "up" | "down" | "neutral";
  rsi: number | null;
  consecutive: number;
  scRsi: number;
  scVolume: number;
  scPriceChange: number;
  scCandle: number;
  scMa7: number;
  scConsecutive: number;
  totalScore: number;
  threshold: number;
  longTrend: "up" | "down" | "neutral";
  trend5mDir: "up" | "down" | "neutral";
  trend5mStrength: number;
  dataReady: boolean;
}

/** Compute a factor snapshot (including current-direction scoring) */
export function computeFactors(ctx: StrategyTickContext): S6Factors {
  const { kline1m, kline5m } = ctx;
  const dataReady = kline1m.length >= 120 && kline5m.length >= 20;

  const currDir = currentCandleDirection(kline1m);
  const momDir = momentumDirection(kline1m, MOMENTUM_BARS, MOMENTUM_THRESHOLD_PCT);
  const rsi = calcRSI(kline1m, 14);
  const dir: "up" | "down" = currDir !== "neutral" ? currDir : "up";

  const consecutive = consecutiveSameDirection(kline1m, dir);
  const scConsecutive = scoreConsecutive(consecutive);
  const scRsi = rsi != null ? scoreRSI(rsi) : 0;
  const scVolume = scoreVolume(kline1m);
  const scPriceChange = scorePriceChange(kline1m, MOMENTUM_BARS);
  const scCandle = scoreCandle(kline1m);
  const scMa7 = scoreMA7(kline1m, dir);
  const longTrend = longTermTrend(kline1m);
  const trend5m = analyze5mTrend(kline5m);

  let totalScore =
    scConsecutive * 0.15 +
    scRsi * 0.25 +
    scVolume * 0.20 +
    scPriceChange * 0.20 +
    scCandle * 0.15 +
    scMa7 * 0.05;
  if (trend5m.direction === dir) totalScore += trend5m.strength * 0.1;

  return {
    currDir, momDir, rsi, consecutive,
    scRsi, scVolume, scPriceChange, scCandle, scMa7, scConsecutive,
    totalScore: Math.round(totalScore * 1000) / 1000,
    threshold: dir === "up" ? UP_THRESHOLD : DOWN_THRESHOLD,
    longTrend,
    trend5mDir: trend5m.direction,
    trend5mStrength: Math.round(trend5m.strength * 100) / 100,
    dataReady,
  };
}

/**
 * Determine whether it is currently US stock market hours (rough filter only, covering both DST and standard time).
 * Monday~Friday UTC 13:30 - 21:00 (covers all of ET 9:30-16:00)
 * Weekends are treated as closed all day.
 */
export function isUSMarketOpen(nowMs = Date.now()): boolean {
  const d = new Date(nowMs);
  const day = d.getUTCDay();  // 0=Sunday, 6=Saturday
  if (day === 0 || day === 6) return false;
  const minutesUTC = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutesUTC >= 13 * 60 + 30 && minutesUTC < 21 * 60;
}

/** Check entry conditions (strictly per the original strategy) */
export function checkMomentumEntry(
  ctx: StrategyTickContext,
  minRem: number = WINDOW_MIN_REMAINING,
): { direction: StrategyDirection; entryScore: number } | null {
  const { rem, kline1m, kline5m, marketHoursOnly } = ctx;
  if (rem <= minRem) return null;
  if (kline1m.length < 120) return null;
  if (kline5m.length < 20) return null;
  // US market hours filter
  if (marketHoursOnly && !isUSMarketOpen()) return null;

  // 1. current candle direction
  const currDir = currentCandleDirection(kline1m);
  if (currDir === "neutral") return null;

  // 2. 5-bar momentum direction
  const momDir = momentumDirection(kline1m, MOMENTUM_BARS, MOMENTUM_THRESHOLD_PCT);
  if (momDir !== currDir) return null;

  const dir: StrategyDirection = currDir;

  // 3. long-term trend filter
  const longTrend = longTermTrend(kline1m);
  if (dir === "up" && longTrend === "down") return null;
  if (dir === "down" && longTrend === "up") return null;

  // 4. 5-minute trend filter
  const trend5m = analyze5mTrend(kline5m);
  if (trend5m.strength > 0.3) {
    if (dir === "up" && trend5m.direction === "down") return null;
    if (dir === "down" && trend5m.direction === "up") return null;
  }

  // 5. 6-factor scoring
  const rsi = calcRSI(kline1m, 14);
  if (rsi == null) return null;

  const consecutive = consecutiveSameDirection(kline1m, dir);
  const scConsecutive = scoreConsecutive(consecutive);
  const scRsi = scoreRSI(rsi);
  const scVolume = scoreVolume(kline1m);
  const scPriceChange = scorePriceChange(kline1m, MOMENTUM_BARS);
  const scCandle = scoreCandle(kline1m);
  const scMa7 = scoreMA7(kline1m, dir);

  let totalScore =
    scConsecutive * 0.15 +
    scRsi * 0.25 +
    scVolume * 0.20 +
    scPriceChange * 0.20 +
    scCandle * 0.15 +
    scMa7 * 0.05;
  if (trend5m.direction === dir) totalScore += trend5m.strength * 0.1;

  const threshold = dir === "up" ? UP_THRESHOLD : DOWN_THRESHOLD;
  if (totalScore < threshold) return null;

  return { direction: dir, entryScore: totalScore };
}
