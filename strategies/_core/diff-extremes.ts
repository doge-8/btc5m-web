/**
 * diff extremes mapping table — used by adaptive-threshold strategies such as p2
 *
 * Data structure: EXTREME_TABLES is Record<MarketKey, RawData>
 *   - key shaped like "btc-5m", "eth-5m"
 *   - each market maintains its own (diff magnitude and distribution differ completely across markets)
 *
 * Adding a new market table:
 *   1. Run the backtest: `npx tsx backtest/diff-extremes.ts --market <key>`
 *   2. Add the generated array to EXTREME_TABLES["sym-period"]
 *   3. Restart the service
 *
 * A market without a table makes getExtremeThreshold() return null, and related strategies automatically no-op
 * (combined with the strategy's supportedMarkets allowlist, double protection)
 */

// Percentiles for each bin (p50/p70/p80/p85/p90/p93/p95/p97/p99)
type PercentileRow = {
  p50: number; p70: number; p80: number; p85: number;
  p90: number; p93: number; p95: number; p97: number; p99: number;
};

type RawData = Array<[string, PercentileRow]>; // [rem bin, percentile row]

// BTC 5m — statistics based on 6 days of tick data from 2026-04-04 ~ 2026-04-09
const BTC_5M: RawData = [
  ["0-30",    { p50: 32, p70: 56, p80: 77, p85: 91, p90: 115, p93: 136, p95: 167, p97: 200, p99: 303 }],
  ["30-60",   { p50: 30, p70: 53, p80: 73, p85: 86, p90: 109, p93: 135, p95: 158, p97: 191, p99: 295 }],
  ["60-90",   { p50: 28, p70: 50, p80: 68, p85: 82, p90: 103, p93: 128, p95: 151, p97: 194, p99: 290 }],
  ["90-120",  { p50: 26, p70: 48, p80: 66, p85: 79, p90:  99, p93: 125, p95: 150, p97: 192, p99: 288 }],
  ["120-150", { p50: 25, p70: 46, p80: 64, p85: 76, p90:  98, p93: 118, p95: 139, p97: 182, p99: 278 }],
  ["150-180", { p50: 24, p70: 43, p80: 59, p85: 70, p90:  91, p93: 110, p95: 127, p97: 159, p99: 244 }],
  ["180-210", { p50: 21, p70: 38, p80: 53, p85: 64, p90:  80, p93:  97, p95: 115, p97: 147, p99: 210 }],
  ["210-240", { p50: 18, p70: 33, p80: 46, p85: 54, p90:  68, p93:  81, p95:  95, p97: 121, p99: 182 }],
  ["240-270", { p50: 14, p70: 24, p80: 33, p85: 39, p90:  49, p93:  57, p95:  65, p97:  81, p99: 127 }],
  ["270-300", { p50:  8, p70: 17, p80: 23, p85: 28, p90:  35, p93:  41, p95:  48, p97:  59, p99:  89 }],
];

// Extreme tables per market — to add a new market, just add an entry here
export const EXTREME_TABLES: Record<string, RawData> = {
  "btc-5m": BTC_5M,
  // "eth-5m":  ETH_5M,
  // "btc-15m": BTC_15M,
};

// Precompiled into a Map, by marketKey → (binKey → PercentileRow)
const COMPILED_MAPS = new Map<string, Map<string, PercentileRow>>();
for (const [marketKey, raw] of Object.entries(EXTREME_TABLES)) {
  const m = new Map<string, PercentileRow>();
  for (const [bin, row] of raw) m.set(bin, row);
  COMPILED_MAPS.set(marketKey, m);
}

/** Look up the bin by rem value (one bin per 30 seconds, covering 0-300) */
export function getExtremeBin(rem: number): string | null {
  if (rem < 0 || rem >= 300) return rem >= 300 ? "270-300" : null;
  const lo = Math.floor(rem / 30) * 30;
  return `${lo}-${lo + 30}`;
}

/** Query the percentile extreme at a given rem; returns null when the current market has no table */
export function getExtremeThreshold(
  rem: number,
  percentile: 50 | 70 | 80 | 85 | 90 | 93 | 95 | 97 | 99,
): number | null {
  const map = COMPILED_MAPS.get(activeMarketKey);
  if (!map) return null;
  const bin = getExtremeBin(rem);
  if (!bin) return null;
  const row = map.get(bin);
  if (!row) return null;
  return row[`p${percentile}` as keyof PercentileRow];
}

/** Whether the current market has an extreme table */
export function hasExtremeTable(marketKey?: string): boolean {
  return COMPILED_MAPS.has(marketKey ?? activeMarketKey);
}

// Current active market key (synced by server.ts when switching markets)
let activeMarketKey = "btc-5m";
export function setActiveMarket(sym: string, period: string): void {
  activeMarketKey = `${sym}-${period}`;
}
