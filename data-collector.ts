/**
 * Data collector — standalone process dedicated to collecting multi-market backtest data
 *
 * Completely independent from server.ts:
 *   - Does not place orders, does not need a private key
 *   - Does not need a frontend, does not need an HTTP API
 *   - Only collects tick data for 6 markets (BTC/ETH/SOL × 5m/15m)
 *
 * Data output:
 *   backtest-data/collector/YYYY-MM-DD-{sym}-{period}.jsonl
 *   one row per second per market, in exactly the same format as server.ts backtestTick
 *
 * Start:
 *   npm run collect
 *   or ./collect.sh
 *
 * Error handling: aggressive reconnect, error isolation, never exits on its own
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync } from "fs";
import { WebSocket } from "ws";
import { Agent, setGlobalDispatcher } from "undici";
import {
  MARKETS, priceDecimals, ALL_SYMBOLS,
  type MarketKey, type MarketSymbol, type MarketConfig,
} from "./market-configs.js";

// ── HTTP keep-alive ──
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60000,
  keepAliveMaxTimeout: 600000,
  connections: 10,
  pipelining: 1,
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(__dirname, "backtest-data", "collector");
mkdirSync(DATA_DIR, { recursive: true });

// ── Constants (consistent with server.ts) ──
const MARKET_WS_URL    = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CHAINLINK_WS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA_URL        = "https://gamma-api.polymarket.com";

const HISTORY_RETENTION_MS = 130000;
const MAX_CHAINLINK_HISTORY_POINTS = 2000;
const MAX_BINANCE_HISTORY_POINTS = 4000;

const BINANCE_ALIGN_WINDOW_MS = 60000;
const BINANCE_ALIGN_MIN_SPAN_MS = 10000;
const BINANCE_ALIGN_BUCKET_MS = 500;
const BINANCE_ALIGN_REFRESH_MS = 30000;
const BINANCE_OFFSET_EPSILON = 0.01;

const PTB_RETRY_INTERVAL_MS = 2000;
const PTB_MAX_RETRIES = 5;

const HEALTH_CHECK_INTERVAL_MS = 60000;
const STALE_DATA_THRESHOLD_MS = 60000;

const TICK_WRITE_INTERVAL_MS = 1000;

const RETENTION_DAYS = parseInt(process.env.COLLECTOR_RETENTION_DAYS || "60");

// ── Data types ──
interface PricePoint { t: number; price: number; }

interface SymbolState {
  symbol: MarketSymbol;
  binanceWs: WebSocket | null;
  binanceWsAttempt: number;
  binanceLastTickAt: number;
  chainlinkWs: WebSocket | null;
  chainlinkWsAttempt: number;
  chainlinkLastTickAt: number;
  binanceHistory: PricePoint[];
  priceHistory: PricePoint[];   // chainlink
  currentPrice: number | null;
  binanceOffset: number | null;
}

interface MarketState {
  key: MarketKey;
  config: MarketConfig;
  upTokenId: string;
  downTokenId: string;
  windowStart: number;          // currently subscribed window
  windowEnd: number;
  conditionId: string;
  priceToBeat: number | null;
  bids: Map<string, string>;    // price → size
  asks: Map<string, string>;
  bestBid: string;              // up token best bid
  bestAsk: string;              // up token best ask
  marketWs: WebSocket | null;
  marketWsAttempt: number;
  marketLastTickAt: number;     // time of the last marketWs data received
  marketPingTimer: NodeJS.Timeout | null;
  switchTimer: NodeJS.Timeout | null;
  ptbRetryCount: number;
}

// ── Global state ──
const symbolStates = new Map<MarketSymbol, SymbolState>();
const marketStates = new Map<MarketKey, MarketState>();
let stopped = false;
let lastCleanupDate = "";

// ── Utility functions ──
function backoffDelay(attempt: number): number {
  return Math.min(60000, 1000 * Math.pow(2, attempt));
}

function getCurrentWindowStart(periodSeconds: number, now = Date.now()): number {
  return Math.floor(now / 1000 / periodSeconds) * periodSeconds;
}

function trimHistory<T extends { t: number }>(arr: T[], minTs: number, maxLen: number): void {
  while (arr.length > 0 && arr[0].t < minTs) arr.shift();
  while (arr.length > maxLen) arr.shift();
}

function calcMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcTrimmedMean(values: number[], trimRatio = 0.15): number | null {
  if (!values.length) return null;
  if (values.length < 4) {
    return values.reduce((s, v) => s + v, 0) / values.length;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const trim = Math.floor(sorted.length * trimRatio);
  const middle = sorted.slice(trim, sorted.length - trim);
  return middle.reduce((s, v) => s + v, 0) / middle.length;
}

function getCstDateStr(now = Date.now()): string {
  const d = new Date(now + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

// ── Binance offset calculation (exactly consistent with server.ts) ──
function calculateBinanceOffset(sym: MarketSymbol, allowLatestFallback = false): number | null {
  const ss = symbolStates.get(sym)!;
  if (!ss.binanceHistory.length || !ss.priceHistory.length) {
    if (!allowLatestFallback) return null;
    const last = ss.binanceHistory[ss.binanceHistory.length - 1];
    if (!last || ss.currentPrice == null) return null;
    return ss.currentPrice - last.price;
  }
  const now = Date.now();
  const binanceRecent = ss.binanceHistory.filter((p) => p.t >= now - BINANCE_ALIGN_WINDOW_MS);
  const chainlinkRecent = ss.priceHistory.filter((p) => p.t >= now - BINANCE_ALIGN_WINDOW_MS);
  if (!binanceRecent.length || !chainlinkRecent.length) {
    if (!allowLatestFallback) return null;
    const lastB = ss.binanceHistory[ss.binanceHistory.length - 1];
    if (!lastB || ss.currentPrice == null) return null;
    return ss.currentPrice - lastB.price;
  }

  const bSpan = binanceRecent.length >= 2 ? binanceRecent[binanceRecent.length - 1].t - binanceRecent[0].t : 0;
  const cSpan = chainlinkRecent.length >= 2 ? chainlinkRecent[chainlinkRecent.length - 1].t - chainlinkRecent[0].t : 0;
  if (Math.min(bSpan, cSpan) < BINANCE_ALIGN_MIN_SPAN_MS) {
    if (!allowLatestFallback) return null;
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }

  const overlapStart = Math.max(binanceRecent[0].t, chainlinkRecent[0].t);
  const overlapEnd = Math.min(binanceRecent[binanceRecent.length - 1].t, chainlinkRecent[chainlinkRecent.length - 1].t);
  const diffs: number[] = [];

  if (overlapEnd - overlapStart >= BINANCE_ALIGN_BUCKET_MS * 2) {
    let bIdx = 0, cIdx = 0;
    for (let bucketStart = overlapStart; bucketStart <= overlapEnd; bucketStart += BINANCE_ALIGN_BUCKET_MS) {
      const bucketEnd = bucketStart + BINANCE_ALIGN_BUCKET_MS;
      const bBucket: number[] = [], cBucket: number[] = [];
      while (bIdx < binanceRecent.length && binanceRecent[bIdx].t < bucketStart) bIdx++;
      while (cIdx < chainlinkRecent.length && chainlinkRecent[cIdx].t < bucketStart) cIdx++;
      let i = bIdx;
      while (i < binanceRecent.length && binanceRecent[i].t < bucketEnd) { bBucket.push(binanceRecent[i].price); i++; }
      let j = cIdx;
      while (j < chainlinkRecent.length && chainlinkRecent[j].t < bucketEnd) { cBucket.push(chainlinkRecent[j].price); j++; }
      const bMed = calcMedian(bBucket), cMed = calcMedian(cBucket);
      if (bMed != null && cMed != null) diffs.push(cMed - bMed);
    }
  }

  if (!diffs.length) {
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }
  if (diffs.length < 5) return calcTrimmedMean(diffs, 0);

  const median = calcMedian(diffs);
  if (median == null) return null;
  const absDeviations = diffs.map((d) => Math.abs(d - median));
  const mad = calcMedian(absDeviations) ?? 0;
  const threshold = Math.max(10, mad * 3);
  const filtered = diffs.filter((d) => Math.abs(d - median) <= threshold);
  const stable = filtered.length >= 3 ? filtered : diffs;
  return calcTrimmedMean(stable, 0.15);
}

function refreshBinanceOffset(sym: MarketSymbol): void {
  const next = calculateBinanceOffset(sym, false);
  if (next == null) return;
  const ss = symbolStates.get(sym)!;
  const prev = ss.binanceOffset;
  if (prev != null && Math.abs(prev - next) <= BINANCE_OFFSET_EPSILON) return;
  ss.binanceOffset = next;
  if (prev == null) {
    console.log(`[BinanceOffset] ${sym.toUpperCase()} init offset ${next >= 0 ? "+" : ""}${next.toFixed(2)}`);
  }
}

function maybeInitBinanceOffset(sym: MarketSymbol): void {
  const ss = symbolStates.get(sym)!;
  if (ss.binanceOffset != null) return;
  const v = calculateBinanceOffset(sym, true);
  if (v == null) return;
  ss.binanceOffset = v;
  console.log(`[BinanceOffset] ${sym.toUpperCase()} init offset ${v >= 0 ? "+" : ""}${v.toFixed(2)}`);
}

// ── Binance WS (subscribes only to aggTrade for binanceOffset calibration) ──
function startBinanceWs(sym: MarketSymbol): void {
  const ss = symbolStates.get(sym)!;
  const config = MARKETS[`${sym}-5m` as MarketKey];
  // Subscribe only to aggTrade, no klines needed (collector does not run momentum strategies)
  const url = `wss://stream.binance.com:9443/stream?streams=${config.binanceSymbol}@aggTrade`;
  const ws = new WebSocket(url);
  ss.binanceWs = ws;

  ws.on("open", () => {
    if (stopped) return;
    console.log(ss.binanceWsAttempt === 0 ? `[BinanceWS] ${sym.toUpperCase()} connected` : `[BinanceWS] ${sym.toUpperCase()} reconnected`);
    ss.binanceWsAttempt = 0;
  });

  ws.on("message", (data) => {
    if (stopped) return;
    try {
      const raw = JSON.parse(data.toString()) as { stream?: string; data?: Record<string, unknown> };
      const stream = raw.stream;
      const payload = raw.data;
      if (!stream || !payload) return;

      if (stream.endsWith("@aggTrade")) {
        const p = payload as { p?: string; T?: number };
        const price = parseFloat(p.p ?? "");
        const t = p.T ?? Date.now();
        if (!price) return;
        ss.binanceHistory.push({ t, price });
        trimHistory(ss.binanceHistory, t - HISTORY_RETENTION_MS, MAX_BINANCE_HISTORY_POINTS);
        ss.binanceLastTickAt = Date.now();
        maybeInitBinanceOffset(sym);
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    if (stopped) return;
    const delay = backoffDelay(ss.binanceWsAttempt++);
    console.log(`[BinanceWS] ${sym.toUpperCase()} disconnected, reconnecting in ${delay}ms (attempt ${ss.binanceWsAttempt})`);
    setTimeout(() => startBinanceWs(sym), delay);
  });

  ws.on("error", (err) => {
    console.error(`[BinanceWS] ${sym.toUpperCase()} error:`, err.message);
  });
}

// ── Chainlink WS (shared per symbol) ──
function startChainlinkWs(sym: MarketSymbol): void {
  const ss = symbolStates.get(sym)!;
  const config = MARKETS[`${sym}-5m` as MarketKey];
  const ws = new WebSocket(CHAINLINK_WS_URL);
  ss.chainlinkWs = ws;

  ws.on("open", () => {
    if (stopped) return;
    console.log(ss.chainlinkWsAttempt === 0 ? `[ChainlinkWS] ${sym.toUpperCase()} connected` : `[ChainlinkWS] ${sym.toUpperCase()} reconnected`);
    ss.chainlinkWsAttempt = 0;
    // Subscribe only to the price topic, not activity (order events not needed)
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol: config.chainlinkSymbol }) },
      ],
    }));
  });

  ws.on("message", (data) => {
    if (stopped) return;
    try {
      const msg = JSON.parse(data.toString()) as { topic?: string; type?: string; timestamp?: number; payload?: { value?: number; timestamp?: number } };
      if (msg.topic === "crypto_prices_chainlink" && msg.type === "update") {
        const val = msg.payload?.value;
        if (val == null) return;
        const t = msg.payload?.timestamp ?? msg.timestamp ?? Date.now();
        ss.currentPrice = val;
        ss.priceHistory.push({ t, price: val });
        trimHistory(ss.priceHistory, t - HISTORY_RETENTION_MS, MAX_CHAINLINK_HISTORY_POINTS);
        ss.chainlinkLastTickAt = Date.now();
        maybeInitBinanceOffset(sym);
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    if (stopped) return;
    const delay = backoffDelay(ss.chainlinkWsAttempt++);
    console.log(`[ChainlinkWS] ${sym.toUpperCase()} disconnected, reconnecting in ${delay}ms`);
    setTimeout(() => startChainlinkWs(sym), delay);
  });

  ws.on("error", (err) => {
    console.error(`[ChainlinkWS] ${sym.toUpperCase()} error:`, err.message);
  });
}

// ── Polymarket Market WS (independent per market) ──
function startMarketWs(ms: MarketState): void {
  const ws = new WebSocket(MARKET_WS_URL);
  ms.marketWs = ws;
  const upTokenId = ms.upTokenId;

  ws.on("open", () => {
    if (stopped) return;
    console.log(ms.marketWsAttempt === 0 ? `[MarketWS] ${ms.key} connected` : `[MarketWS] ${ms.key} reconnected`);
    ms.marketWsAttempt = 0;
    ws.send(JSON.stringify({
      assets_ids: [ms.upTokenId, ms.downTokenId],
      type: "market",
      custom_feature_enabled: true,
    }));
    if (ms.marketPingTimer) clearInterval(ms.marketPingTimer);
    ms.marketPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  });

  ws.on("message", (data) => {
    if (stopped) return;
    const msg = data.toString();
    if (msg === "PONG" || msg === "[]") return;
    try {
      const events = Array.isArray(JSON.parse(msg)) ? JSON.parse(msg) : [JSON.parse(msg)];
      for (const evt of events) {
        if (evt.bids !== undefined && evt.asks !== undefined) {
          if (evt.asset_id && evt.asset_id !== upTokenId) continue;
          ms.bids.clear(); ms.asks.clear();
          for (const b of (evt.bids as { price: string; size: string }[])) {
            if (Number(b.size) > 0) ms.bids.set(b.price, b.size);
          }
          for (const a of (evt.asks as { price: string; size: string }[])) {
            if (Number(a.size) > 0) ms.asks.set(a.price, a.size);
          }
          updateBestBidAsk(ms);
          ms.marketLastTickAt = Date.now();
        } else if (evt.event_type === "best_bid_ask") {
          if (evt.asset_id && evt.asset_id !== upTokenId) continue;
          if (evt.best_bid != null) ms.bestBid = String(evt.best_bid);
          if (evt.best_ask != null) ms.bestAsk = String(evt.best_ask);
          ms.marketLastTickAt = Date.now();
        } else if (evt.event_type === "price_change" && evt.price_changes) {
          for (const change of evt.price_changes as Record<string, string>[]) {
            if (change.asset_id !== upTokenId) continue;
            if (change.price && change.size !== undefined) {
              const size = Number(change.size);
              const map = change.side === "BUY" ? ms.bids : ms.asks;
              if (size > 0) map.set(change.price, change.size);
              else map.delete(change.price);
            }
          }
          updateBestBidAsk(ms);
          ms.marketLastTickAt = Date.now();
        }
      }
    } catch { /* ignore */ }
  });

  ws.on("close", () => {
    if (stopped) return;
    if (ms.marketPingTimer) { clearInterval(ms.marketPingTimer); ms.marketPingTimer = null; }
    const delay = backoffDelay(ms.marketWsAttempt++);
    console.log(`[MarketWS] ${ms.key} disconnected, reconnecting in ${delay}ms`);
    setTimeout(() => startMarketWs(ms), delay);
  });

  ws.on("error", (err) => {
    console.error(`[MarketWS] ${ms.key} error:`, err.message);
  });
}

