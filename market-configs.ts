// Multi-symbol / multi-period market configuration
// To add a new symbol / period, just add an entry to MARKETS and confirm the market exists on Polymarket

export type MarketSymbol = "btc" | "eth" | "sol";
export type MarketPeriod = "5m" | "15m";

// Composite key: `${symbol}-${period}`, used for MARKETS indexing and .active-market.json persistence
export type MarketKey = `${MarketSymbol}-${MarketPeriod}`;

export interface MarketConfig {
  key: MarketKey;
  symbol: MarketSymbol;
  period: MarketPeriod;
  periodSeconds: number;     // 5m=300, 15m=900
  displayName: string;       // Frontend display, e.g. "BTC 5m"
  slugPrefix: string;        // Polymarket slug prefix, joined as ${slugPrefix}-${windowStart}
  binanceSymbol: string;     // Binance spot symbol (lowercase)
  coinbaseProduct: string;   // Coinbase product_id
  chainlinkSymbol: string;   // symbol subscribed on Polymarket Chainlink WS (e.g. "btc/usd")
  cryptoPriceSymbol: string; // symbol param for polymarket.com /api/crypto/crypto-price (uppercase)
  cryptoPriceVariant: string; // variant param for /api/crypto/crypto-price (fiveminute / fifteenminute)
}

const SYMBOL_DEFS: Record<MarketSymbol, Omit<MarketConfig, "key" | "period" | "periodSeconds" | "displayName" | "slugPrefix" | "cryptoPriceVariant">> = {
  btc: {
    symbol: "btc",
    binanceSymbol: "btcusdt",
    coinbaseProduct: "BTC-USD",
    chainlinkSymbol: "btc/usd",
    cryptoPriceSymbol: "BTC",
  },
  eth: {
    symbol: "eth",
    binanceSymbol: "ethusdt",
    coinbaseProduct: "ETH-USD",
    chainlinkSymbol: "eth/usd",
    cryptoPriceSymbol: "ETH",
  },
  sol: {
    symbol: "sol",
    binanceSymbol: "solusdt",
    coinbaseProduct: "SOL-USD",
    chainlinkSymbol: "sol/usd",
    cryptoPriceSymbol: "SOL",
  },
};

const PERIOD_DEFS: Record<MarketPeriod, { seconds: number; periodLabel: string; cryptoPriceVariant: string }> = {
  // Note: in Polymarket's crypto-price API the fifteenminute variant does not return the 15m window open price (looks like 1h or daily data),
  // while the fiveminute variant's eventStartTime, after rounding, aligns exactly with the first 5m segment of the 15m window, so 15m also uses fiveminute.
  "5m":  { seconds: 300, periodLabel: "5m",  cryptoPriceVariant: "fiveminute" },
  "15m": { seconds: 900, periodLabel: "15m", cryptoPriceVariant: "fiveminute" },
};

const SYMBOL_DISPLAY: Record<MarketSymbol, string> = { btc: "BTC", eth: "ETH", sol: "SOL" };

function buildMarkets(): Record<MarketKey, MarketConfig> {
  const out = {} as Record<MarketKey, MarketConfig>;
  for (const sym of Object.keys(SYMBOL_DEFS) as MarketSymbol[]) {
    for (const p of Object.keys(PERIOD_DEFS) as MarketPeriod[]) {
      const key: MarketKey = `${sym}-${p}`;
      out[key] = {
        ...SYMBOL_DEFS[sym],
        key,
        period: p,
        periodSeconds: PERIOD_DEFS[p].seconds,
        displayName: `${SYMBOL_DISPLAY[sym]} ${PERIOD_DEFS[p].periodLabel}`,
        slugPrefix: `${sym}-updown-${p}`,
        cryptoPriceVariant: PERIOD_DEFS[p].cryptoPriceVariant,
      };
    }
  }
  return out;
}

export const MARKETS: Record<MarketKey, MarketConfig> = buildMarkets();

export const DEFAULT_KEY: MarketKey = "btc-5m";

export function isValidKey(s: string): s is MarketKey {
  return s in MARKETS;
}

// Compatible with the legacy .active-market.json that only stored the symbol field
export function isLegacySymbol(s: string): s is MarketSymbol {
  return s === "btc" || s === "eth" || s === "sol";
}

export function getBinanceWsUrl(key: MarketKey): string {
  const s = MARKETS[key].binanceSymbol;
  return `wss://stream.binance.com:9443/stream?streams=${s}@aggTrade/${s}@kline_1m/${s}@kline_5m`;
}

export const ALL_PERIODS: MarketPeriod[] = ["5m", "15m"];
export const ALL_SYMBOLS: MarketSymbol[] = ["btc", "eth", "sol"];

// Return a suitable number of decimal places for the current price magnitude (shared by frontend and backend, to keep display and backtest precision consistent)
//   BTC ~$70000 → 0 decimals (integer)
//   ETH ~$3000  → 2 decimals
//   SOL ~$200   → 4 decimals
//   XRP ~$2     → 4 decimals
//   DOGE ~$0.x  → 5 decimals
export function priceDecimals(price: number | null | undefined): number {
  const p = price || 0;
  if (p >= 10000) return 0;
  if (p >= 1000)  return 2;
  if (p >= 10)    return 4;
  if (p >= 1)     return 4;
  return 5;
}