function updateBestBidAsk(ms: MarketState): void {
  // Take the best bid/ask from the order book
  let bestBid = 0, bestAsk = 1;
  for (const p of ms.bids.keys()) { const n = Number(p); if (n > bestBid) bestBid = n; }
  for (const p of ms.asks.keys()) { const n = Number(p); if (n < bestAsk && n > 0) bestAsk = n; }
  if (bestBid > 0) ms.bestBid = bestBid.toFixed(2);
  if (bestAsk < 1) ms.bestAsk = bestAsk.toFixed(2);
}

// ── Polymarket REST: get token ──
interface MarketInfo {
  conditionId: string;
  upTokenId: string;
  downTokenId: string;
  windowStart: number;
  windowEnd: number;
  eventStartTime: string;
  endDate: string;
}

async function fetchMarketInfo(config: MarketConfig, windowStart: number): Promise<MarketInfo | null> {
  const slug = `${config.slugPrefix}-${windowStart}`;
  try {
    const res = await fetch(`${GAMMA_URL}/events?slug=${slug}`);
    const events = await res.json() as Record<string, unknown>[];
    if (!events?.length) return null;
    const event = events[0];
    const market = ((event.markets || []) as Record<string, unknown>[])[0];
    if (!market) return null;
    const tokens = JSON.parse(market.clobTokenIds as string || "[]") as string[];
    const outcomes = JSON.parse(market.outcomes as string || "[]") as string[];
    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
    return {
      conditionId: market.conditionId as string,
      upTokenId: tokens[upIdx >= 0 ? upIdx : 0],
      downTokenId: tokens[upIdx >= 0 ? 1 - upIdx : 1],
      windowStart,
      windowEnd: windowStart + config.periodSeconds,
      eventStartTime: market.eventStartTime as string || new Date(windowStart * 1000).toISOString(),
      endDate: market.endDate as string || new Date((windowStart + config.periodSeconds) * 1000).toISOString(),
    };
  } catch (err) {
    console.warn(`[Market] ${config.key} query failed slug=${slug}:`, (err as Error).message);
    return null;
  }
}

// ── Polymarket REST: get PTB ──
async function fetchPTB(config: MarketConfig, eventStartTime: string, endDate: string): Promise<number | null> {
  try {
    const url = `https://polymarket.com/api/crypto/crypto-price?symbol=${config.cryptoPriceSymbol}&eventStartTime=${encodeURIComponent(eventStartTime)}&variant=${config.cryptoPriceVariant}&endDate=${encodeURIComponent(endDate)}`;
    const data = await fetch(url).then((r) => r.json()) as { openPrice?: number | null };
    if (data.openPrice != null) return data.openPrice;
    return null;
  } catch {
    return null;
  }
}

// ── Switch window ──
async function switchToWindow(ms: MarketState, targetWindow: number): Promise<void> {
  const info = await fetchMarketInfo(ms.config, targetWindow);
  if (!info) {
    console.warn(`[Window] ${ms.key} switch failed windowStart=${targetWindow}, retrying in 5s`);
    setTimeout(() => switchToWindow(ms, targetWindow), 5000);
    return;
  }

  // Close the old marketWs
  if (ms.marketWs) {
    ms.marketWs.removeAllListeners("close");
    ms.marketWs.close();
    ms.marketWs = null;
  }
  if (ms.marketPingTimer) { clearInterval(ms.marketPingTimer); ms.marketPingTimer = null; }

  // Update window info
  ms.upTokenId = info.upTokenId;
  ms.downTokenId = info.downTokenId;
  ms.conditionId = info.conditionId;
  ms.windowStart = info.windowStart;
  ms.windowEnd = info.windowEnd;
  ms.priceToBeat = null;
  ms.bids.clear();
  ms.asks.clear();
  ms.bestBid = "-";
  ms.bestAsk = "-";
  ms.marketWsAttempt = 0;
  ms.ptbRetryCount = 0;

  console.log(`[Window] ${ms.key} → ${info.windowStart} (${new Date(info.windowStart * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })})`);

  // Start the new marketWs
  startMarketWs(ms);

  // Fetch PTB asynchronously
  const tryFetchPTB = async () => {
    if (stopped || ms.windowStart !== info.windowStart) return;
    if (ms.ptbRetryCount >= PTB_MAX_RETRIES) {
      console.warn(`[PTB] ${ms.key} failed ${PTB_MAX_RETRIES} times, skipping this window`);
      return;
    }
    const ptb = await fetchPTB(ms.config, info.eventStartTime, info.endDate);
    if (ptb != null) {
      ms.priceToBeat = ptb;
      console.log(`[PTB] ${ms.key} → $${ptb.toFixed(priceDecimals(ptb))}`);
    } else {
      ms.ptbRetryCount++;
      setTimeout(tryFetchPTB, PTB_RETRY_INTERVAL_MS);
    }
  };
  tryFetchPTB();

  // Schedule the next switch
  if (ms.switchTimer) clearTimeout(ms.switchTimer);
  const msUntilEnd = info.windowEnd * 1000 - Date.now();
  ms.switchTimer = setTimeout(() => {
    const nextWindow = getCurrentWindowStart(ms.config.periodSeconds);
    switchToWindow(ms, nextWindow);
  }, Math.max(0, msUntilEnd));
}

// ── Write tick ──
function writeTickFor(ms: MarketState): void {
  if (ms.priceToBeat == null) return;
  const ss = symbolStates.get(ms.config.symbol)!;
  if (ss.binanceOffset == null) return;
  const lastBinance = ss.binanceHistory[ss.binanceHistory.length - 1];
  if (!lastBinance) return;

  const diff = lastBinance.price - (ms.priceToBeat - ss.binanceOffset);
  const bid = Number(ms.bestBid);
  const ask = Number(ms.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0) return;
  const upPct = Math.round((bid + ask) / 2 * 100);
  const now = Date.now();
  const rem = Math.max(0, ms.windowEnd - Math.floor(now / 1000));

  const dec = priceDecimals(ms.priceToBeat);
  const factor = Math.pow(10, dec);

  const record = {
    type: "tick",
    ts: now,
    symbol: ms.config.symbol,
    period: ms.config.period,
    windowStart: ms.windowStart,
    diff: Math.round(diff * factor) / factor,
    upPct,
    rem,
  };

  // File naming: YYYY-MM-DD-{sym}-{period}.jsonl (unified new format, BTC 5m no longer uses the old name)
  const date = getCstDateStr(now);
  const filename = `${date}-${ms.config.symbol}-${ms.config.period}.jsonl`;
  const path = resolve(DATA_DIR, filename);
  try {
    appendFileSync(path, JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn(`[Write] ${ms.key} failed:`, (err as Error).message);
  }
}

// ── Clean up old files ──
function cleanupOldFiles(): void {
  try {
    if (!existsSync(DATA_DIR)) return;
    const files = readdirSync(DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}-\w+-\w+\.jsonl$/.test(f));
    const byDate = new Map<string, string[]>();
    for (const f of files) {
      const date = f.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(f);
    }
    const dates = [...byDate.keys()].sort();
    if (dates.length <= RETENTION_DAYS) return;
    const toDelete = dates.slice(0, dates.length - RETENTION_DAYS);
    for (const d of toDelete) {
      for (const f of byDate.get(d) || []) {
        try {
          unlinkSync(resolve(DATA_DIR, f));
          console.log(`[Cleanup] deleted old file: ${f}`);
        } catch {}
      }
    }
  } catch (err) {
    console.warn(`[Cleanup] cleanup failed:`, (err as Error).message);
  }
}

// ── Health check ──
function healthCheck(): void {
  const now = Date.now();
  for (const [sym, ss] of symbolStates) {
    if (ss.binanceLastTickAt > 0 && now - ss.binanceLastTickAt > STALE_DATA_THRESHOLD_MS) {
      console.warn(`[Health] ${sym.toUpperCase()} BinanceWS no data for ${Math.floor((now - ss.binanceLastTickAt)/1000)}s, forcing reconnect`);
      ss.binanceWs?.close();  // trigger auto reconnect
    }
    if (ss.chainlinkLastTickAt > 0 && now - ss.chainlinkLastTickAt > STALE_DATA_THRESHOLD_MS) {
      console.warn(`[Health] ${sym.toUpperCase()} ChainlinkWS no data for ${Math.floor((now - ss.chainlinkLastTickAt)/1000)}s, forcing reconnect`);
      ss.chainlinkWs?.close();
    }
  }
  for (const [key, ms] of marketStates) {
    if (ms.marketLastTickAt > 0 && now - ms.marketLastTickAt > STALE_DATA_THRESHOLD_MS) {
      console.warn(`[Health] ${key} MarketWS no data for ${Math.floor((now - ms.marketLastTickAt)/1000)}s, forcing reconnect`);
      ms.marketWs?.close();
    }
  }
}

// ── Print status summary ──
function printStatus(): void {
  console.log(`\n────────── Status summary (${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}) ──────────`);
  for (const [sym, ss] of symbolStates) {
    const offsetStr = ss.binanceOffset != null ? `${ss.binanceOffset >= 0 ? "+" : ""}${ss.binanceOffset.toFixed(2)}` : "—";
    console.log(`  ${sym.toUpperCase()}: binance ${ss.binanceHistory.length}pt, chainlink ${ss.priceHistory.length}pt, offset ${offsetStr}`);
  }
  for (const [key, ms] of marketStates) {
    const ptb = ms.priceToBeat != null ? `$${ms.priceToBeat.toFixed(priceDecimals(ms.priceToBeat))}` : "—";
    console.log(`  ${key}: window ${ms.windowStart}, PTB ${ptb}, bid/ask ${ms.bestBid}/${ms.bestAsk}`);
  }
  console.log(`────────────────────────────────────────\n`);
}

// ── Start ──
async function start(): Promise<void> {
  console.log(`╔══════════════════════════════════════════╗`);
  console.log(`║  Data collector starting                   ║`);
  console.log(`║  Data dir: backtest-data/collector/        ║`);
  console.log(`║  Retention days: ${String(RETENTION_DAYS).padEnd(24)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);

  // Initialize per-symbol state
  for (const sym of ALL_SYMBOLS) {
    symbolStates.set(sym, {
      symbol: sym,
      binanceWs: null, binanceWsAttempt: 0, binanceLastTickAt: 0,
      chainlinkWs: null, chainlinkWsAttempt: 0, chainlinkLastTickAt: 0,
      binanceHistory: [], priceHistory: [],
      currentPrice: null, binanceOffset: null,
    });
  }

  // Initialize per-market state
  for (const [key, config] of Object.entries(MARKETS)) {
    marketStates.set(key as MarketKey, {
      key: key as MarketKey,
      config,
      upTokenId: "", downTokenId: "", conditionId: "",
      windowStart: 0, windowEnd: 0,
      priceToBeat: null,
      bids: new Map(), asks: new Map(),
      bestBid: "-", bestAsk: "-",
      marketWs: null, marketWsAttempt: 0, marketLastTickAt: 0,
      marketPingTimer: null, switchTimer: null, ptbRetryCount: 0,
    });
  }

  // Start BinanceWS (per symbol, staggered by 500ms)
  console.log(`[Start] Connecting Binance WS...`);
  for (const sym of ALL_SYMBOLS) {
    startBinanceWs(sym);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Start ChainlinkWS (per symbol, staggered by 500ms)
  console.log(`\n[Start] Connecting Chainlink WS...`);
  for (const sym of ALL_SYMBOLS) {
    startChainlinkWs(sym);
    await new Promise((r) => setTimeout(r, 500));
  }

  // Start the window subscription for each market (staggered by 500ms)
  console.log(`\n[Start] Subscribing to market windows...`);
  for (const [key, ms] of marketStates) {
    const w = getCurrentWindowStart(ms.config.periodSeconds);
    switchToWindow(ms, w);
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\n[Start] ✓ All ready, starting collection...\n`);

  // Start timers
  setInterval(() => {
    for (const ms of marketStates.values()) writeTickFor(ms);
  }, TICK_WRITE_INTERVAL_MS);

  setInterval(() => {
    for (const sym of ALL_SYMBOLS) refreshBinanceOffset(sym);
  }, BINANCE_ALIGN_REFRESH_MS);

  setInterval(healthCheck, HEALTH_CHECK_INTERVAL_MS);

  setInterval(() => {
    const today = getCstDateStr();
    if (today !== lastCleanupDate) {
      cleanupOldFiles();
      lastCleanupDate = today;
    }
  }, 3600 * 1000);  // check once per hour

  setInterval(printStatus, 5 * 60 * 1000);  // print status summary every 5 minutes
}

// ── Process-level protection ──
process.on("uncaughtException", (err) => {
  console.error("[Collector] uncaught exception:", err);
  // do not exit
});

process.on("unhandledRejection", (err) => {
  console.error("[Collector] unhandled Promise rejection:", err);
});

process.on("SIGTERM", () => {
  console.log("\n[Collector] received SIGTERM, shutting down gracefully...");
  stopped = true;
  for (const ms of marketStates.values()) {
    if (ms.marketWs) ms.marketWs.close();
    if (ms.marketPingTimer) clearInterval(ms.marketPingTimer);
    if (ms.switchTimer) clearTimeout(ms.switchTimer);
  }
  for (const ss of symbolStates.values()) {
    if (ss.binanceWs) ss.binanceWs.close();
    if (ss.chainlinkWs) ss.chainlinkWs.close();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on("SIGINT", () => {
  console.log("\n[Collector] received SIGINT, shutting down gracefully...");
  process.emit("SIGTERM");
});

start().catch((err) => {
  console.error("[Collector] startup failed:", err);
  process.exit(1);
});
