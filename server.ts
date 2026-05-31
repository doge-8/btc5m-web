/**
 * BTC 5-minute up/down order book monitor - standalone server
 * Start: npx tsx server.ts
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, readdirSync, unlinkSync, statSync, renameSync } from "fs";
import { ethers } from "ethers";
import dotenv from "dotenv";
import { ClobClient, Side, OrderType, Chain, SignatureTypeV2 as SignatureType, AssetType, getContractConfig } from "@polymarket/clob-client-v2";
import { getAllStrategies, getStrategy, getAllDescriptions, initStrategies } from "./strategies/registry.js";
import type { StrategyNumber, StrategyDirection, StrategyLifecycleState, StrategyKey, TunableParam } from "./strategies/types.js";
import { ALL_STRATEGY_KEYS } from "./strategies/types.js";
import { getFairProb, hasFairProbTable, setActiveMarket as setFairProbMarket } from "./strategies/_core/fair-prob.js";
import { setActiveMarket as setDiffExtremesMarket } from "./strategies/_core/diff-extremes.js";
import { getRealFillFromTx } from "./chain-watcher.js";
import { PmPnlManager } from "./polymarket-pnl.js";
import { loadTgConfig, saveTgConfig, sendTgMessage, autoDetectChatId, type TgConfig } from "./tg-push.js";
import { MARKETS, DEFAULT_KEY, isValidKey, isLegacySymbol, getBinanceWsUrl, priceDecimals, ALL_PERIODS, ALL_SYMBOLS, type MarketKey, type MarketConfig, type MarketSymbol } from "./market-configs.js";
import { Agent, setGlobalDispatcher } from "undici";
import * as httpMod from "http";
import * as httpsMod from "https";

// Project version - keep in sync with package.json when changed
export const APP_VERSION = "5.0.0";

// -- HTTP Keep-Alive connection optimization -----------------------------
// Measured: Polymarket server closes idle connections between 30-60 seconds
//   - cold start:      689 ms
//   - connection reuse: 350 ms  (saves 340 ms)
//   - reconnect:       1586 ms  (actually slower!)
// Use keep-alive + 20s heartbeat to keep the connection alive, stabilizing order latency
//
// The two HTTP channels each have an independent connection pool, configured separately:
// 1) undici (Node built-in fetch) - fetchBookTopOfBook, Gamma API, TG push
setGlobalDispatcher(new Agent({
  keepAliveTimeout: 60000,       // client timeout 60s (server closes first)
  keepAliveMaxTimeout: 600000,
  connections: 10,
  pipelining: 1,
}));
// 2) axios (clob-client place order / query open orders / cancel) uses Node native http/https globalAgent
//    Node 19+ globalAgent.keepAlive defaults to true, but keepAliveMsecs defaults to only 1000ms,
//    when creating a socket the Agent reads the internal options object, so options.keepAliveMsecs must be changed.
//    30000 = send a TCP keep-alive probe every 30s, combined with the 20s application-layer heartbeat keeps the connection stable.
{
  type AgentInternals = { keepAlive: boolean; options: { keepAlive: boolean; keepAliveMsecs: number } };
  const httpAg = httpMod.globalAgent as unknown as AgentInternals;
  const httpsAg = httpsMod.globalAgent as unknown as AgentInternals;
  httpAg.keepAlive = true;
  httpAg.options.keepAlive = true;
  httpAg.options.keepAliveMsecs = 30000;
  httpsAg.keepAlive = true;
  httpsAg.options.keepAlive = true;
  httpsAg.options.keepAliveMsecs = 30000;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

// All logs automatically get a UTC+8 time prefix, for easier sequencing
//
// Three outputs:
//   1. Terminal: clean version (filters out lines marked [RAW])
//   2. logs/trade-YYYY-MM-DD.log: clean version (same as terminal)
//   3. logs/trade-raw-YYYY-MM-DD.log: full version (includes full raw data, for debugging)
//
// Example of a line with [RAW] prefix: console.log("[RAW]", "[Trade.Market] postOrder raw result:", JSON.stringify(result))
// Lines without the prefix (summary/progress/warning) go to terminal + clean log.
const LOG_DIR = resolve(__dirname, "logs");
const LOG_RETENTION_DAYS = 1;
const CLEAN_LOG_PREFIX = "trade-";
const RAW_LOG_PREFIX = "trade-raw-";
const LOG_FILE_SUFFIX = ".log";
/**
 * US stock market pause status: Fri 20:00 ET after-hours wrap-up ~ Mon 4:00 ET pre-market start is paused
 * (includes pre-market/after-hours liquidity periods, only avoids the truly low-liquidity weekend window, 56 hours total)
 * Returns { paused, secondsUntilNext }, secondsUntilNext is the seconds until the next status switch
 */
const WK_MAP: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const PAUSE_START_SEC = 20 * 3600;   // pause starts Fri 20:00 ET
const PAUSE_END_SEC   = 4  * 3600;   // pause ends Mon 4:00 ET
function getUsMarketStatus(d = new Date()): { paused: boolean; secondsUntilNext: number } {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(d);
    let wk = "", hour = 0, minute = 0, second = 0;
    for (const p of parts) {
      if (p.type === "weekday") wk = p.value;
      else if (p.type === "hour") hour = parseInt(p.value, 10) || 0;
      else if (p.type === "minute") minute = parseInt(p.value, 10) || 0;
      else if (p.type === "second") second = parseInt(p.value, 10) || 0;
    }
    if (hour === 24) hour = 0;
    const idx = WK_MAP[wk];
    if (idx == null) return { paused: false, secondsUntilNext: 0 };
    const hms = hour * 3600 + minute * 60 + second;
    const paused =
      (idx === 5 || idx === 6) ||
      (idx === 4 && hms >= PAUSE_START_SEC) ||
      (idx === 0 && hms < PAUSE_END_SEC);

    let secondsUntilNext: number;
    if (paused) {
      // compute to next Mon 4:00:00 ET
      if (idx === 4)      secondsUntilNext = (86400 - hms) + 2 * 86400 + PAUSE_END_SEC;  // Fri ≥ 20:00
      else if (idx === 5) secondsUntilNext = (86400 - hms) + 1 * 86400 + PAUSE_END_SEC;  // Sat
      else if (idx === 6) secondsUntilNext = (86400 - hms) + PAUSE_END_SEC;              // Sun
      else                secondsUntilNext = PAUSE_END_SEC - hms;                        // Mon < 4:00
    } else {
      // compute to next Fri 20:00:00 ET
      if (idx === 0)      secondsUntilNext = (86400 - hms) + 3 * 86400 + PAUSE_START_SEC;  // Mon ≥ 4:00
      else if (idx === 1) secondsUntilNext = (86400 - hms) + 2 * 86400 + PAUSE_START_SEC;  // Tue
      else if (idx === 2) secondsUntilNext = (86400 - hms) + 1 * 86400 + PAUSE_START_SEC;  // Wed
      else if (idx === 3) secondsUntilNext = (86400 - hms) + PAUSE_START_SEC;              // Thu
      else                secondsUntilNext = PAUSE_START_SEC - hms;                        // Fri < 20:00
    }
    return { paused, secondsUntilNext: Math.max(0, secondsUntilNext) };
  } catch {
    return { paused: false, secondsUntilNext: 0 };
  }
}
function isUsWeekend(d = new Date()): boolean {
  return getUsMarketStatus(d).paused;
}
// throttle: weekend pause log prints at most once every 30 minutes (avoids 250ms tick flooding)
let _weekendPauseLogAt = 0;
function logWeekendPauseOnce(): void {
  const now = Date.now();
  if (now - _weekendPauseLogAt < 30 * 60 * 1000) return;
  _weekendPauseLogAt = now;
  console.log("[Strategy.AntiManip] US stock low-liquidity period (Fri 20:00 ET ~ Mon 4:00 ET), pausing all new entries (positions/TP/SL run normally)");
}

function getCnDateString(d = new Date()): string {
  // compute date by UTC+8 to avoid midnight-switch errors
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  return cn.toISOString().slice(0, 10); // YYYY-MM-DD
}
function getCleanLogFile(): string {
  return resolve(LOG_DIR, `${CLEAN_LOG_PREFIX}${getCnDateString()}${LOG_FILE_SUFFIX}`);
}
function getRawLogFile(): string {
  return resolve(LOG_DIR, `${RAW_LOG_PREFIX}${getCnDateString()}${LOG_FILE_SUFFIX}`);
}
function cleanupOldLogs(): void {
  try {
    if (!existsSync(LOG_DIR)) return;
    const files = readdirSync(LOG_DIR);
    const today = getCnDateString();
    const todayMs = Date.parse(today + "T00:00:00+08:00");
    const cutoffMs = todayMs - LOG_RETENTION_DAYS * 24 * 3600 * 1000;
    for (const f of files) {
      // handle both .log and rotated backup .log.1
      let base = f;
      if (base.endsWith(".1")) base = base.slice(0, -2);
      if (!base.endsWith(LOG_FILE_SUFFIX)) continue;
      let dateStr = "";
      if (base.startsWith(RAW_LOG_PREFIX)) dateStr = base.slice(RAW_LOG_PREFIX.length, base.length - LOG_FILE_SUFFIX.length);
      else if (base.startsWith(CLEAN_LOG_PREFIX)) dateStr = base.slice(CLEAN_LOG_PREFIX.length, base.length - LOG_FILE_SUFFIX.length);
      else continue;
      const fileMs = Date.parse(dateStr + "T00:00:00+08:00");
      if (!Number.isFinite(fileMs)) continue;
      if (fileMs < cutoffMs) {
        try { unlinkSync(resolve(LOG_DIR, f)); } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}
try { mkdirSync(LOG_DIR, { recursive: true }); } catch { /* ignore */ }
cleanupOldLogs();
// at 0:01 switch date file + clean up old files (extra 1 minute tolerance for cross-day timezone jitter)
function scheduleDailyLogRotate(): void {
  const now = new Date();
  const cnNow = now.getTime() + 8 * 3600 * 1000;
  const next = new Date(cnNow);
  next.setUTCHours(0, 1, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  const delayMs = next.getTime() - cnNow;
  setTimeout(() => {
    cleanupOldLogs();
    scheduleDailyLogRotate();
  }, Math.max(60_000, delayMs)).unref?.();
}
scheduleDailyLogRotate();
// rotate when a single log file exceeds this size (rename to .1, overwriting old .1; new writes start from 0)
const LOG_MAX_BYTES = 10 * 1024 * 1024;
// RAW log switch (detailed raw data, large size): off by default, set RAW_LOG_ENABLED=true in .env when debugging
const RAW_LOG_ENABLED = String(process.env.RAW_LOG_ENABLED ?? "").toLowerCase() === "true";
function rotateIfTooLarge(file: string): void {
  try {
    if (!existsSync(file)) return;
    const sz = statSync(file).size;
    if (sz < LOG_MAX_BYTES) return;
    const rotated = file + ".1";
    try { if (existsSync(rotated)) unlinkSync(rotated); } catch { /* ignore */ }
    renameSync(file, rotated);
  } catch { /* ignore */ }
}
function appendCleanLog(line: string): void {
  try {
    const f = getCleanLogFile();
    rotateIfTooLarge(f);
    appendFileSync(f, line + "\n");
  } catch { /* ignore */ }
}
function appendRawLog(line: string): void {
  if (!RAW_LOG_ENABLED) return;
  try {
    const f = getRawLogFile();
    rotateIfTooLarge(f);
    appendFileSync(f, line + "\n");
  } catch { /* ignore */ }
}
(["log", "warn", "error"] as const).forEach(method => {
  const orig = console[method].bind(console);
  console[method] = (...args: unknown[]) => {
    const ts = new Date().toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
    // detect whether the first arg is the "[RAW]" marker
    const isRaw = args.length > 0 && args[0] === "[RAW]";
    let realArgs = isRaw ? args.slice(1) : args;
    // The SDK's "[CLOB Client] request error" log dumps the entire axios request/response into an extremely long JSON, flooding badly
    // after intercepting: terminal only shows a short summary (status + url + error), the full object goes to raw log
    let isClobErrorDigest = false;
    if (!isRaw && realArgs.length >= 2 && realArgs[0] === "[CLOB Client] request error") {
      try {
        const obj = typeof realArgs[1] === "string" ? JSON.parse(realArgs[1] as string) : realArgs[1];
        const status = (obj as any)?.status ?? "?";
        const errMsg = (obj as any)?.data?.error ?? (obj as any)?.error ?? "?";
        const url = (obj as any)?.config?.url ?? "?";
        // generate a short summary for terminal + clean log; full body goes to raw log
        appendRawLog(`[${ts}] [${method.toUpperCase()}] [CLOB Client] request error full: ${typeof realArgs[1] === "string" ? realArgs[1] : JSON.stringify(obj)}`);
        realArgs = [`[CLOB Client] ${status} ${url.split("?")[0]} - ${errMsg}`];
        isClobErrorDigest = true;
      } catch { /* on parse failure pass through as-is */ }
    }
    const text = realArgs.map(a => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return typeof a === "object" ? JSON.stringify(a) : String(a); } catch { return String(a); }
    }).join(" ");
    if (!isRaw) {
      // clean: terminal + clean log
      orig(`[${ts}]`, ...realArgs);
      appendCleanLog(`[${ts}] [${method.toUpperCase()}] ${text}`);
    }
    // raw always goes to raw log (clean lines are mirrored too, to keep raw log context complete)
    // if the full CLOB body was already written to raw log above, skip the corresponding line here to avoid duplication
    if (!isClobErrorDigest) {
      appendRawLog(`[${ts}] [${method.toUpperCase()}]${isRaw ? " [RAW]" : ""} ${text}`);
    }
  };
});

// prevent uncaught Promise rejections (e.g. RPC timeouts) from killing the process
process.on('unhandledRejection', (reason) => {
  console.error('[System.Exception]', reason instanceof Error ? reason.message : reason);
});

type AppMode = "full" | "headless";
type ClientDataMode = "full" | "low";

interface StrategyConfig {
  enabled: Record<StrategyKey, boolean>;
  amount: Record<StrategyKey, number>;
  shares: Record<StrategyKey, number>;  // share config for limit strategies (minimum 5)
  /** strategy tunable params (e.g. l1's tpDelta/slDiff), indexed by strategyKey -> paramKey -> value */
  params: Record<StrategyKey, Record<string, number>>;
  slippage: number;
  autoClaimEnabled: boolean;
  maxRoundEntries: number;
  marketHoursOnly: boolean;  // momentum strategies only enter during US market hours
  weekendPause: boolean;     // US Eastern weekend (Sat/Sun) pauses all strategy entries
}

interface StrategyConfigUpdate {
  enabled?: Partial<Record<StrategyKey, unknown>>;
  amount?: Partial<Record<StrategyKey, unknown>>;
  shares?: Partial<Record<StrategyKey, unknown>>;
  params?: Partial<Record<StrategyKey, unknown>>;
  slippage?: unknown;
  autoClaimEnabled?: unknown;
  maxRoundEntries?: unknown;
  marketHoursOnly?: unknown;
  weekendPause?: unknown;
}

interface StrategyRuntimeState {
  state: StrategyLifecycleState;
  activeStrategy: StrategyKey | null;
  direction: StrategyDirection | null;
  buyAmount: number;
  posBeforeBuy: number;
  posBeforeSell: number;
  waitVerifyAfterSell: boolean;
  cleanupAfterVerify: boolean;
  actionTs: number;
  prevUpPct: number | null;
  buyLockUntil: number;
  positionsReady: boolean;
  roundEntryCount: number;
}

interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}

interface PendingTradeMeta {
  key: string;
  orderId?: string;
  ts: number;
  windowStart: number;
  side: "buy" | "sell";
  direction: StrategyDirection;
  amount: number;
  worstPrice: number;
  source: string;
  exitReason?: string;
  roundEntry?: string;
  // only on buy: may carry these; after fill, create conditional orders based on these params
  stopProfit?: { pctDelta?: number; targetPrice?: number };
  stopLoss?: { pctDelta?: number; diffValue?: number; slippage?: number };
}

interface ClientSession {
  dataMode: ClientDataMode;
  lastStateSentAt: number;
  stateTimer: NodeJS.Timeout | null;
  stateDirty: boolean;
  stateIncludeHistory: boolean;
}

interface StatePayloadOptions {
  includeHistory?: boolean;
  simple?: boolean;
}

function parseBooleanEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return fallback;
}

function parseNumberEnv(name: string, fallback: number, minimum?: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (minimum != null && value < minimum) return fallback;
  return value;
}

function parseBooleanLike(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return null;
}

function parseNumberLike(value: unknown, minimum: number): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < minimum) return null;
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

const PORT_BASE = Number(process.env.PORT) || 3456;
const PORT_MAX_TRIES = 10;
let PORT = PORT_BASE;
const MARKET_WS_URL    = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
const CHAINLINK_WS_URL = "wss://ws-live-data.polymarket.com";
const USER_WS_URL      = "wss://ws-subscriptions-clob.polymarket.com/ws/user";
const COINBASE_WS_URL  = "wss://ws-feed.exchange.coinbase.com";
// Note: Binance WS URL, Coinbase product, slug prefix all depend on the current activeMarket, see market-configs.ts below
const GAMMA_URL        = "https://gamma-api.polymarket.com";
const CLOB_URL         = "https://clob.polymarket.com";
const HISTORY_RETENTION_MS = 130000;
const MAX_CHAINLINK_HISTORY_POINTS = 2000;
const MAX_BINANCE_HISTORY_POINTS = 4000;
const MAX_COINBASE_HISTORY_POINTS = 4000;
const MAX_KLINE_1M = 200;  // keep 200 1-minute klines
const MAX_KLINE_5M = 50;   // keep 50 5-minute klines
const MAX_CONFIRMED_TRADE_IDS = 2000;
const CLAIM_CYCLE_DELAY_MS = 15000;           // query loop interval 15s (frontend amount refresh + on-chain balance check)
const CLAIM_COOLDOWN_MS = 5 * 60 * 1000;      // Claim execution cooldown: can only claim again 5 minutes after success/failure
const UNVERIFIED_SELL_BUFFER = 0.05;
const POST_TRADE_CALIBRATION_MS = 18000;  // post-order calibration wait duration; the buy lock also uses this value
const STRAT_BUY_LOCK_MS = POST_TRADE_CALIBRATION_MS;
const STRATEGY_TICK_MS = 250;
const WAIT_FILL_TIMEOUT_MS = 10000;
const FILL_RECONCILE_TIMEOUT_MS = POST_TRADE_CALIBRATION_MS + 2000;  // wait 2 more seconds after calibration completes to confirm
const BINANCE_ALIGN_WINDOW_MS = 60000;
const BINANCE_ALIGN_MIN_SPAN_MS = 10000;
const BINANCE_ALIGN_BUCKET_MS = 500;
const BINANCE_ALIGN_REFRESH_MS = 30000;
const BINANCE_OFFSET_EPSILON = 0.01;
const FULL_DATA_STATE_INTERVAL_MS = 200;
const LOW_DATA_STATE_INTERVAL_MS = 2000;
const MAX_WS_BUFFERED_BYTES = 512 * 1024;
const STRATEGY_CONFIG_FILE = resolve(__dirname, ".strategy-config.json");
const ACTIVE_MARKET_FILE = resolve(__dirname, ".active-market.json");
const BACKTEST_DATA_DIR = resolve(__dirname, "backtest-data");

function loadActiveMarketKey(): MarketKey {
  try {
    if (existsSync(ACTIVE_MARKET_FILE)) {
      const data = JSON.parse(readFileSync(ACTIVE_MARKET_FILE, "utf-8"));
      // new format: { key: "btc-5m" }
      if (data && typeof data.key === "string" && isValidKey(data.key)) return data.key;
      // compat with old format: { symbol: "btc" } -> default upgrade to 5m
      if (data && typeof data.symbol === "string" && isLegacySymbol(data.symbol)) {
        return `${data.symbol}-5m` as MarketKey;
      }
    }
  } catch { /* ignore */ }
  return DEFAULT_KEY;
}

function saveActiveMarketKey(key: MarketKey): void {
  try {
    writeFileSync(ACTIVE_MARKET_FILE, JSON.stringify({ key }, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[System.Market] failed to save current market: ${(err as Error).message}`);
  }
}

let activeMarket: MarketConfig = MARKETS[loadActiveMarketKey()];
setFairProbMarket(activeMarket.symbol, activeMarket.period);
setDiffExtremesMarket(activeMarket.symbol, activeMarket.period);
console.log(`[System.Market] current market: ${activeMarket.displayName} (key=${activeMarket.key})`);
const PENDING_TRADE_META_MAX_AGE_MS = 15 * 60 * 1000;

const PRIVATE_KEY   = process.env.POLYMARKET_PRIVATE_KEY || "";
const PROXY_ADDRESS = process.env.POLYMARKET_PROXY_ADDRESS || "";
let accountName = "";

async function fetchAccountNameOnce(): Promise<boolean> {
  try {
    const res = await fetch(
      `https://polymarket.com/api/profile/userData?address=${PROXY_ADDRESS.toLowerCase()}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return false;
    const data = await res.json() as { name?: string; pseudonym?: string };
    const name = data.name || data.pseudonym || "";
    if (!name) return false;
    accountName = name;
    saveAccountNameToCreds(name);
    console.log(`[System.Account] ${name} (${PROXY_ADDRESS.slice(0, 6)}...${PROXY_ADDRESS.slice(-4)})`);
    return true;
  } catch (e) {
    console.log(`[System.Account] failed to get username:`, (e as Error).message);
    return false;
  }
}

async function ensureAccountName(): Promise<void> {
  if (accountName || !PROXY_ADDRESS) return;
  // backoff: 5s / 30s / 5min, give up after all fail, retry on next startup
  const delays = [5_000, 30_000, 300_000];
  if (await fetchAccountNameOnce()) return;
  for (const ms of delays) {
    await new Promise(r => setTimeout(r, ms));
    if (accountName) return; // filled by another path in the meantime
    if (await fetchAccountNameOnce()) return;
  }
}
const APP_MODE: AppMode = process.env.APP_MODE === "headless" ? "headless" : "full";
const IS_FULL_MODE = APP_MODE === "full";

function createEnvStrategyConfig(): StrategyConfig {
  const enabled = {} as Record<StrategyKey, boolean>;
  const amount = {} as Record<StrategyKey, number>;
  const shares = {} as Record<StrategyKey, number>;
  const params = {} as Record<StrategyKey, Record<string, number>>;
  for (const key of ALL_STRATEGY_KEYS) {
    const upper = key.toUpperCase();
    enabled[key] = parseBooleanEnv(`STRATEGY_${upper}_ENABLED`, false);
    amount[key] = parseNumberEnv(`STRATEGY_${upper}_AMOUNT`, 1, 0.01);
    shares[key] = parseNumberEnv(`STRATEGY_${upper}_SHARES`, 5, 5);
    params[key] = {};
  }
  return {
    enabled,
    amount,
    shares,
    params,
    slippage: parseNumberEnv("ORDER_DEFAULT_SLIPPAGE", 0.06, 0),
    autoClaimEnabled: parseBooleanEnv("AUTO_CLAIM_ENABLED", true),
    maxRoundEntries: parseNumberEnv("MAX_ROUND_ENTRIES", 1, 1),
    marketHoursOnly: parseBooleanEnv("MARKET_HOURS_ONLY", false),
    weekendPause: parseBooleanEnv("WEEKEND_PAUSE", false),
  };
}

function cloneStrategyConfig(config: StrategyConfig): StrategyConfig {
  const params = {} as Record<StrategyKey, Record<string, number>>;
  for (const key of Object.keys(config.params)) {
    params[key] = { ...config.params[key] };
  }
  return {
    enabled: { ...config.enabled },
    amount: { ...config.amount },
    shares: { ...config.shares },
    params,
    slippage: config.slippage,
    autoClaimEnabled: config.autoClaimEnabled,
    maxRoundEntries: config.maxRoundEntries,
    marketHoursOnly: config.marketHoursOnly,
    weekendPause: config.weekendPause,
  };
}

function loadPersistedStrategyConfig(config: StrategyConfig): void {
  if (!existsSync(STRATEGY_CONFIG_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(STRATEGY_CONFIG_FILE, "utf-8"));
    if (typeof raw.maxRoundEntries === "number" && raw.maxRoundEntries >= 1) {
      config.maxRoundEntries = Math.floor(raw.maxRoundEntries);
    }
    if (typeof raw.marketHoursOnly === "boolean") {
      config.marketHoursOnly = raw.marketHoursOnly;
    }
    if (typeof raw.weekendPause === "boolean") {
      config.weekendPause = raw.weekendPause;
    }
    if (typeof raw.autoClaimEnabled === "boolean") {
      config.autoClaimEnabled = raw.autoClaimEnabled;
    }
    if (isRecord(raw.enabled)) {
      for (const key of Object.keys(raw.enabled)) {
        if (typeof raw.enabled[key] === "boolean") {
          config.enabled[key] = raw.enabled[key] as boolean;
        }
      }
    }
    if (isRecord(raw.amount)) {
      for (const key of Object.keys(raw.amount)) {
        const v = raw.amount[key];
        if (typeof v === "number" && v >= 0.01) {
          config.amount[key] = v;
        }
      }
    }
    if (isRecord(raw.shares)) {
      for (const key of Object.keys(raw.shares)) {
        const v = raw.shares[key];
        if (typeof v === "number" && v >= 5) {
          config.shares[key] = v;
        }
      }
    }
    if (isRecord(raw.params)) {
      for (const key of Object.keys(raw.params)) {
        const sub = raw.params[key];
        if (!isRecord(sub)) continue;
        if (config.params[key] == null) config.params[key] = {};
        for (const pk of Object.keys(sub)) {
          const v = sub[pk];
          if (typeof v === "number" && Number.isFinite(v)) {
            config.params[key][pk] = v;
          }
        }
      }
    }
  } catch {
    // ignore
  }
}

function savePersistedStrategyConfig(config: StrategyConfig): void {
  try {
    writeFileSync(STRATEGY_CONFIG_FILE, JSON.stringify({
      maxRoundEntries: config.maxRoundEntries,
      marketHoursOnly: config.marketHoursOnly,
      weekendPause: config.weekendPause,
      autoClaimEnabled: config.autoClaimEnabled,
      enabled: config.enabled,
      amount: config.amount,
      shares: config.shares,
      params: config.params,
    }, null, 2));
  } catch (err) {
    console.warn(`[Strategy.Config] persist save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function getStrategyTunableParams(key: StrategyKey): TunableParam[] {
  const s = getStrategy(key);
  if (!s) return [];
  try {
    return s.getDescription().tunableParams ?? [];
  } catch {
    return [];
  }
}

/** inject the current value of strategyConfig.params[key] into the strategy instance field (call before each tick / at startup) */
function applyTunableParamsToStrategy(s: { key: StrategyKey }): void {
  const defs = getStrategyTunableParams(s.key);
  if (!defs.length) return;
  const stored = strategyConfig.params[s.key];
  for (const def of defs) {
    const v = stored?.[def.key];
    if (typeof v === "number" && Number.isFinite(v)) {
      (s as any)[def.key] = v;
    }
  }
}

function applyStrategyConfigUpdate(current: StrategyConfig, rawUpdate: unknown): { config?: StrategyConfig; error?: string } {
  if (!isRecord(rawUpdate)) return { error: "invalid config format" };
  const next = cloneStrategyConfig(current);

  if ("enabled" in rawUpdate) {
    if (!isRecord(rawUpdate.enabled)) return { error: "invalid enabled config format" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.enabled)) continue;
      const parsed = parseBooleanLike(rawUpdate.enabled[key]);
      if (parsed == null) return { error: `${key} switch must be a boolean` };
      next.enabled[key] = parsed;
    }
  }

  if ("amount" in rawUpdate) {
    if (!isRecord(rawUpdate.amount)) return { error: "invalid amount config format" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.amount)) continue;
      const parsed = parseNumberLike(rawUpdate.amount[key], 0.01);
      if (parsed == null) return { error: `${key} amount must be >= 0.01` };
      next.amount[key] = parsed;
    }
  }

  if ("shares" in rawUpdate) {
    if (!isRecord(rawUpdate.shares)) return { error: "invalid shares config format" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.shares)) continue;
      const parsed = parseNumberLike(rawUpdate.shares[key], 5);
      if (parsed == null) return { error: `${key} shares must be >= 5` };
      next.shares[key] = parsed;
    }
  }

  if ("params" in rawUpdate) {
    if (!isRecord(rawUpdate.params)) return { error: "invalid params config format" };
    for (const key of ALL_STRATEGY_KEYS) {
      if (!(key in rawUpdate.params)) continue;
      const sub = rawUpdate.params[key];
      if (!isRecord(sub)) return { error: `${key} invalid params format` };
      const desc = getStrategyTunableParams(key);
      if (next.params[key] == null) next.params[key] = {};
      for (const pk of Object.keys(sub)) {
        const def = desc.find((d: TunableParam) => d.key === pk);
        const min = def?.min ?? -Infinity;
        const parsed = parseNumberLike(sub[pk], min === -Infinity ? -Number.MAX_SAFE_INTEGER : min);
        if (parsed == null) return { error: `${key}.${pk} must be >= ${min}` };
        if (def?.max != null && parsed > def.max) return { error: `${key}.${pk} must be <= ${def.max}` };
        next.params[key][pk] = parsed;
      }
      // L1 cross-param constraints
      if (key === "l1") {
        const p = next.params.l1 ?? {};
        const defaults: Record<string, number> = {};
        for (const d of desc) defaults[d.key] = d.defaultValue;
        const entryDiff = p.entryDiff ?? defaults.entryDiff ?? 40;
        const cancelDiff = p.cancelDiff ?? defaults.cancelDiff ?? 30;
        const limitPrice = p.limitPrice ?? defaults.limitPrice ?? 0.5;
        const tpDelta = p.tpDelta ?? defaults.tpDelta ?? 0.15;
        const remMax = p.remMax ?? defaults.remMax ?? 300;
        const remMin = p.remMin ?? defaults.remMin ?? 10;
        if (cancelDiff >= entryDiff) return { error: `L1 cancel threshold (${cancelDiff}) must be less than entry threshold (${entryDiff})` };
        if (limitPrice + tpDelta > 0.99 + 1e-9) return { error: `L1 entry price + TP delta (${(limitPrice + tpDelta).toFixed(2)}) must be <= 0.99` };
        if (remMin >= remMax) return { error: `L1 entry time-remaining lower bound (${remMin}) must be less than upper bound (${remMax})` };
      }
    }
  }

  if ("slippage" in rawUpdate) {
    const parsed = parseNumberLike(rawUpdate.slippage, 0);
    if (parsed == null) return { error: "slippage must be >= 0" };
    next.slippage = parsed;
  }

  if ("autoClaimEnabled" in rawUpdate) {
    const parsed = parseBooleanLike(rawUpdate.autoClaimEnabled);
    if (parsed == null) return { error: "autoClaimEnabled must be a boolean" };
    next.autoClaimEnabled = parsed;
  }

  if ("maxRoundEntries" in rawUpdate) {
    const parsed = parseNumberLike(rawUpdate.maxRoundEntries, 1);
    if (parsed == null || !Number.isInteger(parsed)) return { error: "maxRoundEntries must be an integer >= 1" };
    next.maxRoundEntries = parsed;
  }

  if ("marketHoursOnly" in rawUpdate) {
    const parsed = parseBooleanLike(rawUpdate.marketHoursOnly);
    if (parsed == null) return { error: "marketHoursOnly must be a boolean" };
    next.marketHoursOnly = parsed;
  }

  if ("weekendPause" in rawUpdate) {
    const parsed = parseBooleanLike(rawUpdate.weekendPause);
    if (parsed == null) return { error: "weekendPause must be a boolean" };
    next.weekendPause = parsed;
  }

  return { config: next };
}

// strategyConfig is first initialized as an empty shell; the strategy loader fills it after (after initStrategies)
let strategyConfig: StrategyConfig = {
  enabled: {}, amount: {}, shares: {}, params: {},
  slippage: parseNumberEnv("ORDER_DEFAULT_SLIPPAGE", 0.06, 0),
  autoClaimEnabled: parseBooleanEnv("AUTO_CLAIM_ENABLED", true),
  maxRoundEntries: parseNumberEnv("MAX_ROUND_ENTRIES", 1, 1),
  marketHoursOnly: parseBooleanEnv("MARKET_HOURS_ONLY", false),
  weekendPause: parseBooleanEnv("WEEKEND_PAUSE", false),
};
function initStrategyConfig(): void {
  strategyConfig = createEnvStrategyConfig();
  loadPersistedStrategyConfig(strategyConfig);
}
const pendingTradeMeta = new Map<string, PendingTradeMeta>();

// -- Manual order config (amount / slippage / TP-SL) persisted to .manual-config.json --
const MANUAL_CONFIG_FILE = resolve(__dirname, ".manual-config.json");
interface ManualConfig {
  amount: number;          // USDC
  slippage: number;        // 0-0.99 (percentage / 100)
  cond: {
    tpEnabled: boolean;
    tpPct: number;         // 0-99 (percentage points)
    slEnabled: boolean;
    slMode: "price" | "diff"; // price=by fill-price percentage points / diff=by diff crossing threshold
    slPct: number;         // used when mode=price, 0-99 (percentage points)
    slDiff: number;        // used when mode=diff, positive number (e.g. 5 means: when buying up triggers at diff<=-5 / when buying down triggers at diff>=+5)
    slSlippage: number;    // 0-99
    collapsed: boolean;
  };
}
const MANUAL_DEFAULT: ManualConfig = {
  amount: 1,
  slippage: 0.06,
  cond: { tpEnabled: false, tpPct: 20, slEnabled: false, slMode: "price", slPct: 20, slDiff: 5, slSlippage: 15, collapsed: true },
};
let manualConfig: ManualConfig = structuredClone(MANUAL_DEFAULT);
function loadManualConfig(): void {
  if (!existsSync(MANUAL_CONFIG_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(MANUAL_CONFIG_FILE, "utf-8")) as Partial<ManualConfig>;
    if (typeof raw.amount === "number" && raw.amount >= 0) manualConfig.amount = raw.amount;
    if (typeof raw.slippage === "number" && raw.slippage >= 0 && raw.slippage <= 1) manualConfig.slippage = raw.slippage;
    if (raw.cond && typeof raw.cond === "object") {
      const c = raw.cond as Partial<ManualConfig["cond"]>;
      if (typeof c.tpEnabled === "boolean") manualConfig.cond.tpEnabled = c.tpEnabled;
      if (typeof c.tpPct === "number" && c.tpPct >= 0 && c.tpPct <= 99) manualConfig.cond.tpPct = c.tpPct;
      if (typeof c.slEnabled === "boolean") manualConfig.cond.slEnabled = c.slEnabled;
      if (c.slMode === "price" || c.slMode === "diff") manualConfig.cond.slMode = c.slMode;
      if (typeof c.slPct === "number" && c.slPct >= 0 && c.slPct <= 99) manualConfig.cond.slPct = c.slPct;
      if (typeof c.slDiff === "number" && c.slDiff >= -200 && c.slDiff <= 200) manualConfig.cond.slDiff = c.slDiff;
      if (typeof c.slSlippage === "number" && c.slSlippage >= 0 && c.slSlippage <= 99) manualConfig.cond.slSlippage = c.slSlippage;
      if (typeof c.collapsed === "boolean") manualConfig.cond.collapsed = c.collapsed;
    }
  } catch (err) {
    console.warn(`[Manual.Config] load failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
function saveManualConfig(): void {
  try {
    writeFileSync(MANUAL_CONFIG_FILE, JSON.stringify(manualConfig, null, 2));
  } catch (err) {
    console.warn(`[Manual.Config] save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
loadManualConfig();

function applyManualConfigUpdate(raw: unknown): string | null {
  if (!isRecord(raw)) return "invalid config format";
  const next = structuredClone(manualConfig);
  if ("amount" in raw) {
    const v = Number(raw.amount);
    if (!Number.isFinite(v) || v < 0) return "amount invalid";
    next.amount = v;
  }
  if ("slippage" in raw) {
    const v = Number(raw.slippage);
    if (!Number.isFinite(v) || v < 0 || v > 1) return "slippage must be within 0-1";
    next.slippage = v;
  }
  if ("cond" in raw && isRecord(raw.cond)) {
    const c = raw.cond;
    if ("tpEnabled" in c) next.cond.tpEnabled = !!c.tpEnabled;
    if ("tpPct" in c) { const v = Number(c.tpPct); if (Number.isFinite(v) && v >= 0 && v <= 99) next.cond.tpPct = v; }
    if ("slEnabled" in c) next.cond.slEnabled = !!c.slEnabled;
    if ("slMode" in c && (c.slMode === "price" || c.slMode === "diff")) next.cond.slMode = c.slMode;
    if ("slPct" in c) { const v = Number(c.slPct); if (Number.isFinite(v) && v >= 0 && v <= 99) next.cond.slPct = v; }
    if ("slDiff" in c) { const v = Number(c.slDiff); if (Number.isFinite(v) && v >= -200 && v <= 200) next.cond.slDiff = v; }
    if ("slSlippage" in c) { const v = Number(c.slSlippage); if (Number.isFinite(v) && v >= 0 && v <= 99) next.cond.slSlippage = v; }
    if ("collapsed" in c) next.cond.collapsed = !!c.collapsed;
  }
  manualConfig = next;
  saveManualConfig();
  return null;
}

// -- Polymarket real PnL manager -----------------------------------------
const pmPnlManager = new PmPnlManager(PROXY_ADDRESS);

/** after a fill lands, only record the strategy source (PnL stats rely on the full refresh every 5 minutes, no longer incremental sync) */
function notifyTradeForPnl(txHash: string | undefined, source: string | undefined): void {
  if (txHash && source) {
    pmPnlManager.recordStrategySource(txHash, source);
  }
}

// -- HTTP heartbeat status ---------------------------------------
// the two channels are timed independently, reflecting the real connection-reuse status of the order path:
// - undici: fetch() related (order book query / Gamma API / TG)
// - axios: clob-client place order / query and cancel open orders
const httpHeartbeat = {
  latencyMs: -1,       // undici (fetch) last heartbeat latency (-1 = not tested/failed)
  lastAt: 0,
  ok: false,
};
const axiosHeartbeat = {
  latencyMs: -1,       // axios (Node native https) last heartbeat latency
  lastAt: 0,
  ok: false,
};

function broadcastHttpHeartbeat(): void {
  broadcast("httpHeartbeat", {
    latencyMs: httpHeartbeat.latencyMs,
    lastAt: httpHeartbeat.lastAt,
    ok: httpHeartbeat.ok,
  });
}

function broadcastAxiosHeartbeat(): void {
  broadcast("axiosHeartbeat", {
    latencyMs: axiosHeartbeat.latencyMs,
    lastAt: axiosHeartbeat.lastAt,
    ok: axiosHeartbeat.ok,
  });
}

function sendHttpHeartbeatToClient(ws: WebSocket): void {
  send(ws, "httpHeartbeat", {
    latencyMs: httpHeartbeat.latencyMs,
    lastAt: httpHeartbeat.lastAt,
    ok: httpHeartbeat.ok,
  });
  send(ws, "axiosHeartbeat", {
    latencyMs: axiosHeartbeat.latencyMs,
    lastAt: axiosHeartbeat.lastAt,
    ok: axiosHeartbeat.ok,
  });
}

// -- Order latency monitoring -----------------------------------------
// the only metric: the moment this machine initiates postOrder -> the moment UserWS receives the MATCHED event for that order
// reflects the real elapsed time from order to match receipt (network uplink + match decision + WS downlink)
//
// difficulty: WS MATCHED sometimes arrives before the HTTP response (WS is faster than HTTP), at which point the orderID is not yet known
// solution: bidirectional cache. Whichever of HTTP and WS arrives first is recorded first, when the other arrives later it is matched and settled
const ORDER_LATENCY_HISTORY_MAX = 10;
const ORDER_LATENCY_TIMEOUT_MS = 15000;

interface PendingByOrderId {
  t0: number;           // moment postOrder was initiated
  timeoutTimer: ReturnType<typeof setTimeout>;
}
interface EarlyWsEntry {
  orderId: string;
  tWs: number;          // moment WS MATCHED arrived
}
interface LatencySample {
  ts: number;           // moment of completion
  latencyMs: number;    // order -> WS MATCHED total elapsed time; -1 = timeout
}

// in-flight timings with known orderID (registered after postOrder returns)
const pendingByOrderId = new Map<string, PendingByOrderId>();
// WS events that arrived before the HTTP response (cached, looked up by orderID after HTTP returns)
const earlyWsCache = new Map<string, EarlyWsEntry>();

const latencyHistory: LatencySample[] = [];
const orderLatencyStatus = {
  lastMs: -1,           // last latency; -1 = not tested
  lastAt: 0,
  timeouts: 0,          // cumulative WS timeouts
  wsDisconnects: 0,
};

function pushLatencySample(sample: LatencySample): void {
  latencyHistory.unshift(sample);
  if (latencyHistory.length > ORDER_LATENCY_HISTORY_MAX) latencyHistory.length = ORDER_LATENCY_HISTORY_MAX;
}

function computeAvg(): number {
  const valid = latencyHistory.filter(s => s.latencyMs >= 0);
  if (!valid.length) return -1;
  return Math.round(valid.reduce((a, b) => a + b.latencyMs, 0) / valid.length);
}

function buildOrderLatencyPayload(): Record<string, unknown> {
  return {
    lastMs: orderLatencyStatus.lastMs,
    lastAt: orderLatencyStatus.lastAt,
    avgMs: computeAvg(),
    timeouts: orderLatencyStatus.timeouts,
    wsDisconnects: orderLatencyStatus.wsDisconnects,
    history: latencyHistory.slice(0, ORDER_LATENCY_HISTORY_MAX),
  };
}

function broadcastOrderLatency(): void {
  broadcast("orderLatency", buildOrderLatencyPayload());
}

function sendOrderLatencyToClient(ws: WebSocket): void {
  send(ws, "orderLatency", buildOrderLatencyPayload());
}

function recordLatencySuccess(latencyMs: number, orderId: string): void {
  orderLatencyStatus.lastMs = latencyMs;
  orderLatencyStatus.lastAt = Date.now();
  pushLatencySample({ ts: Date.now(), latencyMs });
  console.log(`[Trade.Latency] order latency ${latencyMs}ms orderID:${fmtOid(orderId)}`);
  broadcastOrderLatency();
}

/**
 * called after postOrder returns; registers orderID and checks earlyWsCache
 * if WS already arrived -> settle immediately; otherwise start a 15s timeout waiting for WS
 */
function registerOrderLatencyStart(orderId: string, t0: number): void {
  if (!orderId) return;
  // WS already arrived? settle directly
  const early = earlyWsCache.get(orderId);
  if (early) {
    earlyWsCache.delete(orderId);
    recordLatencySuccess(early.tWs - t0, orderId);
    return;
  }
  // set timeout
  const timeoutTimer = setTimeout(() => {
    if (!pendingByOrderId.has(orderId)) return;
    pendingByOrderId.delete(orderId);
    orderLatencyStatus.timeouts++;
    orderLatencyStatus.lastMs = -1;
    orderLatencyStatus.lastAt = Date.now();
    pushLatencySample({ ts: Date.now(), latencyMs: -1 });
    console.warn(`[Trade.Latency] orderID=${fmtOid(orderId)} WS MATCHED timeout (>${ORDER_LATENCY_TIMEOUT_MS}ms)`);
    broadcastOrderLatency();
  }, ORDER_LATENCY_TIMEOUT_MS);
  pendingByOrderId.set(orderId, { t0, timeoutTimer });
}

/**
 * called when UserWS receives a MATCHED event
 * if HTTP already returned and registered -> settle; otherwise cache in earlyWsCache waiting for HTTP return
 */
function onWsMatched(orderId: string | undefined): void {
  if (!orderId) return;
  const pending = pendingByOrderId.get(orderId);
  if (pending) {
    clearTimeout(pending.timeoutTimer);
    pendingByOrderId.delete(orderId);
    recordLatencySuccess(Date.now() - pending.t0, orderId);
    return;
  }
  // WS arrived before HTTP, cache it (EarlyWsCache also set to expire in 15s)
  earlyWsCache.set(orderId, { orderId, tWs: Date.now() });
  setTimeout(() => earlyWsCache.delete(orderId), ORDER_LATENCY_TIMEOUT_MS);
}

function invalidatePendingLatencyOnWsDisconnect(): void {
  const total = pendingByOrderId.size + earlyWsCache.size;
  if (!total) return;
  for (const p of pendingByOrderId.values()) clearTimeout(p.timeoutTimer);
  pendingByOrderId.clear();
  earlyWsCache.clear();
  orderLatencyStatus.wsDisconnects += total;
  console.warn(`[Trade.Latency] UserWS disconnected, discarding ${total} in-flight timings`);
  broadcastOrderLatency();
}

// -- Conditional orders (TP GTC limit resting order + SL local monitoring) --------------
// all state lives in memory; lost on service restart - GTC resting orders stay on Polymarket's side,
// after restart the frontend list will be empty (invisible), but it does not affect the fill of the real resting orders.
// on window switch all GTC are automatically cancelled and the SL list is cleared.
type CondKind = "tp" | "sl" | "sl-diff";
type CondStatus = "open" | "filled" | "canceled" | "triggered" | "failed";

interface ConditionOrder {
  id: string;                   // internal ID (uuid-ish)
  groupId: string;              // shared by the TP+SL produced by the same buy; used to clean up the same group when one triggers
  kind: CondKind;               // tp=TP limit resting order  sl=SL local monitoring
  direction: StrategyDirection; // position direction
  assetId: string;              // the asset of this position
  windowStart: number;          // the window it belongs to
  createdAt: number;
  size: number;                 // original shares
  remainingSize: number;        // match-layer unfilled shares (decremented by MATCHED push; display only, not used for fill decision)
  chainFilledSize?: number;     // on-chain confirmed filled shares (accumulated by MINED push; only counts as a real fill when it reaches zero)
  entryPrice: number;           // buy fill price (the baseline relative to delta)
  triggerPrice: number;         // trigger price (TP=resting price; SL=the probability that triggers closing)
  slippage?: number;            // SL only
  status: CondStatus;
  // TP only: the real Polymarket orderID (filled after resting order succeeds)
  polymarketOrderId?: string;
  pendingGtc?: boolean;         // GTC resting order request in progress, local trigger forbidden during tick
  failReason?: string;
}

const activeConditionOrders = new Map<string, ConditionOrder>();

function makeCondId(): string {
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function clampPrice(p: number): number {
  return Math.min(0.99, Math.max(0.01, p));
}

function serializeConditionOrders(): ConditionOrder[] {
  return [...activeConditionOrders.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function broadcastConditionOrders(): void {
  broadcast("conditionOrders", { list: serializeConditionOrders() });
}

function sendConditionOrdersToClient(ws: WebSocket): void {
  send(ws, "conditionOrders", { list: serializeConditionOrders() });
}

/**
 * place a GTC limit sell order on Polymarket as take-profit
 * returns: { orderID } on success | { error: string } on failure (passes through the Polymarket error message directly)
 */
async function placeTakeProfitOrder(
  assetId: string,
  sellSize: number,
  targetPrice: number,
): Promise<{ orderID?: string; error?: string }> {
  if (!clobClient) return { error: "Clob not initialized" };
  try {
    const tickSize = getCachedTickSize(assetId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedSize = floorToDecimals(sellSize, 2);
    const normalizedPrice = floorToDecimals(targetPrice, priceDecimals);
    if (normalizedSize <= 0 || normalizedPrice <= 0 || normalizedPrice >= 1) {
      return { error: `invalid params size=${normalizedSize} price=${normalizedPrice}` };
    }
    const tpArgs = { tokenID: assetId, side: Side.SELL, price: normalizedPrice, size: normalizedSize };
    const tpOpts = { tickSize, negRisk: false };
    console.log("[RAW]", `[Cond.TP] createOrder args:`, JSON.stringify(tpArgs), "opts:", JSON.stringify(tpOpts), "ctx:", JSON.stringify({ assetId, sellSize, targetPrice, normalizedSize, normalizedPrice, tickSize, priceDecimals }));
    const signed = await clobClient.createOrder(tpArgs, tpOpts);
    console.log("[RAW]", `[Cond.TP] signedOrder:`, JSON.stringify(signed));
    const tpT0 = Date.now();
    const result = await clobClient.postOrder(signed, OrderType.GTC);
    const tpHttpMs = Date.now() - tpT0;
    console.log("[RAW]", `[Cond.TP] postOrder GTC raw result:`, JSON.stringify(result), `HTTP:${tpHttpMs}ms`);
    const orderID = typeof result?.orderID === "string" ? result.orderID : "";
    if (!orderID) {
      const errMsg = typeof result?.error === "string" ? result.error : "response has no orderID";
      return { error: errMsg };
    }
    console.log(`[Cond.TP] ➕ resting order sell ${normalizedSize}@${normalizedPrice} orderID=${fmtOid(orderID)}`);
    registerOrderConfirm(orderID, "cond-tp", { side: "sell", size: normalizedSize, price: normalizedPrice });
    return { orderID };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * cancel an already-placed take-profit GTC order
 */
async function cancelTakeProfitOrder(polymarketOrderId: string): Promise<boolean> {
  if (!clobClient || !polymarketOrderId) return false;
  registerCancelConfirm(polymarketOrderId, "cond-tp");
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    console.log("[RAW]", `[Cond.TP] cancelOrder args:`, JSON.stringify({ orderID: polymarketOrderId }), `attempt:${attempt}/2`);
    try {
      const result = await clobClient.cancelOrder({ orderID: polymarketOrderId });
      const dt = Date.now() - t0;
      console.log("[RAW]", `[Cond.TP] cancelOrder raw result:`, JSON.stringify(result), `HTTP:${dt}ms attempt:${attempt}`);
      const canceledList = Array.isArray((result as any)?.canceled) ? (result as any).canceled as string[] : [];
      const notCanceled = (result as any)?.not_canceled;
      const ncReason = notCanceled && typeof notCanceled === "object" ? String((notCanceled as Record<string, unknown>)[polymarketOrderId] ?? "") : "";
      if (canceledList.includes(polymarketOrderId)) {
        console.log(`[Cond.TP] cancel resting order orderID=${fmtOid(polymarketOrderId)}${attempt > 1 ? ` (retry succeeded)` : ""}`);
        return true;
      }
      if (ncReason) {
        if (/filled|matched|not.?found|does not exist|already/i.test(ncReason)) {
          console.log(`[Cond.TP] orderID=${fmtOid(polymarketOrderId)} not_canceled treated as handled: ${ncReason}`);
          resolveCancelConfirm(polymarketOrderId, "HTTP not_canceled soft success");
          return true;
        }
        console.warn(`[Cond.TP] not_canceled retry (attempt ${attempt}/2): ${ncReason}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dt = Date.now() - t0;
      console.log("[RAW]", `[Cond.TP] cancelOrder threw attempt:${attempt} HTTP:${dt}ms err:`, msg);
      if (/not found|does not exist|already/i.test(msg)) {
        console.log(`[Cond.TP] cancel orderID=${fmtOid(polymarketOrderId)} order no longer exists, treated as handled`);
        resolveCancelConfirm(polymarketOrderId, "HTTP threw not found");
        return true;
      }
      console.warn(`[Cond.TP] cancel failed (attempt ${attempt}/2):`, msg);
    }
    if (attempt < 2) await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/** clean up all active conditional orders for the given direction (called after a sell fills) */
async function clearConditionOrdersForDirection(
  assetId: string,
  direction: StrategyDirection,
  reason: string,
): Promise<void> {
  const toClean: ConditionOrder[] = [];
  for (const cond of activeConditionOrders.values()) {
    if (cond.direction !== direction) continue;
    if (cond.assetId !== assetId) continue;  // do not clean same-direction in a different window (different assetId)
    toClean.push(cond);
  }
  for (const cond of toClean) {
    if (cond.kind === "tp" && cond.polymarketOrderId) {
      // asynchronously cancel the Polymarket GTC, non-blocking
      void cancelTakeProfitOrder(cond.polymarketOrderId);
    }
    activeConditionOrders.delete(cond.id);
    console.log(`[Cond] cleaned up ${cond.kind === "tp" ? "TP" : "SL"} ${direction} (${reason})`);
  }
  broadcastConditionOrders();
}

/** clean up the other conditional orders in the same group (the TP+SL from one buy share a groupId).
 *  when TP triggers, use excludeId=the triggered TP, to avoid cancelling itself (a filled one cannot be cancelled). */
async function clearConditionOrdersByGroup(
  groupId: string,
  excludeId: string | null,
  reason: string,
): Promise<void> {
  if (!groupId) {
    broadcastConditionOrders();
    return;
  }
  const toClean: ConditionOrder[] = [];
  for (const cond of activeConditionOrders.values()) {
    if (cond.groupId !== groupId) continue;
    if (excludeId && cond.id === excludeId) continue;
    toClean.push(cond);
  }
  for (const cond of toClean) {
    if (cond.kind === "tp" && cond.polymarketOrderId) {
      void cancelTakeProfitOrder(cond.polymarketOrderId);
    }
    activeConditionOrders.delete(cond.id);
    console.log(`[Cond] cleaned up same group ${cond.kind === "tp" ? "TP" : "SL"} ${cond.direction} (${reason})`);
  }
  broadcastConditionOrders();
}

/** after buy MINED, create conditional orders (TP GTC + SL local record) */
async function createConditionOrdersAfterFill(opts: {
  direction: StrategyDirection;
  assetId: string;
  entryPrice: number;
  filledSize: number;
  windowStart: number;
  stopProfit?: { pctDelta?: number; targetPrice?: number };
  stopLoss?: { pctDelta?: number; diffValue?: number; slippage?: number };
}): Promise<void> {
  const { direction, assetId, entryPrice, filledSize, windowStart, stopProfit, stopLoss } = opts;
  if (!stopProfit && !stopLoss) return;

  // shared slippage for market orders (SL + fallback): prefer the SL setting, otherwise default 15%
  const marketSlippage = stopLoss?.slippage ?? 0.15;
  // the TP+SL produced by the same buy share one groupId; when either triggers only the same group is cleaned up
  const groupId = makeCondId();

  // TP GTC: supports two modes - pctDelta (relative to entry price) / targetPrice (absolute price 0~1)
  const tpTargetPrice = stopProfit
    ? (stopProfit.targetPrice != null && stopProfit.targetPrice > 0
        ? clampPrice(stopProfit.targetPrice)
        : (stopProfit.pctDelta != null && stopProfit.pctDelta > 0
            ? clampPrice(entryPrice + stopProfit.pctDelta)
            : null))
    : null;
  if (tpTargetPrice != null) {
    const targetPrice = tpTargetPrice;
    const cond: ConditionOrder = {
      id: makeCondId(),
      groupId,
      kind: "tp",
      direction,
      assetId,
      windowStart,
      createdAt: Date.now(),
      size: filledSize,
      remainingSize: filledSize,
      entryPrice,
      triggerPrice: targetPrice,
      status: "open",
    };
    activeConditionOrders.set(cond.id, cond);
    broadcastConditionOrders();
    // GTC minimum size is 5 shares; if insufficient, go straight to local monitoring
    const gtcSize = floorToDecimals(filledSize, 2);
    if (gtcSize < 5) {
      console.log(`[Cond.TP] size ${gtcSize} < 5 (GTC minimum), skip limit and go straight to local monitoring`);
      cond.failReason = `size below 5 shares -> local monitoring`;
      broadcastConditionOrders();
    } else {
    // async resting order: first mark pendingGtc, to prevent tick from falsely triggering local market TP during resting
    cond.pendingGtc = true;
    void (async () => {
      const r = await placeTakeProfitOrder(assetId, filledSize, targetPrice);
      const latest = activeConditionOrders.get(cond.id);
      if (!latest) return;  // already cancelled
      latest.pendingGtc = false;
      if (r.orderID) {
        latest.polymarketOrderId = r.orderID;
        // write pendingTradeMeta: used for MINED side=sell reverse lookup of source=cond-tp, tracking the real on-chain fill
        rememberPendingTradeMeta({
          orderId: r.orderID,
          ts: Date.now(),
          windowStart: latest.windowStart,
          side: "sell",
          direction: latest.direction,
          amount: filledSize,
          worstPrice: targetPrice,
          source: "cond-tp",
        });
        // placeTakeProfitOrder already logged "➕ resting order sell" internally, do not repeat here
        broadcastConditionOrders();
      } else {
        // GTC resting order failed -> downgrade to local-monitoring market TP
        console.warn(`[Cond.TP] TP resting order failed, downgrading to local monitoring (size=${filledSize} price=${targetPrice}): ${r.error}`);
        latest.failReason = `limit failed -> local monitoring: ${r.error || "resting order failed"}`;
        broadcastConditionOrders();
      }
    })();
    }  // end else (size >= 5)
  }

  // SL (local monitoring)
  // the two modes are mutually exclusive:
  //   - price mode: by fill-price percentage points (pctDelta), monitor odds dropping below entryPrice - pctDelta to trigger
  //   - diff mode: by diff crossing (diffValue positive X), when buying up trigger at diff <= -X, when buying down trigger at diff >= +X
  if (stopLoss) {
    if (typeof stopLoss.pctDelta === "number" && stopLoss.pctDelta > 0) {
      const triggerPrice = clampPrice(entryPrice - stopLoss.pctDelta);
      const cond: ConditionOrder = {
        id: makeCondId(),
        groupId,
        kind: "sl",
        direction, assetId, windowStart,
        createdAt: Date.now(),
        size: filledSize, remainingSize: filledSize,
        entryPrice, triggerPrice,
        slippage: marketSlippage,
        status: "open",
      };
      activeConditionOrders.set(cond.id, cond);
      broadcastConditionOrders();
    } else if (typeof stopLoss.diffValue === "number" && Number.isFinite(stopLoss.diffValue)) {
      // diffValue is the absolute threshold entered by the user (can be positive or negative)
      // buying up: trigger at diff <= triggerPrice; buying down: trigger at diff >= -triggerPrice (symmetric)
      const cond: ConditionOrder = {
        id: makeCondId(),
        groupId,
        kind: "sl-diff",
        direction, assetId, windowStart,
        createdAt: Date.now(),
        size: filledSize, remainingSize: filledSize,
        entryPrice,
        triggerPrice: stopLoss.diffValue,
        slippage: marketSlippage,
        status: "open",
      };
      activeConditionOrders.set(cond.id, cond);
      broadcastConditionOrders();
    }
  }
}

// -- Conditional order tick monitoring --------------------------------------
// TP: when there is no polymarketOrderId (GTC failed, downgraded) monitor locally, trigger a market sell when the probability reaches the target price
// SL: always monitored locally, market sell when the probability drops below the trigger price
let condTriggerInFlight = false;  // prevent concurrent triggers

async function checkConditionOrdersTick(upPct: number, dnPct: number, diff: number | null): Promise<void> {
  if (condTriggerInFlight) return;
  const toTrigger: ConditionOrder[] = [];
  for (const cond of activeConditionOrders.values()) {
    if (cond.status !== "open") continue;
    // TP: only monitor downgraded TP orders (no GTC resting order and not in the middle of resting)
    if (cond.kind === "tp" && !cond.polymarketOrderId && !cond.pendingGtc) {
      const currentPct = (cond.direction === "up" ? upPct : dnPct) / 100;
      if (currentPct >= cond.triggerPrice) toTrigger.push(cond);
    }
    // SL: always monitored locally
    if (cond.kind === "sl") {
      const currentPct = (cond.direction === "up" ? upPct : dnPct) / 100;
      if (currentPct <= cond.triggerPrice) toTrigger.push(cond);
    }
    // SL-DIFF: based on the diff absolute threshold (triggerPrice stores the user-entered value, can be positive or negative)
    // buying up: trigger at diff <= triggerPrice
    // buying down: trigger at diff >= -triggerPrice (symmetric)
    if (cond.kind === "sl-diff" && diff != null) {
      const T = cond.triggerPrice;
      const triggered = cond.direction === "up" ? diff <= T : diff >= -T;
      if (triggered) toTrigger.push(cond);
    }
  }
  if (!toTrigger.length) return;

  condTriggerInFlight = true;
  try {
    for (const cond of toTrigger) {
      const latest = activeConditionOrders.get(cond.id);
      if (!latest || latest.status !== "open") continue;
      const kindZh = cond.kind === "tp" ? "TP" : "SL";
      const currentPct = (cond.direction === "up" ? upPct : dnPct) / 100;
      if (cond.kind === "sl-diff") {
        const T = cond.triggerPrice;
        const want = cond.direction === "up" ? `≤${T}` : `≥${-T}`;
      console.log(`[Cond.SL] SL triggered ${cond.direction} diff=${diff?.toFixed(1) ?? "?"} threshold ${want} size=${cond.size}`);
      } else {
      console.log(`[Cond.${cond.kind}] ${kindZh} triggered ${cond.direction} pct=${(currentPct * 100).toFixed(1)}% triggerPrice=${(cond.triggerPrice * 100).toFixed(1)}% size=${cond.size}`);
      }
      latest.status = "triggered";
      broadcastConditionOrders();
      // sell shares:
      //   sl-diff (crossing SL) -> fully clear all positions in that direction (reverse hard signal, leave nothing)
      //   tp / sl -> use this order's remainingSize (and take the min with actual position, to prevent overselling)
      const actualSize = getDirectionLocalSize(cond.direction);
      let sellSize: number;
      if (cond.kind === "sl-diff") {
        sellSize = actualSize;
        console.log(`[Cond.SL] fully clear ${cond.direction} position size=${actualSize.toFixed(4)}`);
      } else {
        sellSize = actualSize > 0.01 && actualSize < cond.remainingSize
          ? actualSize
          : cond.remainingSize;
        if (sellSize !== cond.remainingSize) {
          console.log(`[Cond.${cond.kind}] actual position ${actualSize.toFixed(4)} < remainingSize ${cond.remainingSize.toFixed(4)}, using actual position`);
        }
      }
      if (sellSize <= 0.01) {
        console.log(`[Cond.${cond.kind}] actual position ${actualSize.toFixed(4)} is empty, skip`);
        activeConditionOrders.delete(cond.id);
        broadcastConditionOrders();
        continue;
      }
      const result = await placeOrder({
        direction: cond.direction,
        side: "sell",
        amount: sellSize,
        slippage: cond.slippage ?? marketSlippageDefault(),
        source: `cond-${cond.kind}-trigger`,
        exitReason: cond.kind === "sl-diff"
          ? `crossing SL triggered diff${cond.direction === "up" ? "<=" : ">="}${cond.direction === "up" ? cond.triggerPrice : -cond.triggerPrice}`
          : `${kindZh} triggered target ${(cond.triggerPrice * 100).toFixed(1)}%`,
      });
      if (result.success) {
        console.log(`[Cond.${cond.kind}] ${kindZh} market sell succeeded size=${sellSize.toFixed(4)}`);
        activeConditionOrders.delete(cond.id);
        if (cond.kind === "sl-diff") {
          // crossing SL fully cleared all positions in that direction, other same-direction conditional orders (tp/sl) must also be cleared
          void clearConditionOrdersForDirection(cond.assetId, cond.direction, "crossing SL full clear");
        } else {
          // clean up the other side of the same group (when SL triggers clear TP, when downgraded TP triggers clear SL)
          void clearConditionOrdersByGroup(cond.groupId, cond.id, `${kindZh} triggered`);
        }
        // broadcast a "filled" notification to the frontend (same message type as TP GTC fill)
        broadcast("condFilled", { kind: cond.kind, direction: cond.direction, price: cond.triggerPrice });
      } else {
        latest.status = "failed";
        latest.failReason = `${kindZh} market sell failed: ${result.errorMessage}`;
        console.error(`[Cond.${cond.kind}] ${kindZh} market sell failed: ${result.errorMessage}`);
      }
      broadcastConditionOrders();
    }
  } finally {
    condTriggerInFlight = false;
  }
}

function marketSlippageDefault(): number {
  return 0.15;
}

// -- Telegram push ---------------------------------------
let tgConfig: TgConfig = loadTgConfig();
let tgPushTimer: ReturnType<typeof setInterval> | null = null;

/** returns the timestamp of midnight UTC+8 today (milliseconds) */
function getCstDayStartMs(now = Date.now()): number {
  const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
  const msSinceCstMidnight = (now + CST_OFFSET_MS) % (24 * 60 * 60 * 1000);
  return now - msSinceCstMidnight;
}

/** returns the UTC+8 date string, format YYYY-MM-DD */
function getCstDateStr(now = Date.now()): string {
  const CST_OFFSET_MS = 8 * 60 * 60 * 1000;
  return new Date(now + CST_OFFSET_MS).toISOString().slice(0, 10);
}

function buildTgMessage(): string {
  const now = new Date();
  const ts = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  // balance
  const usdcBalance = positions.usdc != null ? `$${positions.usdc.toFixed(2)}` : "—";
  // all history + today (uniformly via computeSnapshot, ensuring consistency with frontend panel/monitor page/TG)
  const today = pmPnlManager.getTotalPnl(0);  // grand total (all history, only used for summary info display)
  const todaySec = Math.floor(getCstDayStartMs() / 1000);
  const todaySnap = pmPnlManager.computeSnapshot(todaySec);
  const todayNet = todaySnap.netPnl;
  const todayCount = todaySnap.positions;
  const wins = todaySnap.wins;
  const winRate = todaySnap.closedPositions > 0
    ? `${(wins / todaySnap.closedPositions * 100).toFixed(1)}%`
    : "—";
  // strategy status
  const stratLines = ALL_STRATEGY_KEYS
    .map(k => `${k}${strategyConfig.enabled[k] ? "✅" : "❌"}`)
    .filter(s => s.endsWith("✅"))
    .join(" ") || "all off";
  // HTTP latency
  const httpStatus = httpHeartbeat.ok
    ? `${httpHeartbeat.latencyMs}ms ${httpHeartbeat.latencyMs < 500 ? "✅" : httpHeartbeat.latencyMs < 1000 ? "⚠️" : "❌"}`
    : "down";
  // last 5 (excluding buys: only settlement-type events, PnL is more meaningful)
  const recent = pmPnlManager.getEvents({ sinceDays: 7, limit: 20 })
    .filter(e => e.kind !== "BUY")
    .slice(0, 5);
  const recentLines = recent.map(e => {
    const t = new Date(e.ts * 1000).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false, hour: "2-digit", minute: "2-digit" });
    const kindZh = e.kind === "SELL" ? "sell" : e.kind === "REDEEM" ? "claim" : "zeroed";
    const outZh = e.outcome === "Up" ? "Up▲" : "Down▼";
    // source display: manual -> "manual"; strategyp3 -> "P3"; others keep original
    const src = !e.strategySource
      ? "—"
      : /^manual$/i.test(e.strategySource)
        ? "manual"
        : e.strategySource.replace(/^strategy/i, "").toUpperCase();
    const posPnl = e.positionPnl != null
      ? `${e.positionPnl >= 0 ? "+" : ""}$${e.positionPnl.toFixed(2)}`
      : "—";
    return `${t} ${kindZh} ${outZh} ${src} ${posPnl}`;
  }).join("\n");

  return [
    `📊 ${activeMarket.displayName}${accountName ? ` · 👤 ${accountName}` : ""} (${ts})`,
    `─────────────────`,
    `💰 Balance: ${usdcBalance} USDC`,
    `📈 Today: ${todayNet >= 0 ? "+" : ""}$${todayNet.toFixed(2)} (${todayCount} trades, win ${winRate})`,
    `💸 Fees: $${todaySnap.totalFee.toFixed(2)}`,
    `⚙️ Strategies: ${stratLines}`,
    `🌐 HTTP: ${httpStatus}`,
    ``,
    `━━━ Last 5 ━━━`,
    recentLines || "(none)",
  ].join("\n");
}

function startTgPushLoop(): void {
  if (tgPushTimer) {
    clearInterval(tgPushTimer);
    tgPushTimer = null;
  }
  if (!tgConfig.enabled || !tgConfig.scheduledEnabled || !tgConfig.botToken || !tgConfig.chatId) return;
  const intervalMs = Math.max(5, tgConfig.intervalMinutes) * 60 * 1000;
  console.log(`[Push] scheduled push started, every ${tgConfig.intervalMinutes} minutes`);
  tgPushTimer = setInterval(async () => {
    const text = buildTgMessage();
    const result = await sendTgMessage(tgConfig, text);
    if (result.ok) {
      console.log(`[Push] scheduled push succeeded`);
    } else {
      console.warn(`[Push] scheduled push failed: ${result.error}`);
    }
  }, intervalMs);
}

// -- Post-trade delayed push (10 minutes after the last buy MINED) ----------------
// single slot: each new buy cancels the previously queued push and restarts the timer.
// purpose: when placing multiple orders in a row, push one summary only at "the last order"+10 minutes.
const POST_TRADE_PUSH_DELAY_MS = 10 * 60 * 1000;
let postTradePushTimer: ReturnType<typeof setTimeout> | null = null;
let postTradePushCount = 0;  // cumulative order count this window (used for the push header display)
let postTradePushFirstTs = 0;

function schedulePostTradePush(meta: { direction: StrategyDirection; size: number; price: number; source: string }): void {
  if (!tgConfig.enabled || !tgConfig.postTradeEnabled || !tgConfig.botToken || !tgConfig.chatId) return;
  const dirZh = meta.direction === "up" ? "up" : "down";
  // cancel the previously queued push (if any), restart the timer
  const replaced = postTradePushTimer != null;
  if (postTradePushTimer) {
    clearTimeout(postTradePushTimer);
    postTradePushTimer = null;
  } else {
    postTradePushCount = 0;
    postTradePushFirstTs = Date.now();
  }
  postTradePushCount++;
  console.log(`[Push] post-trade push ${replaced ? "rescheduled" : "queued"} (in ${POST_TRADE_PUSH_DELAY_MS / 60000} minutes): ${meta.source} buy ${dirZh} ${meta.size}@${meta.price} (cumulative ${postTradePushCount} trades)`);
  const snapshotCount = postTradePushCount;
  const snapshotFirstTs = postTradePushFirstTs;
  postTradePushTimer = setTimeout(async () => {
    postTradePushTimer = null;
    const finalCount = postTradePushCount;
    postTradePushCount = 0;
    postTradePushFirstTs = 0;
    if (!tgConfig.enabled || !tgConfig.postTradeEnabled || !tgConfig.botToken || !tgConfig.chatId) return;
    const minsSinceFirst = Math.round((Date.now() - snapshotFirstTs) / 60000);
    const header = finalCount > 1
      ? `📌 Post-trade ${POST_TRADE_PUSH_DELAY_MS / 60000}-minute review (last ${meta.source} buy ${dirZh} ${meta.size}@${meta.price.toFixed(3)}, ${finalCount} trades total, span ${minsSinceFirst} minutes)\n\n`
      : `📌 Post-trade ${POST_TRADE_PUSH_DELAY_MS / 60000}-minute review (${meta.source} buy ${dirZh} ${meta.size}@${meta.price.toFixed(3)})\n\n`;
    const text = header + buildTgMessage();
    const result = await sendTgMessage(tgConfig, text);
    if (result.ok) {
      console.log(`[Push] post-trade push succeeded (${finalCount} trades, snapshot=${snapshotCount})`);
    } else {
      console.warn(`[Push] post-trade push failed: ${result.error}`);
    }
  }, POST_TRADE_PUSH_DELAY_MS);
}

function broadcastTgConfig(): void {
  // when sending config to the frontend, hide the second half of botToken (to avoid leakage via screenshots)
  const masked = tgConfig.botToken
    ? tgConfig.botToken.slice(0, 10) + "***" + tgConfig.botToken.slice(-4)
    : "";
  broadcast("tgConfig", {
    enabled: tgConfig.enabled,
    botToken: masked,
    botTokenSet: !!tgConfig.botToken,
    chatId: tgConfig.chatId,
    intervalMinutes: tgConfig.intervalMinutes,
    scheduledEnabled: tgConfig.scheduledEnabled,
    postTradeEnabled: tgConfig.postTradeEnabled,
  });
}

function sendTgConfigToClient(ws: WebSocket): void {
  const masked = tgConfig.botToken
    ? tgConfig.botToken.slice(0, 10) + "***" + tgConfig.botToken.slice(-4)
    : "";
  send(ws, "tgConfig", {
    enabled: tgConfig.enabled,
    botToken: masked,
    botTokenSet: !!tgConfig.botToken,
    chatId: tgConfig.chatId,
    intervalMinutes: tgConfig.intervalMinutes,
    scheduledEnabled: tgConfig.scheduledEnabled,
    postTradeEnabled: tgConfig.postTradeEnabled,
  });
}

// full refresh cadence: once every 5 minutes
const PMPNL_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
let pmPnlNextRefreshAt = 0;

function buildPmPnlPayload(): Record<string, unknown> {
  const events = pmPnlManager.getEvents();
  const total = pmPnlManager.getTotalPnl();
  // today's snapshot (CST cutoff) -- same convention as server.ts, monitor page, TG
  const todaySec = Math.floor(getCstDayStartMs() / 1000);
  const today = pmPnlManager.computeSnapshot(todaySec);
  return {
    events, total, today,
    initialized: pmPnlManager.isInitialized(),
    lastRefreshAt: pmPnlManager.getLastRefreshAt(),
    nextRefreshAt: pmPnlNextRefreshAt,
  };
}

function broadcastPmPnl(): void {
  broadcast("pmPnl", buildPmPnlPayload());
}

function sendPmPnlToClient(ws: WebSocket): void {
  send(ws, "pmPnl", buildPmPnlPayload());
}

function cleanupPendingTradeMeta(now = Date.now()): void {
  for (const [key, meta] of pendingTradeMeta) {
    if (now - meta.ts > PENDING_TRADE_META_MAX_AGE_MS) {
      pendingTradeMeta.delete(key);
    }
  }
}

function rememberPendingTradeMeta(meta: Omit<PendingTradeMeta, "key">): void {
  cleanupPendingTradeMeta(meta.ts);
  const key = meta.orderId || `pending-${meta.ts}-${Math.random().toString(36).slice(2, 8)}`;
  pendingTradeMeta.set(key, { key, ...meta });
}

/** called when a stratOrder is deleted, cleans up the corresponding pendingTradeMeta (fix A no longer "consume once", needs to be cleared at the end of the order lifecycle) */
function clearPendingTradeMetaByOrderId(orderId: string | undefined): void {
  if (orderId) pendingTradeMeta.delete(orderId);
}

function normalizeTradeSide(value: unknown): "buy" | "sell" | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "buy") return "buy";
  if (normalized === "sell") return "sell";
  return null;
}

function getDirectionByAssetId(assetId: string): StrategyDirection | null {
  if (assetId === state.upTokenId) return "up";
  if (assetId === state.downTokenId) return "down";
  return null;
}

// token_id -> symbol reverse lookup (used in logs to show which symbol's fill, also accurate across symbol switches)
const tokenSymbolMap = new Map<string, MarketSymbol>();
function rememberTokenSymbol(tokenId: string, sym: MarketSymbol): void {
  if (tokenId) tokenSymbolMap.set(tokenId, sym);
}
function getSymbolByAssetId(assetId: string): string {
  return tokenSymbolMap.get(assetId) || activeMarket.symbol;
}

function parseTradeEventTimestamp(evt: Record<string, unknown>): number {
  const raw = typeof evt.match_time === "string"
    ? evt.match_time
    : typeof evt.last_update === "string"
      ? evt.last_update
      : "";
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function consumePendingTradeMeta(evt: Record<string, unknown>): PendingTradeMeta | null {
  cleanupPendingTradeMeta();
  const candidateIds: string[] = [];
  if (typeof evt.taker_order_id === "string" && evt.taker_order_id) {
    candidateIds.push(evt.taker_order_id);
  }
  if (Array.isArray(evt.maker_orders)) {
    for (const makerOrder of evt.maker_orders) {
      if (!isRecord(makerOrder) || typeof makerOrder.order_id !== "string" || !makerOrder.order_id) continue;
      candidateIds.push(makerOrder.order_id);
    }
  }
  for (const id of candidateIds) {
    const meta = pendingTradeMeta.get(id);
    if (!meta) continue;
    pendingTradeMeta.delete(id);
    return meta;
  }

  const side = normalizeTradeSide(evt.side);
  const assetId = typeof evt.asset_id === "string" ? evt.asset_id : "";
  const size = typeof evt.size === "number" ? evt.size : Number(evt.size);
  if (!side || !assetId || !Number.isFinite(size)) return null;

  // fuzzy match: only consider it our order if the size diff is within 10% and the time diff is within 30 seconds
  const FUZZY_MAX_AGE_MS = 30_000;
  const FUZZY_MAX_SIZE_RATIO = 0.10;
  let bestKey: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;
  const now = Date.now();
  for (const [key, meta] of pendingTradeMeta) {
    const directionTokenId = meta.direction === "up" ? state.upTokenId : state.downTokenId;
    if (directionTokenId !== assetId || meta.side !== side) continue;
    const ageDiff = now - meta.ts;
    if (ageDiff > FUZZY_MAX_AGE_MS) continue;
    const sizeRatio = size > 0 ? Math.abs(meta.amount - size) / size : Math.abs(meta.amount - size);
    if (sizeRatio > FUZZY_MAX_SIZE_RATIO) continue;
    const score = sizeRatio * 1000 + ageDiff / 1000;
    if (score < bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }
  if (!bestKey) return null;
  const meta = pendingTradeMeta.get(bestKey) || null;
  if (meta) pendingTradeMeta.delete(bestKey);
  return meta;
}

// -- Polymarket authentication -----------------------------------------
const CREDS_FILE = resolve(__dirname, ".polymarket-creds.json");

interface PolymarketCreds {
  key: string; secret: string; passphrase: string; address: string;
  accountName?: string;
  walletType?: "safe" | "deposit";   // safe=old Gnosis Safe (POLY_GNOSIS_SAFE), deposit=new Deposit Wallet (POLY_1271)
  proxyAddress?: string;             // the PROXY_ADDRESS the creds were created for; re-detect if env changed
}

/** detect via EIP-1967 implementation slot whether PROXY is a new deposit wallet or an old Gnosis Safe
 *  old Safe: no EIP-1967 proxy structure -> slot all 0
 *  new Deposit: ERC-1967 proxy -> slot stores the implementation address
 *  on network failure / exception default to "deposit" (new wallet - PM's main direction going forward; misjudging an old wallet will immediately fail orders so it is detectable)
 */
async function detectWalletType(addr: string): Promise<"safe" | "deposit"> {
  if (!addr) return "deposit";
  const RPC_URLS = ["https://polygon.drpc.org", "https://polygon-bor-rpc.publicnode.com"];
  const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  for (const url of RPC_URLS) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getStorageAt", params: [addr, IMPL_SLOT, "latest"] }),
      });
      const j = await r.json() as any;
      if (j.error) throw new Error(j.error.message);
      const slot = String(j.result || "");
      const implIsZero = /^0x0+$/.test(slot);
      return implIsZero ? "safe" : "deposit";
    } catch {
      // try the next RPC
    }
  }
  console.warn("[System.Auth] wallet type detection: all RPCs failed, defaulting to deposit (new wallet)");
  return "deposit";
}

function adaptSigner(wallet: ethers.Wallet) {
  return {
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, unknown[]>,
      value: Record<string, unknown>
    ) => wallet.signTypedData(
      domain as ethers.TypedDataDomain,
      types as Record<string, ethers.TypedDataField[]>,
      value
    ),
    getAddress: () => Promise.resolve(wallet.address),
  };
}

function loadCreds(): PolymarketCreds | null {
  if (!existsSync(CREDS_FILE)) return null;
  try {
    const creds: PolymarketCreds = JSON.parse(readFileSync(CREDS_FILE, "utf-8"));
    if (creds.key && creds.secret && creds.passphrase) {
      if (creds.accountName) accountName = creds.accountName;
      return creds;
    }
  } catch { /* ignore */ }
  return null;
}

function saveAccountNameToCreds(name: string): void {
  if (!name || !existsSync(CREDS_FILE)) return;
  try {
    const creds = JSON.parse(readFileSync(CREDS_FILE, "utf-8")) as PolymarketCreds;
    if (creds.accountName === name) return;
    creds.accountName = name;
    writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  } catch { /* ignore */ }
}

function walletTypeToSigType(walletType: "safe" | "deposit" | undefined): SignatureType {
  if (!PROXY_ADDRESS) return SignatureType.EOA;
  if (walletType === "deposit") return SignatureType.POLY_1271;
  return SignatureType.POLY_GNOSIS_SAFE;  // safe or undefined (fallback to old logic)
}

/** decide which wallet type to use for this startup:
 *  1. creds has walletType and proxyAddress matches the current PROXY_ADDRESS -> use directly
 *  2. otherwise call on-chain RPC detection -> write into creds
 *  on failure default to "deposit" (new wallet, PM's main direction)
 */
async function resolveWalletType(saved: PolymarketCreds | null): Promise<"safe" | "deposit"> {
  if (!PROXY_ADDRESS) return "deposit";  // not actually used in practice (EOA mode)
  if (saved?.walletType && saved.proxyAddress?.toLowerCase() === PROXY_ADDRESS.toLowerCase()) {
    return saved.walletType;
  }
  console.log("[System.Auth] detecting wallet type...");
  const wt = await detectWalletType(PROXY_ADDRESS);
  console.log(`[System.Auth] PROXY=${PROXY_ADDRESS} type: ${wt === "deposit" ? "new deposit wallet (POLY_1271)" : "old Gnosis Safe (POLY_GNOSIS_SAFE)"}`);
  return wt;
}

function persistWalletType(saved: PolymarketCreds, walletType: "safe" | "deposit"): void {
  // persist the detected walletType + current PROXY_ADDRESS into creds, skip detection on next startup
  if (saved.walletType === walletType && saved.proxyAddress?.toLowerCase() === PROXY_ADDRESS.toLowerCase()) return;
  try {
    saved.walletType = walletType;
    saved.proxyAddress = PROXY_ADDRESS;
    writeFileSync(CREDS_FILE, JSON.stringify(saved, null, 2));
  } catch { /* ignore */ }
}

async function createClobClient(): Promise<ClobClient | null> {
  const funderAddress = PROXY_ADDRESS || undefined;
  const saved = loadCreds();

  if (saved) {
    // verify creds matches the current .env; on mismatch only log an error, do not auto re-derive (avoids infinite retries / mis-operation)
    if (PRIVATE_KEY) {
      const currentEoa = new ethers.Wallet(PRIVATE_KEY).address;
      if (saved.address && saved.address.toLowerCase() !== currentEoa.toLowerCase()) {
        console.error(
          `[System.Auth] ❌ detected .env PRIVATE_KEY does not match .polymarket-creds.json:\n` +
          `    creds.address: ${saved.address}\n` +
          `    .env EOA:      ${currentEoa}\n` +
          `    fix: delete .polymarket-creds.json then restart, it will auto re-derive`
        );
      }
    }
    if (saved.proxyAddress && PROXY_ADDRESS && saved.proxyAddress.toLowerCase() !== PROXY_ADDRESS.toLowerCase()) {
      console.error(
        `[System.Auth] ❌ detected .env PROXY_ADDRESS does not match .polymarket-creds.json:\n` +
        `    creds.proxyAddress: ${saved.proxyAddress}\n` +
        `    .env PROXY:         ${PROXY_ADDRESS}\n` +
        `    fix: delete .polymarket-creds.json then restart, it will auto re-derive`
      );
    }
    const walletType = await resolveWalletType(saved);
    const sigType = walletTypeToSigType(walletType);
    persistWalletType(saved, walletType);
    const creds = { key: saved.key, secret: saved.secret, passphrase: saved.passphrase };
    if (PRIVATE_KEY) {
      const signer = adaptSigner(new ethers.Wallet(PRIVATE_KEY)) as any;
      return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, creds, signatureType: sigType, funderAddress });
    }
    return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, creds, signatureType: sigType, funderAddress });
  }

  if (!PRIVATE_KEY) {
    console.warn("[System.Auth] POLYMARKET_PRIVATE_KEY not configured, ordering is unavailable");
    return null;
  }

  console.log("[System.Auth] first use, generating Polymarket API credentials from private key...");
  const walletType = await resolveWalletType(null);
  const sigType = walletTypeToSigType(walletType);
  const wallet = new ethers.Wallet(PRIVATE_KEY);
  const signer = adaptSigner(wallet) as any;
  const client = new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, signatureType: sigType, funderAddress });
  const creds = await client.deriveApiKey(0);
  writeFileSync(CREDS_FILE, JSON.stringify({
    key: creds.key, secret: creds.secret, passphrase: creds.passphrase,
    address: wallet.address,
    walletType,
    proxyAddress: PROXY_ADDRESS || undefined,
  }, null, 2));
  console.log("[System.Auth] credentials saved to .polymarket-creds.json");
  return new ClobClient({ host: CLOB_URL, chain: Chain.POLYGON, signer, creds, signatureType: sigType, funderAddress });
}

// -- HTTP server ---------------------------------------------------
const app = express();
app.use(express.json());
if (IS_FULL_MODE) {
  app.use(express.static(__dirname));
  app.get("/", (_req, res) => {
    res.sendFile(resolve(__dirname, "index.html"));
  });
} else {
  app.get("/", (_req, res) => {
    res.json({
      name: "btc5m-web",
      mode: APP_MODE,
      stateUrl: "/api/state",
    });
  });
}

const server = createServer(app);
const wss = IS_FULL_MODE ? new WebSocketServer({ server }) : null;
const clientSessions = new Map<WebSocket, ClientSession>();

// -- CLOB Client (for ordering) ----------------------------------------
let clobClient: ClobClient | null = null;

async function ensureClobClient(): Promise<boolean> {
  if (clobClient) return true;
  try { clobClient = await createClobClient(); return clobClient != null; }
  catch (err) { console.error("[System.CLOB] init failed:", err); return false; }
}

// -- Order book state ----------------------------------------------
const state = {
  windowStart: 0,
  windowEnd: 0,
  upTokenId: "",
  downTokenId: "",
  conditionId: "",
  slug: "",
  bids: new Map<string, string>(),
  asks: new Map<string, string>(),
  bestBid: "-",
  bestAsk: "-",
  lastPrice: "-",
  lastSide: "",
  updatedAt: 0,
  priceToBeat: null as number | null,
  currentPrice: null as number | null,
  binanceOffset: null as number | null,
  coinbaseOffset: null as number | null,
  // BTC amplitude percentage within a 30-second rolling window = (max - min) / min * 100
  // updated by binance aggTrade; strategies can read ctx.volPct for decisions like "pause entry on high volatility"
  volPct: null as number | null,
  priceHistory: [] as Array<{ t: number; price: number }>,
  binanceHistory: [] as Array<{ t: number; price: number }>,
  coinbaseHistory: [] as Array<{ t: number; price: number }>,
  kline1m: [] as Array<Kline>,
  kline5m: [] as Array<Kline>,
};

const strategyRuntime: StrategyRuntimeState = {
  state: "IDLE",
  activeStrategy: null,
  direction: null,
  buyAmount: 0,
  posBeforeBuy: 0,
  posBeforeSell: 0,
  waitVerifyAfterSell: false,
  cleanupAfterVerify: false,
  actionTs: 0,
  prevUpPct: null,
  buyLockUntil: 0,
  positionsReady: !PROXY_ADDRESS,
  roundEntryCount: 0,
};

// -- Position state ----------------------------------------------
const wsStatus = { market: false, chainlink: false, user: false, binance: false, coinbase: false };
function broadcastWsStatus() { broadcast("wsStatus", wsStatus as unknown as Record<string, unknown>); }
const positions = {
  usdc: null as number | null,
  usdcAllowanceStatus: "NotApproved" as "Approved" | "NotFullyApproved" | "NotApproved",
  usdcAllowanceMin: null as number | null,
  usdcAllowanceDetails: [] as Array<{ spender: string; amount: number | null }>,
  localSize: {} as Record<string, number>,
  apiSize: {} as Record<string, number>,
  apiVerified: {} as Record<string, boolean>,
  confirmedIds: new Set<string>(),
  confirmedIdOrder: [] as string[],
  lastTradeAt: null as number | null,
  lastApiSyncAt: null as number | null,
};

// -- Broadcast --------------------------------------------------
function send(ws: WebSocket, type: string, data: Record<string, unknown>): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...data }));
}

function createClientSession(dataMode: ClientDataMode): ClientSession {
  return {
    dataMode,
    lastStateSentAt: 0,
    stateTimer: null,
    stateDirty: false,
    stateIncludeHistory: false,
  };
}

function normalizeClientDataMode(value: unknown): ClientDataMode {
  return value === "low" ? "low" : "full";
}

function resolveClientDataModeFromUrl(urlValue: string | undefined): ClientDataMode {
  if (!urlValue) return "full";
  try {
    const url = new URL(urlValue, `http://localhost:${PORT}`);
    return normalizeClientDataMode(url.searchParams.get("dataMode"));
  } catch {
    return "full";
  }
}

function getClientSession(ws: WebSocket): ClientSession {
  let session = clientSessions.get(ws);
  if (!session) {
    session = createClientSession("full");
    clientSessions.set(ws, session);
  }
  return session;
}

function clearStateTimer(session: ClientSession): void {
  if (session.stateTimer) {
    clearTimeout(session.stateTimer);
    session.stateTimer = null;
  }
}

function getStateIntervalMs(session: ClientSession): number {
  return session.dataMode === "low" ? LOW_DATA_STATE_INTERVAL_MS : FULL_DATA_STATE_INTERVAL_MS;
}

function shouldSendRealtimeEvent(type: string, ws: WebSocket, session: ClientSession): boolean {
  if (session.dataMode === "low" && (type === "chainlinkPrice" || type === "binancePrice")) {
    return false;
  }
  if ((type === "chainlinkPrice" || type === "binancePrice") && ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
    return false;
  }
  return true;
}

function broadcast(type: string, data: Record<string, unknown>): void {
  if (!wss) return;
  const msg = JSON.stringify({ type, ...data });
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const session = getClientSession(client);
    if (!shouldSendRealtimeEvent(type, client, session)) continue;
    client.send(msg);
  }
}

function trimHistory<T extends { t: number }>(points: T[], cutoff: number, maxPoints: number): void {
  while (points.length > 0 && points[0].t < cutoff) points.shift();
  if (points.length > maxPoints) points.splice(0, points.length - maxPoints);
}

function rememberBounded(set: Set<string>, order: string[], key: string, maxSize: number): boolean {
  if (set.has(key)) return false;
  set.add(key);
  order.push(key);
  while (order.length > maxSize) {
    const oldest = order.shift();
    if (oldest !== undefined) set.delete(oldest);
  }
  return true;
}

function prunePositionCaches(activeTokenIds: string[]): void {
  const keep = new Set(activeTokenIds.filter(Boolean));
  for (const store of [positions.localSize, positions.apiSize, positions.apiVerified]) {
    for (const key of Object.keys(store)) {
      if (!keep.has(key)) delete store[key];
    }
  }
}

function getDirectionTokenId(direction: StrategyDirection | null): string {
  if (direction === "up") return state.upTokenId;
  if (direction === "down") return state.downTokenId;
  return "";
}

function getDirectionLocalSize(direction: StrategyDirection | null): number {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.localSize[tokenId] ?? 0) : 0;
}

function getDirectionApiSize(direction: StrategyDirection | null): number {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.apiSize[tokenId] ?? 0) : 0;
}

function isDirectionVerified(direction: StrategyDirection | null): boolean {
  const tokenId = getDirectionTokenId(direction);
  return tokenId ? (positions.apiVerified[tokenId] ?? false) : false;
}

function hasOpenPosition(): boolean {
  return getDirectionLocalSize("up") > 0.01 || getDirectionLocalSize("down") > 0.01;
}

function hasEnoughUsdcForBuy(amount: number): boolean {
  if (positions.usdc == null || !Number.isFinite(amount)) return true;
  return positions.usdc + 1e-6 >= amount;
}

function hasPendingStrategyBuyLock(now = Date.now()): boolean {
  return now < strategyRuntime.buyLockUntil;
}

function getSellableShares(direction: StrategyDirection | null): number {
  const localSize = getDirectionLocalSize(direction);
  if (localSize <= 0) return 0;
  if (isDirectionVerified(direction)) return localSize;
  return Math.max(0, localSize - UNVERIFIED_SELL_BUFFER);
}

function getLatestBinancePrice(): number | null {
  const point = state.binanceHistory[state.binanceHistory.length - 1];
  return point?.price ?? null;
}

// 30-second rolling amplitude = (max - min) / min * 100; null when points < 2 or time is less than 30s
const VOL_WINDOW_MS = 30_000;
function recomputeVolPct(now: number): void {
  const cutoff = now - VOL_WINDOW_MS;
  const pts = state.binanceHistory.filter(p => p.t >= cutoff);
  if (pts.length < 2) { state.volPct = null; return; }
  // also check whether the earliest point is really 30+ seconds ago (the window is insufficient in the early startup phase)
  const span = pts[pts.length - 1].t - pts[0].t;
  if (span < VOL_WINDOW_MS - 1000) { state.volPct = null; return; }
  let hi = -Infinity, lo = Infinity;
  for (const p of pts) { if (p.price > hi) hi = p.price; if (p.price < lo) lo = p.price; }
  if (lo <= 0) { state.volPct = null; return; }
  state.volPct = (hi - lo) / lo * 100;
}

function getProbabilitySnapshot(): { upPct: number; dnPct: number } | null {
  if (!isProbabilityReady()) return null;
  const bid = Number(state.bestBid);
  const ask = Number(state.bestAsk);
  if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
  const mid = (bid + ask) / 2;
  return {
    upPct: Math.round(mid * 100),
    dnPct: Math.round((1 - mid) * 100),
  };
}

function getStrategyDiff(): number | null {
  const latestBinancePrice = getLatestBinancePrice();
  if (latestBinancePrice == null || state.priceToBeat == null || state.binanceOffset == null) return null;
  return latestBinancePrice - (state.priceToBeat - state.binanceOffset);
}

function calcMedian(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function calcTrimmedMean(values: number[], trimRatio = 0.15): number | null {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const trim = sorted.length >= 8 ? Math.floor(sorted.length * trimRatio) : 0;
  const trimmed = trim > 0 ? sorted.slice(trim, sorted.length - trim) : sorted;
  if (!trimmed.length) return null;
  return trimmed.reduce((sum, value) => sum + value, 0) / trimmed.length;
}

function calculateBinanceOffset(allowLatestFallback = false): number | null {
  if (!state.binanceHistory.length || !state.priceHistory.length) {
    if (!allowLatestFallback) return null;
    const latestBinancePrice = getLatestBinancePrice();
    if (latestBinancePrice == null || state.currentPrice == null) return null;
    return state.currentPrice - latestBinancePrice;
  }

  const now = Date.now();
  const binanceRecent = state.binanceHistory.filter((point) => point.t >= now - BINANCE_ALIGN_WINDOW_MS);
  const chainlinkRecent = state.priceHistory.filter((point) => point.t >= now - BINANCE_ALIGN_WINDOW_MS);
  if (!binanceRecent.length || !chainlinkRecent.length) {
    if (!allowLatestFallback) return null;
    const latestBinancePrice = getLatestBinancePrice();
    if (latestBinancePrice == null || state.currentPrice == null) return null;
    return state.currentPrice - latestBinancePrice;
  }

  const binanceSpan = binanceRecent.length >= 2
    ? binanceRecent[binanceRecent.length - 1].t - binanceRecent[0].t
    : 0;
  const chainlinkSpan = chainlinkRecent.length >= 2
    ? chainlinkRecent[chainlinkRecent.length - 1].t - chainlinkRecent[0].t
    : 0;

  if (Math.min(binanceSpan, chainlinkSpan) < BINANCE_ALIGN_MIN_SPAN_MS) {
    if (!allowLatestFallback) return null;
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }

  const overlapStart = Math.max(binanceRecent[0].t, chainlinkRecent[0].t);
  const overlapEnd = Math.min(binanceRecent[binanceRecent.length - 1].t, chainlinkRecent[chainlinkRecent.length - 1].t);
  const diffs: number[] = [];

  if (overlapEnd - overlapStart >= BINANCE_ALIGN_BUCKET_MS * 2) {
    let binanceIdx = 0;
    let chainlinkIdx = 0;
    for (let bucketStart = overlapStart; bucketStart <= overlapEnd; bucketStart += BINANCE_ALIGN_BUCKET_MS) {
      const bucketEnd = bucketStart + BINANCE_ALIGN_BUCKET_MS;
      const binanceBucket: number[] = [];
      const chainlinkBucket: number[] = [];

      while (binanceIdx < binanceRecent.length && binanceRecent[binanceIdx].t < bucketStart) binanceIdx++;
      while (chainlinkIdx < chainlinkRecent.length && chainlinkRecent[chainlinkIdx].t < bucketStart) chainlinkIdx++;

      let i = binanceIdx;
      while (i < binanceRecent.length && binanceRecent[i].t < bucketEnd) {
        binanceBucket.push(binanceRecent[i].price);
        i++;
      }
      let j = chainlinkIdx;
      while (j < chainlinkRecent.length && chainlinkRecent[j].t < bucketEnd) {
        chainlinkBucket.push(chainlinkRecent[j].price);
        j++;
      }

      const binanceMedian = calcMedian(binanceBucket);
      const chainlinkMedian = calcMedian(chainlinkBucket);
      if (binanceMedian != null && chainlinkMedian != null) {
        diffs.push(chainlinkMedian - binanceMedian);
      }
    }
  }

  if (!diffs.length) {
    return chainlinkRecent[chainlinkRecent.length - 1].price - binanceRecent[binanceRecent.length - 1].price;
  }
  if (diffs.length < 5) {
    return calcTrimmedMean(diffs, 0);
  }

  const median = calcMedian(diffs);
  if (median == null) return null;
  const absDeviations = diffs.map((diff) => Math.abs(diff - median));
  const mad = calcMedian(absDeviations) ?? 0;
  const threshold = Math.max(10, mad * 3);
  const filtered = diffs.filter((diff) => Math.abs(diff - median) <= threshold);
  const stable = filtered.length >= 3 ? filtered : diffs;
  return calcTrimmedMean(stable, 0.15);
}

function refreshBinanceOffset(reason: string, options: { allowLatestFallback?: boolean; forceLog?: boolean } = {}): boolean {
  const nextOffset = calculateBinanceOffset(options.allowLatestFallback ?? false);
  if (nextOffset == null) return false;

  const prevOffset = state.binanceOffset;
  const changed = prevOffset == null || Math.abs(prevOffset - nextOffset) > BINANCE_OFFSET_EPSILON;
  state.binanceOffset = nextOffset;

  if (!changed) return true;

  if (options.forceLog || prevOffset == null) {
    const prefix = prevOffset == null ? "init offset" : `${reason} update`;
    console.log(`[Price.BinanceOffset] ${prefix} ${nextOffset >= 0 ? "+" : ""}${nextOffset.toFixed(2)}`);
  }

  broadcastState();
  return true;
}

function maybeInitializeBinanceOffset(): void {
  if (state.binanceOffset != null) return;
  void refreshBinanceOffset("init", { allowLatestFallback: true, forceLog: true });
}

// -- Generic offset computation (other BTC/USD price sources like Coinbase aligned to Chainlink) --
function calcOffsetVsChainlink(
  history: Array<{ t: number; price: number }>,
  allowLatestFallback: boolean,
): number | null {
  if (!history.length || !state.priceHistory.length) {
    if (!allowLatestFallback) return null;
    const latest = history[history.length - 1]?.price ?? null;
    if (latest == null || state.currentPrice == null) return null;
    return state.currentPrice - latest;
  }

  const now = Date.now();
  const recent = history.filter((p) => p.t >= now - BINANCE_ALIGN_WINDOW_MS);
  const chainlinkRecent = state.priceHistory.filter((p) => p.t >= now - BINANCE_ALIGN_WINDOW_MS);
  if (!recent.length || !chainlinkRecent.length) {
    if (!allowLatestFallback) return null;
    const latest = history[history.length - 1]?.price ?? null;
    if (latest == null || state.currentPrice == null) return null;
    return state.currentPrice - latest;
  }

  const span = recent.length >= 2 ? recent[recent.length - 1].t - recent[0].t : 0;
  const chSpan = chainlinkRecent.length >= 2
    ? chainlinkRecent[chainlinkRecent.length - 1].t - chainlinkRecent[0].t
    : 0;
  if (Math.min(span, chSpan) < BINANCE_ALIGN_MIN_SPAN_MS) {
    if (!allowLatestFallback) return null;
    return chainlinkRecent[chainlinkRecent.length - 1].price - recent[recent.length - 1].price;
  }

  const overlapStart = Math.max(recent[0].t, chainlinkRecent[0].t);
  const overlapEnd = Math.min(recent[recent.length - 1].t, chainlinkRecent[chainlinkRecent.length - 1].t);
  const diffs: number[] = [];

  if (overlapEnd - overlapStart >= BINANCE_ALIGN_BUCKET_MS * 2) {
    let aIdx = 0;
    let cIdx = 0;
    for (let bs = overlapStart; bs <= overlapEnd; bs += BINANCE_ALIGN_BUCKET_MS) {
      const be = bs + BINANCE_ALIGN_BUCKET_MS;
      const aBuck: number[] = [];
      const cBuck: number[] = [];
      while (aIdx < recent.length && recent[aIdx].t < bs) aIdx++;
      while (cIdx < chainlinkRecent.length && chainlinkRecent[cIdx].t < bs) cIdx++;
      let i = aIdx;
      while (i < recent.length && recent[i].t < be) { aBuck.push(recent[i].price); i++; }
      let j = cIdx;
      while (j < chainlinkRecent.length && chainlinkRecent[j].t < be) { cBuck.push(chainlinkRecent[j].price); j++; }
      const aMed = calcMedian(aBuck);
      const cMed = calcMedian(cBuck);
      if (aMed != null && cMed != null) diffs.push(cMed - aMed);
    }
  }

  if (!diffs.length) {
    return chainlinkRecent[chainlinkRecent.length - 1].price - recent[recent.length - 1].price;
  }
  if (diffs.length < 5) return calcTrimmedMean(diffs, 0);
  const median = calcMedian(diffs);
  if (median == null) return null;
  const absDev = diffs.map((d) => Math.abs(d - median));
  const mad = calcMedian(absDev) ?? 0;
  const threshold = Math.max(10, mad * 3);
  const filtered = diffs.filter((d) => Math.abs(d - median) <= threshold);
  const stable = filtered.length >= 3 ? filtered : diffs;
  return calcTrimmedMean(stable, 0.15);
}

interface OffsetSpec {
  name: string;
  history: () => Array<{ t: number; price: number }>;
  getOffset: () => number | null;
  setOffset: (v: number | null) => void;
}
const COINBASE_SPEC: OffsetSpec = {
  name: "CoinbaseOffset",
  history: () => state.coinbaseHistory,
  getOffset: () => state.coinbaseOffset,
  setOffset: (v) => { state.coinbaseOffset = v; },
};
function refreshGenericOffset(spec: OffsetSpec, reason: string, options: { allowLatestFallback?: boolean; forceLog?: boolean } = {}): boolean {
  const next = calcOffsetVsChainlink(spec.history(), options.allowLatestFallback ?? false);
  if (next == null) return false;
  const prev = spec.getOffset();
  const changed = prev == null || Math.abs(prev - next) > BINANCE_OFFSET_EPSILON;
  spec.setOffset(next);
  if (!changed) return true;
  // the "init offset" on window switch is printed by the [System.Window] summary line; here only print on large changes or explicit forceLog
  if (options.forceLog) {
    const prefix = prev == null ? "init" : `${reason} update`;
    console.log(`[${spec.name}] ${prefix} ${next >= 0 ? "+" : ""}${next.toFixed(2)}`);
  }
  broadcastState();
  return true;
}

function maybeInitOffset(spec: OffsetSpec): void {
  if (spec.getOffset() != null) return;
  void refreshGenericOffset(spec, "init", { allowLatestFallback: true, forceLog: true });
}

function resetStrategyRuntime(reason?: string): void {
  strategyRuntime.state = "IDLE";
  strategyRuntime.activeStrategy = null;
  strategyRuntime.direction = null;
  strategyRuntime.buyAmount = 0;
  strategyRuntime.posBeforeBuy = 0;
  strategyRuntime.posBeforeSell = 0;
  strategyRuntime.waitVerifyAfterSell = false;
  strategyRuntime.cleanupAfterVerify = false;
  strategyRuntime.actionTs = 0;
  strategyRuntime.prevUpPct = null;
  strategyRuntime.buyLockUntil = 0;
  strategyRuntime.roundEntryCount = 0;
  for (const s of getAllStrategies()) s.resetState();
  if (reason) console.log(`[Strategy] reset: ${reason}`);
}


function transitionToDone(): void {
  if (strategyRuntime.roundEntryCount < strategyConfig.maxRoundEntries && anyStrategyEnabled()) {
    console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] done, back to scanning (${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries})`);
    strategyRuntime.state = "SCANNING";
    strategyRuntime.activeStrategy = null;
    strategyRuntime.direction = null;
    strategyRuntime.buyAmount = 0;
    strategyRuntime.posBeforeBuy = 0;
    strategyRuntime.posBeforeSell = 0;
    strategyRuntime.waitVerifyAfterSell = false;
    strategyRuntime.cleanupAfterVerify = false;
    strategyRuntime.actionTs = 0;
  } else {
    strategyRuntime.state = "DONE";
  }
  broadcastState();
}

function anyStrategyEnabled(): boolean {
  return ALL_STRATEGY_KEYS.some((key) => strategyConfig.enabled[key]);
}

function hasConfirmedBuyPosition(): boolean {
  return strategyRuntime.direction != null
    && getDirectionLocalSize(strategyRuntime.direction) > strategyRuntime.posBeforeBuy + 0.01;
}

function canReleaseUnconfirmedBuy(now = Date.now()): boolean {
  if (now - strategyRuntime.actionTs < FILL_RECONCILE_TIMEOUT_MS) return false;
  if (!strategyRuntime.direction) return true;
  if ((positions.lastApiSyncAt ?? 0) <= strategyRuntime.actionTs) return false;
  return getDirectionApiSize(strategyRuntime.direction) <= strategyRuntime.posBeforeBuy + 0.01;
}


function buildStrategyRuntimePayload(): Record<string, unknown> {
  const perStrategy: Record<string, Record<string, unknown>> = {};
  // observe panel data: collect as long as the strategy implements getObservePanel
  const observePanels: Record<string, unknown> = {};
  for (const s of getAllStrategies()) {
    perStrategy[s.key] = s.getStatePayload();
    if (typeof s.getObservePanel === "function") {
      const panel = s.getObservePanel();
      if (panel) observePanels[s.key] = panel;
    }
  }
  return {
    observePanels,
    state: strategyRuntime.state,
    activeStrategy: strategyRuntime.activeStrategy,
    direction: strategyRuntime.direction,
    buyAmount: strategyRuntime.buyAmount,
    posBeforeBuy: strategyRuntime.posBeforeBuy,
    posBeforeSell: strategyRuntime.posBeforeSell,
    waitVerifyAfterSell: strategyRuntime.waitVerifyAfterSell,
    cleanupAfterVerify: strategyRuntime.cleanupAfterVerify,
    actionTs: strategyRuntime.actionTs,
    prevUpPct: strategyRuntime.prevUpPct,
    buyLockUntil: strategyRuntime.buyLockUntil,
    positionsReady: strategyRuntime.positionsReady,
    roundEntryCount: strategyRuntime.roundEntryCount,
    perStrategy,
  };
}

/** compute the current fair probability (for real-time display on the s5/s10/s11 frontend panel) */
function computeFairProbPayload(): {
  diff: number | null;
  rem: number;
  upPct: number | null;
  fairUp: number | null;
  biasUp: number | null;
  symbol: MarketSymbol;
  hasFairTable: boolean;
} | null {
  const diff = getStrategyDiff();
  const rem = getStrategyRemainingSeconds();
  const snap = getProbabilitySnapshot();
  // whether the current market has a fair-probability table (the fair-prob module maintains one per marketKey)
  const hasFairTable = hasFairProbTable();
  if (diff == null || !snap) {
    return { diff, rem, upPct: snap?.upPct ?? null, fairUp: null, biasUp: null, symbol: activeMarket.symbol, hasFairTable };
  }
  const fairUp = getFairProb(diff, rem);
  const biasUp = fairUp != null ? fairUp - snap.upPct : null;
  return { diff, rem, upPct: snap.upPct, fairUp, biasUp, symbol: activeMarket.symbol, hasFairTable };
}

function buildStatePayload(options: boolean | StatePayloadOptions = false): Record<string, unknown> {
  const normalized = typeof options === "boolean" ? { includeHistory: options } : options;
  const includeHistory = normalized.includeHistory === true;
  const simple = normalized.simple === true;
  const bids = [...state.bids.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .sort((a, b) => b.price - a.price).slice(0, 8);
  const asks = [...state.asks.entries()]
    .map(([price, size]) => ({ price: Number(price), size: Number(size) }))
    .sort((a, b) => a.price - b.price).slice(0, 8);

  const payload: Record<string, unknown> = {
    activeMarket: {
      key: activeMarket.key,
      symbol: activeMarket.symbol,
      period: activeMarket.period,
      periodSeconds: activeMarket.periodSeconds,
      displayName: activeMarket.displayName,
      priceDecimals: priceDecimals(state.priceToBeat),
    },
    windowStart:  state.windowStart,
    windowEnd:    state.windowEnd,
    bestBid:      state.bestBid,
    bestAsk:      state.bestAsk,
    probabilityReady: isProbabilityReady(),
    lastPrice:    state.lastPrice,
    lastSide:     state.lastSide,
    updatedAt:    state.updatedAt,
    priceToBeat:  state.priceToBeat,
    currentPrice: state.currentPrice,
    binanceOffset: state.binanceOffset,
    coinbaseOffset: state.coinbaseOffset,
    volPct:        state.volPct,
    accountName:   accountName,
    klineCounts: { k1m: state.kline1m.length, k5m: state.kline5m.length },
    binanceDiff: getStrategyDiff(),
    fairProb: computeFairProbPayload(),
    usdc:           positions.usdc,
    usdcAllowanceStatus: positions.usdcAllowanceStatus,
    usdcAllowanceMin: positions.usdcAllowanceMin,
    upLocalSize:    positions.localSize[state.upTokenId]   ?? 0,
    downLocalSize:  positions.localSize[state.downTokenId] ?? 0,
    upApiSize:      positions.apiSize[state.upTokenId]     ?? 0,
    downApiSize:    positions.apiSize[state.downTokenId]   ?? 0,
    upApiVerified:  positions.apiVerified[state.upTokenId]   ?? false,
    downApiVerified:positions.apiVerified[state.downTokenId] ?? false,
    lastTradeAt:    positions.lastTradeAt,
    lastApiSyncAt:  positions.lastApiSyncAt,
    runtimeMode:    APP_MODE,
    strategyConfig,
    strategy:       buildStrategyRuntimePayload(),
    marketStatus:   getUsMarketStatus(),
    ts: Date.now(),
  };
  if (!simple) {
    payload.conditionId = state.conditionId;
    payload.upTokenId = state.upTokenId;
    payload.downTokenId = state.downTokenId;
    payload.bids = bids;
    payload.asks = asks;
    payload.usdcAllowanceDetails = positions.usdcAllowanceDetails;
  }
  if (includeHistory && !simple) {
    payload.priceHistory = state.priceHistory;
    payload.binanceHistory = state.binanceHistory;
    payload.coinbaseHistory = state.coinbaseHistory;
  }
  return payload;
}

function sendStateToClient(ws: WebSocket, options: { includeHistory?: boolean } = {}): void {
  const session = getClientSession(ws);
  const simple = session.dataMode === "low";
  send(ws, "state", buildStatePayload({
    includeHistory: options.includeHistory === true && !simple,
    simple,
  }));
  session.lastStateSentAt = Date.now();
}

function scheduleStateToClient(ws: WebSocket, includeHistory = false): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  const session = getClientSession(ws);
  session.stateDirty = true;
  session.stateIncludeHistory = session.stateIncludeHistory || includeHistory;
  if (session.stateTimer) return;
  const elapsed = Date.now() - session.lastStateSentAt;
  const waitMs = Math.max(0, getStateIntervalMs(session) - elapsed);
  session.stateTimer = setTimeout(() => {
    const latestSession = clientSessions.get(ws);
    if (!latestSession) return;
    latestSession.stateTimer = null;
    if (!latestSession.stateDirty || ws.readyState !== WebSocket.OPEN) return;
    const nextIncludeHistory = latestSession.stateIncludeHistory;
    latestSession.stateDirty = false;
    latestSession.stateIncludeHistory = false;
    if (ws.bufferedAmount > MAX_WS_BUFFERED_BYTES) {
      latestSession.stateDirty = true;
      latestSession.stateIncludeHistory = nextIncludeHistory;
      scheduleStateToClient(ws, nextIncludeHistory);
      return;
    }
    sendStateToClient(ws, { includeHistory: nextIncludeHistory });
  }, waitMs);
}

function broadcastState(includeHistory = false): void {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    scheduleStateToClient(client, includeHistory);
  }
}

function applyClientConfig(ws: WebSocket, raw: unknown): void {
  if (!isRecord(raw) || raw.type !== "clientConfig") return;
  const session = getClientSession(ws);
  const nextMode = normalizeClientDataMode(raw.dataMode);
  if (session.dataMode === nextMode) return;
  session.dataMode = nextMode;
  session.stateDirty = false;
  session.stateIncludeHistory = false;
  clearStateTimer(session);
  console.log(`[System.Frontend] client data mode switched to ${nextMode}`);
  send(ws, "clientConfig", { dataMode: nextMode });
  sendStateToClient(ws, { includeHistory: true });
}

async function fetchBookTopOfBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number }> {
  const book = await fetch(`${CLOB_URL}/book?token_id=${tokenId}`).then(r => r.json()) as {
    bids?: { price: string }[]; asks?: { price: string }[];
  };
  const bids = (book.bids || []).map(b => Number(b.price)).filter(p => p > 0);
  const asks = (book.asks || []).map(a => Number(a.price)).filter(p => p > 0);
  return {
    bestBid: bids.length ? Math.max(...bids) : 0,
    bestAsk: asks.length ? Math.min(...asks) : 0,
  };
}

// ── Gamma API ─────────────────────────────────────────────────
async function fetchMarket(windowStart: number): Promise<{
  conditionId: string; upTokenId: string; downTokenId: string;
  windowStart: number; windowEnd: number;
  eventStartTime: string; endDate: string;
} | null> {
  const slug = `${activeMarket.slugPrefix}-${windowStart}`;
  const startedAt = Date.now();
  try {
    const res = await fetch(`${GAMMA_URL}/events?slug=${slug}`);
    const events = await res.json() as Record<string, unknown>[];
    if (!events?.length) {
      console.warn(`[System.Window] market not found slug=${slug} elapsed:${Date.now() - startedAt}ms`);
      return null;
    }
    const event = events[0];
    const market = ((event.markets || []) as Record<string, unknown>[])[0];
    if (!market) {
      console.warn(`[System.Window] market missing order book slug=${slug} elapsed:${Date.now() - startedAt}ms`);
      return null;
    }
    const tokens   = JSON.parse(market.clobTokenIds as string || "[]") as string[];
    const outcomes = JSON.parse(market.outcomes     as string || "[]") as string[];
    const upIdx    = outcomes.findIndex((o) => o.toLowerCase() === "up");
    return {
      conditionId:    market.conditionId as string,
      upTokenId:      tokens[upIdx >= 0 ? upIdx : 0],
      downTokenId:    tokens[upIdx >= 0 ? 1 - upIdx : 1],
      windowStart,
      windowEnd:      windowStart + activeMarket.periodSeconds,
      eventStartTime: market.eventStartTime as string || new Date(windowStart * 1000).toISOString(),
      endDate:        market.endDate        as string || new Date((windowStart + activeMarket.periodSeconds) * 1000).toISOString(),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[System.Window] market query failed slug=${slug} elapsed:${Date.now() - startedAt}ms reason:${msg}`);
    return null;
  }
}

// -- Reference price ----------------------------------------------
async function fetchCryptoPrice(eventStartTime: string, endDate: string): Promise<void> {
  try {
    const url = `https://polymarket.com/api/crypto/crypto-price?symbol=${activeMarket.cryptoPriceSymbol}&eventStartTime=${encodeURIComponent(eventStartTime)}&variant=${activeMarket.cryptoPriceVariant}&endDate=${encodeURIComponent(endDate)}`;
    const data = await fetch(url).then(r => r.json()) as { openPrice?: number | null; closePrice?: number | null };
    console.log("[RAW]", `[Price.Open] fetch ${activeMarket.cryptoPriceSymbol} ${activeMarket.cryptoPriceVariant} eventStart=${eventStartTime} -> openPrice=${data.openPrice} closePrice=${data.closePrice}`);
    if (data.openPrice != null) state.priceToBeat = data.openPrice;
  } catch (err) {
    console.warn(`[Price.Open] fetch failed: ${(err as Error).message}`);
  }
}

// -- Position API query --------------------------------------------
async function syncPositionsFromApi(): Promise<boolean> {
  if (!PROXY_ADDRESS) {
    strategyRuntime.positionsReady = true;
    return true;
  }
  try {
    const pos = await fetch(
      `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=0.01`
    ).then(r => r.json()) as Array<{ asset: string; size: number }>;
    const apiMap: Record<string, number> = {};
    for (const p of pos) { apiMap[p.asset] = p.size; positions.apiSize[p.asset] = p.size; }
    for (const tokenId of [state.upTokenId, state.downTokenId]) {
      if (!tokenId) continue;
      if (!(tokenId in apiMap)) positions.apiSize[tokenId] = 0;
      const apiVal   = apiMap[tokenId] ?? 0;
      const localVal = positions.localSize[tokenId] ?? 0;
      const msSinceTrade = Date.now() - (positions.lastTradeAt ?? 0);
      if (msSinceTrade < POST_TRADE_CALIBRATION_MS) continue;
      if (Math.abs(apiVal - localVal) <= 0.5) {
        positions.localSize[tokenId]   = apiVal;
        positions.apiVerified[tokenId] = true;
      }
    }
    positions.lastApiSyncAt = Date.now();
    strategyRuntime.positionsReady = true;
    return true;
  } catch {
    return false;
  }
}

// -- USDC balance query --------------------------------------------
// stop subsequent API calls after a CLOB auth error, to avoid the 401 every 5 seconds + extremely long axios error dump flooding
let clobAuthFailed = false;
function isAuthError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as any;
  return e.response?.status === 401 || /unauthorized|invalid api key/i.test(e.message || "");
}

async function syncUsdcBalance(): Promise<void> {
  if (!PROXY_ADDRESS) return;
  if (clobAuthFailed) return;  // auth failure already reported, stop flooding
  try {
    if (!(await ensureClobClient())) return;
    const resp = await clobClient!.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }) as {
      balance?: string;
      allowance?: string;
      allowances?: Record<string, string>;
    };

    positions.usdc = resp.balance != null ? parseFloat(ethers.formatUnits(resp.balance, 6)) : null;

    const allowanceMap = resp.allowances && typeof resp.allowances === "object"
      ? Object.entries(resp.allowances)
      : resp.allowance != null
        ? [["default", resp.allowance]]
        : [];

    const details = allowanceMap.map(([spender, raw]) => {
      const amount = raw != null ? parseFloat(ethers.formatUnits(raw, 6)) : null;
      return { spender, amount: Number.isFinite(amount) ? amount : null };
    });

    positions.usdcAllowanceDetails = details;

    if (!details.length) {
      positions.usdcAllowanceStatus = "NotApproved";
      positions.usdcAllowanceMin = null;
      return;
    }

    const positiveCount = details.filter((item) => (item.amount ?? 0) > 0).length;
    const minAllowance = details.reduce<number | null>((min, item) => {
      if (item.amount == null) return min;
      return min == null ? item.amount : Math.min(min, item.amount);
    }, null);

    positions.usdcAllowanceMin = minAllowance;
    positions.usdcAllowanceStatus = positiveCount === 0
      ? "NotApproved"
      : positiveCount === details.length
        ? "Approved"
        : "NotFullyApproved";
  } catch (e) {
    if (isAuthError(e)) {
      clobAuthFailed = true;
      console.error("[System.Auth] ❌ CLOB API key auth failed (401 Unauthorized)");
      console.error("[System.Auth]    possible cause: .env changed PRIVATE_KEY/PROXY_ADDRESS but .polymarket-creds.json is still the old one");
      console.error("[System.Auth]    fix: delete .polymarket-creds.json then restart to auto re-derive");
      console.error("[System.Auth]    subsequent API calls stopped, to avoid repeatedly flooding error logs");
      return;
    }
    console.error("[System.Balance] balance/allowance query failed:", e instanceof Error ? (e as any).shortMessage ?? e.message : String(e));
  }
}

// -- Backoff reconnect utility ------------------------------------
function backoffDelay(attempt: number): number {
  const delays = [0, 1000, 2000, 4000, 8000, 30000];
  return delays[Math.min(attempt, delays.length - 1)];
}

// -- User WS (listen for fills) --------------------------------------
let userWs: WebSocket | null = null;
let userWsPingTimer: ReturnType<typeof setInterval> | null = null;
let userWsAttempt = 0;

function startUserWs(): void {
  if (!existsSync(CREDS_FILE)) { console.log("[WS.User] credentials file not found, skipping"); return; }
  const creds = JSON.parse(readFileSync(CREDS_FILE, "utf-8")) as {
    key: string; secret: string; passphrase: string;
  };

  userWs = new WebSocket(USER_WS_URL);

  userWs.on("open", () => {
    console.log(userWsAttempt === 0 ? "[WS.User] connected" : "[WS.User] reconnect succeeded");
    userWsAttempt = 0;
    wsStatus.user = true; broadcastWsStatus();
    userWs!.send(JSON.stringify({
      auth: { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase },
      type: "user",
    }));
    userWsPingTimer = setInterval(() => {
      if (userWs?.readyState === WebSocket.OPEN) userWs.send("PING");
    }, 10000);
  });

  userWs.on("message", (data) => {
    const msg = data.toString();
    if (msg === "PONG") return;
    try {
      const arr = JSON.parse(msg);
      const events = Array.isArray(arr) ? arr : [arr];
      for (const evt of events) {
        if (!isRecord(evt)) continue;
        // -- full event raw print (includes trade / order / any other Polymarket UserWS type) --
        // for diagnostics: confirm whether Polymarket pushes order PLACEMENT/UPDATE/CANCELLATION, trade FAILED/RETRYING/CONFIRMED, etc.
        // [RAW] marker -> goes only to trade-raw-*.log, does not pollute the terminal
        const evtType = (typeof evt.event_type === "string" ? evt.event_type : "") || (typeof evt.type === "string" ? evt.type : "");
        const evtStatus = typeof evt.status === "string" ? evt.status : "";
        console.log("[RAW]", `[WS.User.Event] event_type:${evtType} status:${evtStatus} raw:`, JSON.stringify(evt));

        // -- event_type: "order" - order lifecycle (PLACEMENT / CANCELLATION / UPDATE) --
        // used for: (1) unlock pendingOrderConfirm / pendingCancelConfirm; (2) CANCELLATION immediately clears the local Map
        // if pending is not yet registered (WS arrives before the HTTP response) -> write earlyCache, check on register
        if (evt.event_type === "order") {
          const orderID = typeof evt.id === "string" ? evt.id : "";
          const orderType = typeof evt.type === "string" ? evt.type.toUpperCase() : "";
          const orderStatus = typeof evt.status === "string" ? evt.status.toUpperCase() : "";
          if (orderID) {
            if (orderType === "PLACEMENT" || orderStatus === "LIVE") {
              if (pendingOrderConfirm.has(orderID)) resolveOrderConfirm(orderID, "WS PLACEMENT");
              else rememberEarlyWs(earlyOrderConfirmCache, orderID, "WS PLACEMENT");
            }
            if (orderType === "CANCELLATION" || orderStatus === "CANCELED") {
              if (pendingCancelConfirm.has(orderID)) resolveCancelConfirm(orderID, "WS CANCELLATION");
              else rememberEarlyWs(earlyCancelConfirmCache, orderID, "WS CANCELLATION");
              // even without a pendingCancel, the local Map must be cleared (system-initiated cancel / window-switch cleanup / insufficient balance, etc.)
              if (strategyLimitOrders.has(orderID) || manualLimitOrders.has(orderID)) {
                console.log(`[WS.User.Order] CANCELLATION arrived, clearing local Map orderID=${fmtOid(orderID)}`);
                strategyLimitOrders.delete(orderID);
                manualLimitOrders.delete(orderID);
                clearPendingTradeMetaByOrderId(orderID);
                broadcastManualLimitOrders();
              }
            }
            // UPDATE push (partial fill size_matched increases): matchedSize is handled by trade MATCHED, here we only unlock confirm
            if (orderType === "UPDATE") {
              if (pendingOrderConfirm.has(orderID)) resolveOrderConfirm(orderID, "WS UPDATE");
              else rememberEarlyWs(earlyOrderConfirmCache, orderID, "WS UPDATE");
            }
          }
          continue;  // order event handled, do not enter the trade branch
        }
        // -- latency monitoring: MATCHED event settles the total latency of this machine's order -> match (may arrive before the HTTP response) --
        if ((evt.type === "TRADE" || evt.event_type === "trade") && evt.status === "MATCHED") {
          console.log("[RAW]", `[WS.User] MATCHED raw:`, JSON.stringify(evt));
          const mOrderId = typeof evt.taker_order_id === "string" ? evt.taker_order_id : undefined;
          if (mOrderId) {
            if (pendingOrderConfirm.has(mOrderId)) resolveOrderConfirm(mOrderId, "WS MATCHED(taker)");
            else rememberEarlyWs(earlyOrderConfirmCache, mOrderId, "WS MATCHED(taker)");
          }
          // MAKER path: our own order is in maker_orders[], must also be unlocked
          const moList = Array.isArray(evt.maker_orders) ? evt.maker_orders : [];
          for (const mo of moList) {
            if (!isRecord(mo)) continue;
            const moOid = typeof mo.order_id === "string" ? mo.order_id : "";
            if (!moOid) continue;
            if (pendingOrderConfirm.has(moOid)) resolveOrderConfirm(moOid, "WS MATCHED(maker)");
            else rememberEarlyWs(earlyOrderConfirmCache, moOid, "WS MATCHED(maker)");
          }
          onWsMatched(mOrderId);
          // check whether a conditional order (TP GTC) was matched in this MATCHED (as a maker)
          const makerOrders = Array.isArray(evt.maker_orders) ? evt.maker_orders : [];
          for (const mo of makerOrders) {
            if (!isRecord(mo)) continue;
            const makerOrderId = typeof mo.order_id === "string" ? mo.order_id : "";
            if (!makerOrderId) continue;
            const matchedAmount = parseFloat(String(mo.matched_amount ?? "0"));
            for (const cond of activeConditionOrders.values()) {
              if (cond.kind !== "tp" || cond.polymarketOrderId !== makerOrderId) continue;
              // MATCHED only updates the match-layer remainingSize (display only);
              // the real fill decision goes through the MINED on-chain path, to avoid state divergence caused by multiple PM MATCHED pushes over-reporting
              if (Number.isFinite(matchedAmount) && matchedAmount > 0) {
                cond.remainingSize = Math.max(0, cond.remainingSize - matchedAmount);
                console.log(`[Cond.TP] MATCHED ${cond.direction} +${matchedAmount.toFixed(4)} match remaining ${cond.remainingSize.toFixed(4)} (awaiting MINED confirmation)`);
              }
            }
            // strategy limit order taken as maker: MATCHED = match passed (not on-chain), only update matchedSize;
            // the real "fill" decision + deleting stratOrder + triggering TP, all done in the MINED branch by on-chain confirmation.
            const stratOrder = strategyLimitOrders.get(makerOrderId);
            if (stratOrder && Number.isFinite(matchedAmount) && matchedAmount > 0) {
              stratOrder.matchedSize = Math.min(stratOrder.shares, stratOrder.matchedSize + matchedAmount);
              const tag = stratOrder.side === "sell" ? "TP" : "limit";
              const moPrice = mo.price;
              const moFee = mo.fee_rate_bps;
              const tradeId = typeof evt.id === "string" ? evt.id : "-";
              const takerOrderId = typeof evt.taker_order_id === "string" ? evt.taker_order_id : "-";
              console.log(`[Strategy.${stratOrder.strategyKey}] ${tag} matched +${matchedAmount} shares matching ${stratOrder.matchedSize}/${stratOrder.shares} maker:${makerOrderId} price:${moPrice ?? "-"} fee_bps:${moFee ?? "-"} tradeId:${tradeId} taker:${takerOrderId} (awaiting on-chain confirmation)`);
            }
          }
          broadcastConditionOrders();
          continue;  // only settle latency; position updates wait for the MINED event
        }
        if ((evt.type === "TRADE" || evt.event_type === "trade") && evt.status === "MINED") {
          console.log("[RAW]", `[WS.User] MINED raw:`, JSON.stringify(evt));
          const tradeId = evt.id as string;
          const traderSide = typeof evt.trader_side === "string" ? evt.trader_side.toUpperCase() : "";
          const isMaker = traderSide === "MAKER";
          const txHash = typeof evt.transaction_hash === "string" && evt.transaction_hash
            ? evt.transaction_hash
            : undefined;
          // -- extract the "my fills" list --
          // TAKER: use top-level fields (taker_order_id / asset_id / size / side / price) -- 1 entry
          // MAKER: filter from maker_orders[] where maker_address === PROXY_ADDRESS or order_id hits the local Map -- may be multiple entries
          // note: for MAKER the top-level asset_id/side/size/price are from the counterparty's (taker's) perspective, must never be used
          type MyFill = {
            dedupKey: string;
            orderId: string | undefined;
            assetId: string;
            side: "buy" | "sell";
            size: number;
            price: number;
          };
          const proxyLc = (PROXY_ADDRESS || "").toLowerCase();
          const myFills: MyFill[] = [];
          if (isMaker) {
            const makerOrders = Array.isArray(evt.maker_orders) ? evt.maker_orders : [];
            for (const mo of makerOrders) {
              if (!isRecord(mo)) continue;
              const ma = typeof mo.maker_address === "string" ? mo.maker_address : "";
              const oid = typeof mo.order_id === "string" ? mo.order_id : "";
              const isMine = (!!ma && ma.toLowerCase() === proxyLc)
                || (!!oid && (manualLimitOrders.has(oid) || strategyLimitOrders.has(oid)));
              if (!isMine) continue;
              const moAssetId = typeof mo.asset_id === "string" ? mo.asset_id : "";
              const moSide = normalizeTradeSide(mo.side);
              const moAmount = parseFloat(String(mo.matched_amount ?? "0"));
              const moPrice = parseFloat(String(mo.price ?? "0"));
              if (!moAssetId || !moSide || !Number.isFinite(moAmount) || moAmount <= 0) continue;
              myFills.push({
                dedupKey: `${tradeId}:${oid}`,
                orderId: oid || undefined,
                assetId: moAssetId,
                side: moSide,
                size: moAmount,
                price: Number.isFinite(moPrice) ? moPrice : 0,
              });
            }
          } else {
            const topAssetId = typeof evt.asset_id === "string" ? evt.asset_id : "";
            const topSize = typeof evt.size === "number" ? evt.size : parseFloat(String(evt.size ?? ""));
            const topSide = normalizeTradeSide(evt.side);
            const topPrice = typeof evt.price === "number" ? evt.price : parseFloat(String(evt.price ?? ""));
            const topOrderId = typeof evt.taker_order_id === "string" && evt.taker_order_id
              ? evt.taker_order_id
              : undefined;
            if (topAssetId && topSide && Number.isFinite(topSize) && topSize > 0) {
              myFills.push({
                dedupKey: tradeId,
                orderId: topOrderId,
                assetId: topAssetId,
                side: topSide,
                size: topSize,
                price: Number.isFinite(topPrice) ? topPrice : 0,
              });
            }
          }
          if (myFills.length === 0) {
            console.log(`[WS.User] MINED tradeId=${tradeId} trader_side=${traderSide} no own fill matched, skipping`);
            continue;
          }

          // loop over each fill
          for (const fill of myFills) {
            if (!rememberBounded(positions.confirmedIds, positions.confirmedIdOrder, fill.dedupKey, MAX_CONFIRMED_TRADE_IDS)) {
              console.log(`[WS.User] MINED duplicate dedupKey=${fill.dedupKey}, skipping`);
              continue;
            }
            // pendingMeta is looked up in the Map directly by the fill's own orderId
            // fix A: MAKER path does not consume (peek only), multiple MINED fills of the same order share the same meta;
            //   meta is cleaned up in sync when stratOrder is deleted (cleanupPendingTradeMetaForOrder), with 15-minute fallback aging
            // TAKER path still consumes once (one trade has one taker_order_id, no "multiple fills sharing" problem)
            let pendingMeta: PendingTradeMeta | null = null;
            if (fill.orderId) {
              const direct = pendingTradeMeta.get(fill.orderId);
              if (direct) {
                if (!isMaker) {
                  pendingTradeMeta.delete(fill.orderId);  // only TAKER consumes
                }
                pendingMeta = direct;
              }
            }
            if (!pendingMeta) pendingMeta = consumePendingTradeMeta(evt);
            const direction = pendingMeta?.direction ?? getDirectionByAssetId(fill.assetId);
            if (!(fill.assetId in positions.localSize)) positions.localSize[fill.assetId] = 0;
            positions.localSize[fill.assetId] = fill.side === "buy"
              ? positions.localSize[fill.assetId] + fill.size
              : Math.max(0, positions.localSize[fill.assetId] - fill.size);
            positions.apiVerified[fill.assetId] = false;
            positions.lastTradeAt = parseTradeEventTimestamp(evt);
            if (direction && Number.isFinite(fill.price) && fill.price > 0) {
              notifyTradeForPnl(txHash, pendingMeta?.source ?? "manual");
            }
            if (fill.side === "buy" && direction && Number.isFinite(fill.price) && fill.price > 0) {
              schedulePostTradePush({
                direction,
                size: fill.size,
                price: fill.price,
                source: pendingMeta?.source ?? "manual",
              });
            }
            const tradeSymbol = getSymbolByAssetId(fill.assetId).toUpperCase();
            const dirArr = direction === "up" ? "⬆" : direction === "down" ? "⬇" : "·";
            const sideZh2 = fill.side === "buy" ? "buy" : "sell";
            const role = traderSide === "MAKER" ? "M" : "T";
            console.log(
              `[WS.User] 🔗 on-chain ${dirArr} ${sideZh2} ${fill.size}@${Number.isFinite(fill.price) ? fill.price : "-"}`
              + ` ${tradeSymbol} (${role})`
              + ` orderID=${fmtOid(fill.orderId)}`
              + ` source=${pendingMeta?.source ?? "-"}`
              + ` tx=${fmtOid(txHash)}`
            );
            // full pendingMeta + asset_id + tradeId go to raw log
            console.log("[RAW]", `[WS.User] MINED detail tradeId:${tradeId} asset:${fill.assetId} pendingMeta:${pendingMeta ? JSON.stringify(pendingMeta) : "-"}`);

            // limit-strategy TP sell order on-chain confirmation (MINED side=sell + source=strategy*tp)
            if (fill.side === "sell" && pendingMeta?.source && /^strategy[a-z0-9]+tp$/i.test(pendingMeta.source) && direction) {
              const strategyKey = pendingMeta.source.replace(/^strategy/i, "").replace(/tp$/i, "");
              onStrategyTakeProfitMined(strategyKey, direction, fill.size);
            }

            // conditional-order TP GTC on-chain confirmation (MINED side=sell + source=cond-tp)
            // accumulate cond.chainFilledSize; only delete cond + clear same-group SL when it reaches zero (avoids MATCHED over-reporting causing erroneous deletion)
            if (fill.side === "sell" && pendingMeta?.source === "cond-tp" && direction) {
              for (const cond of activeConditionOrders.values()) {
                if (cond.kind !== "tp") continue;
                if (cond.polymarketOrderId !== fill.orderId) continue;
                cond.chainFilledSize = (cond.chainFilledSize ?? 0) + fill.size;
                if (cond.chainFilledSize >= cond.size - 0.01) {
                  console.log(`[Cond.TP] MINED fully filled ${cond.direction} ${cond.size}@${cond.triggerPrice} (order:${(cond.polymarketOrderId ?? "").slice(0, 10)}...)`);
                  activeConditionOrders.delete(cond.id);
                  void clearConditionOrdersByGroup(cond.groupId, cond.id, "TP filled");
                  broadcast("condFilled", { kind: "tp", direction: cond.direction, price: cond.triggerPrice });
                } else {
                  console.log(`[Cond.TP] MINED partial +${fill.size.toFixed(4)} on-chain ${cond.chainFilledSize.toFixed(4)}/${cond.size} (remainder still resting on PM)`);
                }
                broadcastConditionOrders();
              }
            }

            // post-buy on-chain calibration + conditional order creation:
            // - TAKER: WS size has a ~1% deviation, calibrate with getRealFillFromTx
            // - MAKER: mo.matched_amount is already the exact on-chain matched amount, no calibration needed (use directly)
            if (fill.side === "buy" && txHash && PROXY_ADDRESS) {
              const wsSize = fill.size;
              const targetAssetId = fill.assetId;
              const condDir = direction;
              const condEntryPrice = fill.price;
              const condMeta = pendingMeta;
              const skipChainCalibration = isMaker;
              void (async () => {
                let finalSize = wsSize;
                if (skipChainCalibration) {
                  console.log(`[Trade.OnChain] ✓ MAKER path exact fill asset:${targetAssetId} tx:${txHash} matched_amount:${wsSize} (calibration skipped)`);
                  positions.apiSize[targetAssetId] = positions.localSize[targetAssetId];
                  positions.apiVerified[targetAssetId] = true;
                  broadcastState();
                } else {
                  const realFill = await getRealFillFromTx(txHash, PROXY_ADDRESS);
                  if (realFill == null) {
                    console.log(`[Trade.OnChain] ⚠ calibration failed tx:${txHash} asset:${targetAssetId} will fall back to REST`);
                  } else {
                    const delta = realFill - wsSize;
                    if (Math.abs(delta) < 0.000001) {
                      console.log(`[Trade.OnChain] ✓ buy calibration asset:${targetAssetId} tx:${txHash} WS:${wsSize} = on-chain:${realFill}`);
                    } else {
                      positions.localSize[targetAssetId] = (positions.localSize[targetAssetId] ?? 0) + delta;
                      console.log(`[Trade.OnChain] ✓ buy calibration asset:${targetAssetId} tx:${txHash} WS:${wsSize} -> on-chain:${realFill} (delta:${delta >= 0 ? "+" : ""}${delta.toFixed(6)})`);
                    }
                    positions.apiSize[targetAssetId] = positions.localSize[targetAssetId];
                    positions.apiVerified[targetAssetId] = true;
                    broadcastState();
                    finalSize = realFill;
                  }
                }
                if (condDir && condMeta && Number.isFinite(condEntryPrice) && condEntryPrice > 0 && (condMeta.stopProfit || condMeta.stopLoss)) {
                  await createConditionOrdersAfterFill({
                    direction: condDir,
                    assetId: targetAssetId,
                    entryPrice: condEntryPrice,
                    filledSize: finalSize,
                    windowStart: condMeta.windowStart,
                    stopProfit: condMeta.stopProfit,
                    stopLoss: condMeta.stopLoss,
                  });
                }
                if (condMeta?.source && /^strategy[a-z0-9]+$/i.test(condMeta.source)
                    && !/tp$/i.test(condMeta.source) && condDir) {
                  const strategyKey = condMeta.source.replace(/^strategy/i, "");
                  // fix C: pass in fill.orderId so onStrategyLimitMined matches exactly, avoiding cross-talk between multiple stratOrders
                  await onStrategyLimitMined(strategyKey, condDir, finalSize, fill.orderId);
                }
              })();
            }
          }
          broadcastState();
        }
      }
    } catch { /* ignore */ }
  });

  userWs.on("close", () => {
    if (userWsPingTimer) clearInterval(userWsPingTimer);
    const delay = backoffDelay(userWsAttempt++);
            console.log(`[WS.User] disconnected, reconnecting in ${delay}ms (attempt ${userWsAttempt})`);
    wsStatus.user = false; broadcastWsStatus();
    invalidatePendingLatencyOnWsDisconnect();
    if (!stopped) setTimeout(startUserWs, delay);
  });
  userWs.on("error", (err) => { console.error("[WS.User] error:", err.message); });
}

// ── Market WS ─────────────────────────────────────────────────
let marketWs: WebSocket | null = null;
let marketPingTimer:   ReturnType<typeof setInterval> | null = null;
let marketRenderTimer: ReturnType<typeof setInterval> | null = null;
let marketValidationTimer: ReturnType<typeof setInterval> | null = null;
let lastBestBidAskTimestamp = 0;
let bestBidAskPausedUntil = 0;
let marketValidationMismatchStreak = 0;
let marketReconnectPending = false;
let marketBestReady = false;

function isProbabilityReady(now = Date.now()): boolean {
  if (!wsStatus.market) return false;
  if (!marketBestReady) return false;
  if (now < bestBidAskPausedUntil) return false;
  const bid = Number(state.bestBid);
  const ask = Number(state.bestAsk);
  return Number.isFinite(bid) && Number.isFinite(ask);
}

function parseEventTimestamp(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

function applyBestBidAskUpdate(
  bestBid: unknown,
  bestAsk: unknown,
  timestamp: unknown,
): boolean {
  if (typeof bestBid !== "string" || typeof bestAsk !== "string") return false;
  if (Date.now() < bestBidAskPausedUntil) return false;
  const ts = parseEventTimestamp(timestamp);
  if (ts > 0 && ts < lastBestBidAskTimestamp) return false;
  if (ts > 0) lastBestBidAskTimestamp = ts;
  state.bestBid = bestBid;
  state.bestAsk = bestAsk;
  marketBestReady = true;
  scheduleStrategyTick();  // order book update (probability change) immediately triggers a strategy check
  return true;
}

function clearProbabilityForMs(ms: number, reason: string): void {
  const until = Date.now() + ms;
  if (until > bestBidAskPausedUntil) bestBidAskPausedUntil = until;
  marketBestReady = false;
  lastBestBidAskTimestamp = 0;
  state.bestBid = "-";
  state.bestAsk = "-";
  state.updatedAt = Date.now();
  console.warn(`[Health.Prob] ${reason}, clearing probability ${ms}ms`);
  broadcastState();
}

function requestMarketReconnect(reason: string, options?: { clearProbabilityMs?: number }): void {
  clearProbabilityForMs(options?.clearProbabilityMs ?? 0, reason);
  marketValidationMismatchStreak = 0;
  if (marketReconnectPending) return;
  marketReconnectPending = true;
  console.warn(`[WS.Market] triggering reconnect: ${reason}`);
  if (marketWs) {
    marketWs.close();
    return;
  }
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    void subscribeWindow(Math.max(subscribedWindow, getCurrentWindowStart()));
  }, 1000);
}

async function validateMarketProbability(expectedWindowStart: number, upTokenId: string): Promise<void> {
  if (marketReconnectPending) return;
  if (subscribedWindow !== expectedWindowStart) return;
  if (!marketWs || marketWs.readyState !== WebSocket.OPEN) return;

  try {
    const { bestBid, bestAsk } = await fetchBookTopOfBook(upTokenId);
    if (subscribedWindow !== expectedWindowStart || upTokenId !== state.upTokenId) return;
    if (!(bestBid > 0) || !(bestAsk > 0)) return;

    const wsBid = Number(state.bestBid);
    const wsAsk = Number(state.bestAsk);
    if (!Number.isFinite(wsBid) || !Number.isFinite(wsAsk)) return;

    const restMid = (bestBid + bestAsk) / 2;
    const wsMid = (wsBid + wsAsk) / 2;
    const diffPct = Math.abs(restMid - wsMid) * 100;

    if (diffPct > 3) {
      marketValidationMismatchStreak++;
      // print only when deviation is large (>=5%) or a reconnect is about to trigger (>=2/3), to avoid noise
      if (diffPct >= 5 || marketValidationMismatchStreak >= 2) {
        console.warn(`[Health.Prob] ⚠ REST deviation ${diffPct.toFixed(2)}% streak ${marketValidationMismatchStreak}/3`);
      }
      if (marketValidationMismatchStreak >= 3) {
        console.warn(`[Health.Prob] ❌ triggering reconnect: 3/3 consecutive deviation >3%`);
        requestMarketReconnect(`probability deviation >${3}% 3 times in a row`);
      }
      return;
    }

    marketValidationMismatchStreak = 0;
  } catch (err) {
    if (subscribedWindow !== expectedWindowStart || upTokenId !== state.upTokenId) return;
    requestMarketReconnect(
      `REST validation failed: ${err instanceof Error ? err.message : String(err)}`,
      { clearProbabilityMs: 2000 },
    );
  }
}

let _marketWsConnectedOnce = false;
function startMarketWs(expectedWindowStart: number, upTokenId: string, downTokenId: string, onClose: () => void): WebSocket {
  const ws = new WebSocket(MARKET_WS_URL);
  ws.on("open", () => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart) return;
    console.log(_marketWsConnectedOnce ? "[WS.Market] reconnect succeeded" : "[WS.Market] connected");
    _marketWsConnectedOnce = true;
    marketReconnectPending = false;
    marketValidationMismatchStreak = 0;
    marketBestReady = false;
    wsStatus.market = true; broadcastWsStatus();
    ws.send(JSON.stringify({
      assets_ids: [upTokenId, downTokenId],
      type: "market",
      custom_feature_enabled: true,
    }));
    marketRenderTimer = setInterval(broadcastState, 1000);
    marketValidationTimer = setInterval(() => {
      void validateMarketProbability(expectedWindowStart, upTokenId);
    }, 1000);
    marketPingTimer   = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("PING");
    }, 10000);
  });
  ws.on("message", (data) => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart || state.upTokenId !== upTokenId) return;
    const msg = data.toString();
    if (msg === "PONG" || msg === "[]") return;
    try {
      const events = Array.isArray(JSON.parse(msg)) ? JSON.parse(msg) : [JSON.parse(msg)];
      for (const evt of events) {
        if (evt.bids !== undefined && evt.asks !== undefined) {
          if (evt.asset_id && evt.asset_id !== upTokenId) continue;
          state.bids.clear(); state.asks.clear();
          for (const b of (evt.bids as { price: string; size: string }[])) {
            if (Number(b.size) > 0) state.bids.set(b.price, b.size);
          }
          for (const a of (evt.asks as { price: string; size: string }[])) {
            if (Number(a.size) > 0) state.asks.set(a.price, a.size);
          }
          state.updatedAt = Date.now();
          broadcastState();
        } else if (evt.event_type === "best_bid_ask") {
          if (evt.asset_id && evt.asset_id !== upTokenId) continue;
          if (!applyBestBidAskUpdate(evt.best_bid, evt.best_ask, evt.timestamp)) continue;
          state.updatedAt = Date.now();
          broadcastState();
        } else if (evt.event_type === "price_change" && evt.price_changes) {
          for (const change of evt.price_changes as Record<string, string>[]) {
            if (change.asset_id !== upTokenId) continue;
            if (change.price && change.size !== undefined) {
              state.lastPrice = Number(change.price).toFixed(2);
              state.lastSide  = change.side;
              // sync update of order book depth
              const size = Number(change.size);
              const map = change.side === 'BUY' ? state.bids : state.asks;
              if (size > 0) map.set(change.price, change.size);
              else map.delete(change.price);
            }
          }
          state.updatedAt = Date.now();
          broadcastState();
        }
      }
    } catch { /* ignore */ }
  });
  ws.on("close", () => {
    if (ws !== marketWs || subscribedWindow !== expectedWindowStart) return;
    if (marketPingTimer)   clearInterval(marketPingTimer);
    if (marketRenderTimer) clearInterval(marketRenderTimer);
    if (marketValidationTimer) {
      clearInterval(marketValidationTimer);
      marketValidationTimer = null;
    }
    marketBestReady = false;
    state.bestBid = "-";
    state.bestAsk = "-";
    state.updatedAt = Date.now();
    console.log("[WS.Market] connection lost, reconnecting in 1 second");
    wsStatus.market = false; broadcastWsStatus();
    broadcastState();
    broadcast("marketDown", {});
    onClose();
  });
  ws.on("error", (err) => { console.error("[WS.Market] error:", err.message); });
  return ws;
}

// ── Chainlink WS ──────────────────────────────────────────────
let chainlinkWs: WebSocket | null = null;

function startChainlinkWs(expectedWindowStart: number, eventSlug: string, onClose: () => void, attempt = 0): WebSocket {
  const ws = new WebSocket(CHAINLINK_WS_URL);
  ws.on("open", () => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    console.log(attempt === 0 ? "[WS.OnChainPrice] connected" : "[WS.OnChainPrice] reconnect succeeded");
    wsStatus.chainlink = true; broadcastWsStatus();
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "update", filters: JSON.stringify({ symbol: activeMarket.chainlinkSymbol }) },
        { topic: "activity", type: "orders_matched", filters: JSON.stringify({ event_slug: eventSlug }) },
      ],
    }));
  });
  ws.on("message", (data) => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    try {
      const msg = JSON.parse(data.toString()) as { topic?: string; type?: string; timestamp?: number; payload?: { value?: number; timestamp?: number } };
      if (msg.topic === "crypto_prices_chainlink" && msg.type === "update") {
        const val = msg.payload?.value;
        if (val != null) {
          state.currentPrice = val;
          const now = msg.payload?.timestamp ?? msg.timestamp ?? Date.now();
          state.priceHistory.push({ t: now, price: val });
          trimHistory(state.priceHistory, now - HISTORY_RETENTION_MS, MAX_CHAINLINK_HISTORY_POINTS);
          maybeInitializeBinanceOffset();
          broadcast("chainlinkPrice", { t: now, price: val });
          broadcastState();
          scheduleStrategyTick();  // price update immediately triggers a strategy check
        }
      }
    } catch { /* ignore */ }
  });
  ws.on("close", () => {
    if (ws !== chainlinkWs || subscribedWindow !== expectedWindowStart) return;
    const delay = backoffDelay(attempt);
    console.log(`[WS.OnChainPrice] connection lost, reconnecting in ${delay}ms (attempt ${attempt + 1})`);
    wsStatus.chainlink = false; broadcastWsStatus();
    broadcast("chainlinkDown", {});
    onClose();
  });
  ws.on("error", (err) => { console.error("[WS.OnChainPrice] error:", err.message); });
  return ws;
}

// -- Binance WS ---------------------------------------------------
let binanceWs: WebSocket | null = null;
let binanceWsAttempt = 0;

function updateKlineArray(arr: Kline[], k: Kline, maxSize: number): void {
  const last = arr[arr.length - 1];
  if (last && last.openTime === k.openTime) {
    // within the same kline update
    arr[arr.length - 1] = k;
  } else {
    arr.push(k);
    if (arr.length > maxSize) arr.splice(0, arr.length - maxSize);
  }
}

/** pull historical klines from Binance REST (for startup pre-fill and gap-filling after reconnect) */
async function fetchHistoricalKlines(interval: "1m" | "5m", limit: number): Promise<Kline[] | null> {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${activeMarket.binanceSymbol.toUpperCase()}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const raw = await res.json() as Array<Array<string | number>>;
    return raw.map((r) => ({
      openTime: Number(r[0]),
      open: parseFloat(String(r[1])),
      high: parseFloat(String(r[2])),
      low: parseFloat(String(r[3])),
      close: parseFloat(String(r[4])),
      volume: parseFloat(String(r[5])),
      closed: true,  // everything REST returns is already closed
    }));
  } catch (err) {
    console.warn(`[Price.Binance] failed to pull historical ${interval} klines: ${(err as Error).message}`);
    return null;
  }
}

/** merge historical klines into the existing array, dedupe and keep the latest maxSize bars */
function mergeKlines(existing: Kline[], fetched: Kline[], maxSize: number): void {
  const map = new Map<number, Kline>();
  for (const k of existing) map.set(k.openTime, k);
  for (const k of fetched) {
    // historical data only overwrites when the current bar is absent or not yet closed
    const curr = map.get(k.openTime);
    if (!curr || !curr.closed) map.set(k.openTime, k);
  }
  const sorted = [...map.values()].sort((a, b) => a.openTime - b.openTime);
  existing.length = 0;
  const start = Math.max(0, sorted.length - maxSize);
  for (let i = start; i < sorted.length; i++) existing.push(sorted[i]);
}

async function loadHistoricalKlines(attempt = 1): Promise<void> {
  const [k1m, k5m] = await Promise.all([
    fetchHistoricalKlines("1m", MAX_KLINE_1M),
    fetchHistoricalKlines("5m", MAX_KLINE_5M),
  ]);
  if (k1m) {
    mergeKlines(state.kline1m, k1m, MAX_KLINE_1M);
    console.log(`[Price.Binance] 1m kline pre-fill ${state.kline1m.length} bars`);
  }
  if (k5m) {
    mergeKlines(state.kline5m, k5m, MAX_KLINE_5M);
    console.log(`[Price.Binance] 5m kline pre-fill ${state.kline5m.length} bars`);
  }
  // if either fails, retry with exponential backoff, up to 5 times (3s / 6s / 12s / 24s / 48s)
  const need1m = !k1m && state.kline1m.length < MAX_KLINE_1M;
  const need5m = !k5m && state.kline5m.length < MAX_KLINE_5M;
  if ((need1m || need5m) && attempt <= 5) {
    const delayMs = Math.min(48000, 3000 * Math.pow(2, attempt - 1));
    console.warn(`[Price.Binance] kline load failed (1m=${!!k1m} 5m=${!!k5m}), retrying in ${delayMs/1000}s ${attempt}/5`);
    setTimeout(() => { void loadHistoricalKlines(attempt + 1); }, delayMs);
  } else if (need1m || need5m) {
    console.error(`[Price.Binance] kline load failed 5 times in a row, giving up. Strategies may not work properly.`);
  }
}

function startBinanceWs(): void {
  const url = getBinanceWsUrl(activeMarket.key);
  console.log(`[WS.Binance] connecting ${activeMarket.symbol} -> ${url}`);
  const ws = new WebSocket(url);
  binanceWs = ws;
  ws.on("open", () => {
    console.log(binanceWsAttempt === 0 ? `[WS.Binance] connected (${activeMarket.symbol})` : `[WS.Binance] reconnect succeeded (${activeMarket.symbol})`);
    binanceWsAttempt = 0;
    wsStatus.binance = true;
    broadcastWsStatus();
    // after connecting, asynchronously pull historical klines to fill / patch gaps
    void loadHistoricalKlines();
  });
  ws.on("message", (data) => {
    // when switching markets, the old ws may still push messages while closing; discard to avoid polluting the new market's binanceHistory
    if (ws !== binanceWs) return;
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
        state.binanceHistory.push({ t, price });
        trimHistory(state.binanceHistory, t - HISTORY_RETENTION_MS, MAX_BINANCE_HISTORY_POINTS);
        recomputeVolPct(t);
        maybeInitializeBinanceOffset();
        broadcast("binancePrice", { t, price });
        scheduleStrategyTick();  // price change immediately triggers a strategy check
        return;
      }

      if (stream.endsWith("@kline_1m") || stream.endsWith("@kline_5m")) {
        const kData = (payload as { k?: Record<string, unknown> }).k;
        if (!kData) return;
        const kline: Kline = {
          openTime: Number(kData.t),
          open: parseFloat(String(kData.o)),
          high: parseFloat(String(kData.h)),
          low: parseFloat(String(kData.l)),
          close: parseFloat(String(kData.c)),
          volume: parseFloat(String(kData.v)),
          closed: Boolean(kData.x),
        };
        if (stream.endsWith("@kline_1m")) {
          updateKlineArray(state.kline1m, kline, MAX_KLINE_1M);
        } else {
          updateKlineArray(state.kline5m, kline, MAX_KLINE_5M);
        }
        scheduleStrategyTick();  // kline update immediately triggers a strategy check
        return;
      }
    } catch { /* ignore */ }
  });
  ws.on("close", () => {
    if (ws !== binanceWs) return;  // an old ws close event should not trigger a reconnect
    const delay = backoffDelay(binanceWsAttempt++);
    console.log(`[WS.Binance] disconnected, reconnecting in ${delay}ms (attempt ${binanceWsAttempt})`);
    wsStatus.binance = false; broadcastWsStatus();
    if (!stopped) setTimeout(startBinanceWs, delay);
  });
  ws.on("error", (err) => { console.error("[WS.Binance] error:", err.message); });
}

// ── Coinbase WS ───────────────────────────────────────────────
let coinbaseWs: WebSocket | null = null;
let coinbaseWsAttempt = 0;

function startCoinbaseWs(): void {
  console.log(`[WS.Coinbase] connecting ${activeMarket.coinbaseProduct}`);
  const ws = new WebSocket(COINBASE_WS_URL);
  coinbaseWs = ws;
  ws.on("open", () => {
    console.log(coinbaseWsAttempt === 0 ? `[WS.Coinbase] connected (${activeMarket.coinbaseProduct})` : `[WS.Coinbase] reconnect succeeded (${activeMarket.coinbaseProduct})`);
    coinbaseWsAttempt = 0;
    wsStatus.coinbase = true;
    broadcastWsStatus();
    // subscribe to the ticker for the current market (pushes the price on every trade)
    ws.send(JSON.stringify({
      type: "subscribe",
      product_ids: [activeMarket.coinbaseProduct],
      channels: ["ticker"],
    }));
  });
  ws.on("message", (data) => {
    // when switching markets, the old ws may still push messages while closing; discard to avoid polluting the new market's coinbaseHistory
    if (ws !== coinbaseWs) return;
    try {
      const raw = JSON.parse(data.toString()) as Record<string, unknown>;
      // ticker push: { type: "ticker", price: "...", time: "ISO", product_id: "BTC-USD", ... }
      if (raw.type !== "ticker") return;
      const price = typeof raw.price === "string" ? parseFloat(raw.price) : (typeof raw.price === "number" ? raw.price : NaN);
      if (!Number.isFinite(price) || price <= 0) return;
      const tStr = typeof raw.time === "string" ? raw.time : null;
      const t = tStr ? Date.parse(tStr) : Date.now();
      state.coinbaseHistory.push({ t, price });
      trimHistory(state.coinbaseHistory, t - HISTORY_RETENTION_MS, MAX_COINBASE_HISTORY_POINTS);
      maybeInitOffset(COINBASE_SPEC);
      broadcast("coinbasePrice", { t, price });
    } catch { /* ignore */ }
  });
  ws.on("close", () => {
    if (ws !== coinbaseWs) return;
    const delay = backoffDelay(coinbaseWsAttempt++);
    console.log(`[WS.Coinbase] disconnected, reconnecting in ${delay}ms (attempt ${coinbaseWsAttempt})`);
    wsStatus.coinbase = false; broadcastWsStatus();
    if (!stopped) setTimeout(startCoinbaseWs, delay);
  });
  ws.on("error", (err) => { console.error("[WS.Coinbase] error:", err.message); });
}

// -- Last 4 rounds result query ---------------------------------------
function parseResolvedOutcome(event: Record<string, unknown> | undefined): "up" | "down" | null {
  const market = ((event?.markets as Record<string, unknown>[] | undefined) || [])[0];
  if (!market) return null;

  let outcomes: string[] = [];
  let outcomePrices: string[] = [];

  try { outcomes = JSON.parse(String(market.outcomes || "[]")) as string[]; } catch { /* ignore */ }
  try { outcomePrices = JSON.parse(String(market.outcomePrices || "[]")) as string[]; } catch { /* ignore */ }

  if (!outcomes.length || outcomes.length !== outcomePrices.length) return null;

  const upIdx = outcomes.findIndex((o) => o.toLowerCase() === "up");
  const downIdx = outcomes.findIndex((o) => o.toLowerCase() === "down");
  if (upIdx < 0 || downIdx < 0) return null;

  const upPrice = Number(outcomePrices[upIdx]);
  const downPrice = Number(outcomePrices[downIdx]);
  if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return null;

  if (upPrice >= 0.999 && downPrice <= 0.001) return "up";
  if (downPrice >= 0.999 && upPrice <= 0.001) return "down";
  return null;
}

async function fetchRecentResults(currentWindow: number, immediate = false): Promise<void> {
  if (!immediate) await new Promise(r => setTimeout(r, 5000));
  if (stopped) return;
  try {
    const slugs = [1,2,3,4].map(i => `${activeMarket.slugPrefix}-${currentWindow - i * activeMarket.periodSeconds}`);
    const query = slugs.map(s => `slug=${s}`).join("&");
    const events = await fetch(`${GAMMA_URL}/events?${query}`).then(r => r.json()) as Record<string, unknown>[];
    const results = slugs.map(slug => {
      const event = events.find((e: Record<string, unknown>) => e.slug === slug) as Record<string, unknown> | undefined;
      const ws = parseInt(slug.split("-").pop()!);
      const timeRange = `${new Date(ws*1000).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:'2-digit',minute:'2-digit'})}→${new Date((ws+300)*1000).toLocaleTimeString("zh-CN",{timeZone:"Asia/Shanghai",hour:'2-digit',minute:'2-digit'})}`;
      const result = parseResolvedOutcome(event);
      return { timeRange, result };
    });
    const summary = results
      .map((item) => `${item.timeRange}${item.result === "up" ? "Up won" : item.result === "down" ? "Down won" : "pending"}`)
      .join(" | ");
    console.log(`[Settlement] ${summary}`);
    broadcast("recentResults", { results });
  } catch (e) { console.error(`[Settlement] request failed:`, (e as Error).message); }
}

// -- Window switch -----------------------------------------------
let subscribedWindow = 0;
let stopped = false;
let switchTimer:    ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function disconnectWindowStreams(): void {
  const hadMarketFeed = !!marketWs || wsStatus.market;
  const hadChainlinkFeed = !!chainlinkWs || wsStatus.chainlink;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (marketPingTimer) {
    clearInterval(marketPingTimer);
    marketPingTimer = null;
  }
  if (marketRenderTimer) {
    clearInterval(marketRenderTimer);
    marketRenderTimer = null;
  }
  if (marketValidationTimer) {
    clearInterval(marketValidationTimer);
    marketValidationTimer = null;
  }
  if (marketWs) {
    marketWs.removeAllListeners("close");
    marketWs.close();
    marketWs = null;
  }
  if (chainlinkWs) {
    chainlinkWs.removeAllListeners("close");
    chainlinkWs.close();
    chainlinkWs = null;
  }
  if (wsStatus.market || wsStatus.chainlink) {
    wsStatus.market = false;
    wsStatus.chainlink = false;
    broadcastWsStatus();
  }
  if (hadMarketFeed) broadcast("marketDown", {});
  if (hadChainlinkFeed) broadcast("chainlinkDown", {});
}

function clearWindowRuntimeState(): void {
  state.bids.clear();
  state.asks.clear();
  state.bestBid = "-";
  state.bestAsk = "-";
  state.lastPrice = "-";
  state.lastSide = "";
  state.priceToBeat = null;
  state.currentPrice = null;
  state.binanceOffset = null;
  state.coinbaseOffset = null;
  state.updatedAt = Date.now();
  marketBestReady = false;
  marketValidationMismatchStreak = 0;
  bestBidAskPausedUntil = 0;
  strategyRuntime.positionsReady = !PROXY_ADDRESS;
  resetStrategyRuntime();
  broadcastState();
}

function getCurrentWindowStart(now = Date.now()): number {
  const sec = activeMarket.periodSeconds;
  return Math.floor(now / 1000 / sec) * sec;
}

// -- Multi-symbol / multi-period market switch -------------------------
// pre-switch checks (against the **target market's** current window):
//   1. current position = 0
//   2. current open orders = 0
//   3. strategy runtime = IDLE
// note: positions/open orders in the old market are allowed to remain - 5m/15m markets auto-settle at expiry
async function switchMarket(targetKey: MarketKey): Promise<{ ok: boolean; reason?: string }> {
  if (targetKey === activeMarket.key) return { ok: true };
  if (!MARKETS[targetKey]) return { ok: false, reason: "unknown market" };

  // check 1: current market position is 0
  const upHas = (positions.localSize[state.upTokenId] || 0) > 0 || (positions.apiSize[state.upTokenId] || 0) > 0;
  const downHas = (positions.localSize[state.downTokenId] || 0) > 0 || (positions.apiSize[state.downTokenId] || 0) > 0;
  if (upHas || downHas) {
    return { ok: false, reason: "holding a position, please close it before switching" };
  }

  // check 2: current market has no open orders
  const hasOpenOrder = [...activeConditionOrders.values()].some(
    (c) => c.assetId === state.upTokenId || c.assetId === state.downTokenId
  );
  if (hasOpenOrder) {
    return { ok: false, reason: "there are open orders, please cancel them first" };
  }

  // check 3: the strategy state machine must be idle
  if (strategyRuntime.state !== "IDLE") {
    return { ok: false, reason: `strategy is running (${strategyRuntime.state}), please wait for it to finish` };
  }

  console.log(`[System.Market] switching ${activeMarket.key} -> ${targetKey}`);

  // close the market-bound WS (market/chainlink/binance/coinbase)
  // keep the user WS, CLOB client, and USDC monitoring
  disconnectWindowStreams();
  if (binanceWs) {
    binanceWs.removeAllListeners("close");
    binanceWs.close();
    binanceWs = null;
    wsStatus.binance = false;
  }
  if (coinbaseWs) {
    coinbaseWs.removeAllListeners("close");
    coinbaseWs.close();
    coinbaseWs = null;
    wsStatus.coinbase = false;
  }
  broadcastWsStatus();

  // clear window-level runtime state + historical price / klines
  clearWindowRuntimeState();
  state.priceHistory.length = 0;
  state.binanceHistory.length = 0;
  state.coinbaseHistory.length = 0;
  state.kline1m.length = 0;
  state.kline5m.length = 0;
  pendingTradeMeta.clear();
  positions.lastTradeAt = null; // the old market's fill time is no longer relevant
  subscribedWindow = 0;

  // switch activeMarket and persist
  activeMarket = MARKETS[targetKey];
  setFairProbMarket(activeMarket.symbol, activeMarket.period); // sync to the fair-prob table
  setDiffExtremesMarket(activeMarket.symbol, activeMarket.period); // sync to the diff-extremes table
  // when the current market has no table, the relevant strategies (p series, etc.) auto no-op even if enabled
  saveActiveMarketKey(targetKey);

  // restart the 4 upstream WS (user is left untouched)
  startBinanceWs();
  startCoinbaseWs();
  await advanceToLiveWindow(getCurrentWindowStart());

  broadcast("marketSwitched", { key: activeMarket.key, displayName: activeMarket.displayName });
  broadcastState();
  console.log(`[System.Market] switch complete -> ${activeMarket.displayName}`);
  return { ok: true };
}

async function advanceToLiveWindow(targetWindowStart: number): Promise<void> {
  const switchStartedAt = Date.now();
  let attempt = 0;
  let clearedExpiredWindow = false;
  while (!stopped) {
    const desiredWindow = Math.max(targetWindowStart, getCurrentWindowStart());
    if (!clearedExpiredWindow && desiredWindow > subscribedWindow) {
      disconnectWindowStreams();
      clearWindowRuntimeState();
      clearedExpiredWindow = true;
    }
    const subscribeStartedAt = Date.now();
    await subscribeWindow(desiredWindow);
    if (subscribedWindow === desiredWindow) {
      // summarize window-switch info: elapsed + offset + open price
      const fmtTs = (ts: number) => new Date(ts * 1000).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
      const cost = Date.now() - switchStartedAt;
      const binOff = state.binanceOffset;
      const cbOff = state.coinbaseOffset;
      const open = state.priceToBeat;
      const parts: string[] = [];
      if (binOff != null) parts.push(`Binance:${binOff >= 0 ? "+" : ""}${binOff.toFixed(2)}`);
      if (cbOff != null) parts.push(`Coinbase:${cbOff >= 0 ? "+" : ""}${cbOff.toFixed(2)}`);
      if (open != null) parts.push(`open:${open.toFixed(0)}`);
      const tail = parts.length ? `（${parts.join(" ")}）` : "";
      console.log(`[System.Window] ✓ switch ${fmtTs(subscribedWindow)} -> ${fmtTs(desiredWindow)} elapsed ${cost}ms${tail}`);
      return;
    }

    const delay = Math.min(1000 * Math.max(++attempt, 1), 5000);
    console.warn(`[System.Window] switch retry windowStart=${desiredWindow} continuing in ${delay}ms`);
    await new Promise(r => setTimeout(r, delay));
  }
}

function scheduleNextWindow(windowEnd: number): void {
  if (switchTimer) clearTimeout(switchTimer);
  const msUntilEnd = windowEnd * 1000 - Date.now();
  switchTimer = setTimeout(async () => {
    if (stopped) return;
    await advanceToLiveWindow(windowEnd);
  }, Math.max(0, msUntilEnd));
}

async function subscribeWindow(windowStart: number): Promise<void> {
  const startedAt = Date.now();
  const info = await fetchMarket(windowStart);
  if (!info) {
    broadcast("error", { message: `market not found windowStart=${windowStart}` });
    console.warn(`[System.Window] subscribe failed windowStart=${windowStart} elapsed:${Date.now() - startedAt}ms`);
    return;
  }

  const isNewWindow = subscribedWindow !== windowStart;
  const prevWindowStart = subscribedWindow;
  subscribedWindow = windowStart;

  const slug = `${activeMarket.slugPrefix}-${info.windowStart}`;
  state.windowStart = info.windowStart; state.windowEnd   = info.windowEnd;
  state.upTokenId   = info.upTokenId;   state.downTokenId = info.downTokenId;
  state.conditionId = info.conditionId; state.slug        = slug;
  // pre-fetch tickSize (BTC 5m fixed at 0.01, also async-validate via API)
  getCachedTickSize(info.upTokenId);
  getCachedTickSize(info.downTokenId);
  state.bids.clear(); state.asks.clear();
  state.bestBid = "-"; state.bestAsk = "-";
  state.lastPrice = "-"; state.lastSide = "";
  state.binanceOffset = null;
  state.coinbaseOffset = null;
  state.updatedAt = Date.now();
  lastBestBidAskTimestamp = 0;
  marketBestReady = false;
  bestBidAskPausedUntil = 0;
  marketValidationMismatchStreak = 0;
  marketReconnectPending = false;

  if (isNewWindow) {
    if (prevWindowStart > 0) fetchRecentResults(windowStart);
    state.priceToBeat = null; state.currentPrice = null;
    strategyRuntime.positionsReady = !PROXY_ADDRESS;
    clearAllPresigned();
    resetStrategyRuntime(`switching to window ${windowStart}`);
    rememberTokenSymbol(info.upTokenId, activeMarket.symbol);
    rememberTokenSymbol(info.downTokenId, activeMarket.symbol);
    prunePositionCaches([info.upTokenId, info.downTokenId]);
    positions.localSize[info.upTokenId]     = 0;
    positions.localSize[info.downTokenId]   = 0;
    positions.apiSize[info.upTokenId]       = 0;
    positions.apiSize[info.downTokenId]     = 0;
    positions.apiVerified[info.upTokenId]   = false;
    positions.apiVerified[info.downTokenId] = false;
    // window switch: cancel all GTC take-profit resting orders and clear the local conditional order list
    for (const cond of activeConditionOrders.values()) {
      if (cond.kind === "tp" && cond.polymarketOrderId) {
        void cancelTakeProfitOrder(cond.polymarketOrderId);
      }
    }
    activeConditionOrders.clear();
    broadcastConditionOrders();
    // window switch: cancel all strategy limit orders (the same window already settled, orders are void but cancel anyway to be safe)
    for (const order of strategyLimitOrders.values()) {
      if (order.windowStart !== windowStart) {
        void cancelStrategyLimitOrder(order.orderID, "window switch");
      }
    }
    // clear the "already placed" markers, the new window can trigger again
    strategyLimitWindowMark.clear();
    const thisWindow = info.windowStart;
    const tryFetch = () => {
      if (stopped || subscribedWindow !== thisWindow) return;
      fetchCryptoPrice(info.eventStartTime, info.endDate).then(() => {
        if (state.priceToBeat == null && !stopped && subscribedWindow === thisWindow) setTimeout(tryFetch, 1000);
        else broadcastState();
      });
    };
    tryFetch();
    syncPositionsFromApi().then(() => broadcastState());
  }

  broadcast("window", {
    windowStart: info.windowStart, windowEnd: info.windowEnd,
    conditionId: info.conditionId, upTokenId: info.upTokenId, downTokenId: info.downTokenId,
  });

  if (marketWs || chainlinkWs || reconnectTimer) {
    disconnectWindowStreams();
  }

  marketWs = startMarketWs(info.windowStart, info.upTokenId, info.downTokenId, () => {
    if (stopped) return;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      void subscribeWindow(Math.max(subscribedWindow, getCurrentWindowStart()));
    }, 1000);
  });

  const eventSlug = `${activeMarket.slugPrefix}-${info.windowStart}`;
  let clAttempt = 0;
  const reconnectChainlink = () => {
    if (stopped) return;
    const delay = backoffDelay(clAttempt);
    clAttempt++;
    setTimeout(() => {
      if (stopped) return;
      chainlinkWs = startChainlinkWs(subscribedWindow, `${activeMarket.slugPrefix}-${subscribedWindow}`, reconnectChainlink, clAttempt);
    }, delay);
  };
  chainlinkWs = startChainlinkWs(info.windowStart, eventSlug, reconnectChainlink, 0);

  scheduleNextWindow(info.windowEnd);
}

// -- Claim query ------------------------------------------------
interface ClaimPosition {
  conditionId: string; title: string; currentValue: number; size: number;
}
let claimablePositions: ClaimPosition[] = [];
let claimableTotal = 0;
let claimCycleTimer: ReturnType<typeof setTimeout> | null = null;
let claimCycleRunning = false;
let claimNextCheckAt = 0;
let claimCooldownUntil = 0;       // Claim cooldown deadline timestamp (5 minutes)

function broadcastClaimCooldown(running = false): void {
  broadcast("claimCooldown", {
    running,
    nextCheckAt: claimNextCheckAt,
    cooldownUntil: claimCooldownUntil,
  });
}

function resetClaimableState(): void {
  claimablePositions = [];
  claimableTotal = 0;
  broadcast("claimable", { total: claimableTotal, positions: claimablePositions });
}

async function syncClaimable(options: { clearOnError?: boolean } = {}): Promise<boolean> {
  if (!PROXY_ADDRESS) {
    resetClaimableState();
    return false;
  }
  try {
    const pos = await fetch(
      `https://data-api.polymarket.com/positions?user=${PROXY_ADDRESS}&sizeThreshold=.01&redeemable=true&limit=100&offset=0`
    ).then(r => r.json()) as Array<{ conditionId: string; title: string; currentValue: number; size: number; curPrice: number; asset?: string; oppositeAsset?: string; outcome?: string; oppositeOutcome?: string }>;

    // keep only winning positions (currentValue > 0 means that outcome is the winning direction)
    // then verify with on-chain asset balance to filter out already-redeemed ones (data-api cache lag)
    const winners = pos.filter(p => p.currentValue > 0 && p.asset);
    let verified: typeof pos = winners;
    if (winners.length) {
      try {
        const provider = getClaimProvider();
        const ctfRO = new ethers.Contract(getContractConfig(137).conditionalTokens, [
          'function balanceOfBatch(address[] accounts, uint256[] ids) view returns (uint256[])',
        ], provider);
        const ids = winners.map(p => BigInt(p.asset!));
        const accounts = ids.map(() => PROXY_ADDRESS);
        const balances: bigint[] = await ctfRO.balanceOfBatch(accounts, ids);
        verified = winners.filter((_, i) => balances[i] > 0n);
      } catch (e) {
        console.warn(`[Claim] on-chain verification failed (falling back to currentValue>0): ${e instanceof Error ? e.message : e}`);
      }
    }

    claimablePositions = verified.map(p => ({
      conditionId: p.conditionId, title: p.title, currentValue: p.currentValue, size: p.size,
    }));
    claimableTotal = claimablePositions.reduce((s, p) => s + p.currentValue, 0);
    broadcast("claimable", { total: claimableTotal, positions: claimablePositions });
    return true;
  } catch (err) {
    if (options.clearOnError) resetClaimableState();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Claim] failed to query claimable positions: ${msg}`);
    return false;
  }
}

function scheduleClaimCycle(delayMs = CLAIM_CYCLE_DELAY_MS): void {
  if (stopped || !PROXY_ADDRESS) {
    if (claimCycleTimer) clearTimeout(claimCycleTimer);
    claimCycleTimer = null;
    claimNextCheckAt = 0;
    broadcastClaimCooldown(false);
    return;
  }
  if (claimCycleTimer) clearTimeout(claimCycleTimer);
  claimNextCheckAt = Date.now() + Math.max(0, delayMs);
  broadcastClaimCooldown(false);
  claimCycleTimer = setTimeout(() => {
    void autoClaimCycle().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Claim.Auto] background claim exception: ${msg}`);
      scheduleClaimCycle();
    });
  }, Math.max(0, delayMs));
}

async function autoClaimCycle(): Promise<void> {
  if (stopped || claimCycleRunning || claimInProgress) {
    // the previous claim round hasn't finished (on-chain tx incomplete), skip this round, do not reset cooldown, the next timer will trigger it
    if (claimInProgress && !claimCycleRunning) {
      console.log(`[Claim.Auto] previous claim still in progress, skipping this loop`);
      scheduleClaimCycle();
    }
    return;
  }
  // when auto Claim is unchecked, do not query, do not broadcast, just clear the state
  if (!strategyConfig.autoClaimEnabled || !PRIVATE_KEY) {
    resetClaimableState();
    return;
  }
  claimCycleRunning = true;
  claimNextCheckAt = 0;
  broadcastClaimCooldown(true);
  try {
    // Step 1: query the latest claimable amount every loop (high-frequency refresh, frontend shows it in real time)
    const synced = await syncClaimable({ clearOnError: true });
    if (!synced) return;
    if (!claimablePositions.length || claimInProgress) return;

    // cooldown period: do not execute again within 5 minutes of the last claim
    if (Date.now() < claimCooldownUntil) return;

    // strategy busy: entering/holding/exiting -> do not trigger a Safe transaction (avoids nonce conflicts)
    const strategyBusy = strategyRuntime.state !== "IDLE"
                      && strategyRuntime.state !== "DONE"
                      && strategyRuntime.state !== "SCANNING";
    if (strategyBusy || hasOpenPosition()) {
      console.log(`[Claim.Auto] strategy busy (${strategyRuntime.state}), skipping this time`);
      return;
    }

    // Step 3: refresh the amount once more before claiming (ensures conditionId and quantity are latest)
    await syncClaimable({ clearOnError: false });
    if (!claimablePositions.length) return;

    console.log(`[Claim.Auto] detected ${claimablePositions.length} claimable positions, starting background claim...`);
    claimCooldownUntil = Date.now() + CLAIM_COOLDOWN_MS;  // enter cooldown (regardless of success or failure below)
    await runClaim({ refreshAfter: false });
  } finally {
    claimCycleRunning = false;
    scheduleClaimCycle();
  }
}

// -- Claim core logic -------------------------------------------
let claimInProgress = false;

// reuse the provider: avoids new-ing one on every claim, which triggers a network-probe loop
// use the full Network object + staticNetwork object version, skipping the eth_chainId probe at startup
const CLAIM_NETWORK = new ethers.Network("polygon", 137);
let cachedClaimProvider: ethers.JsonRpcProvider | null = null;

// tickSize cache: fetched once per market at startup/window switch, reused fixed within the same window
// extreme price levels (upPct > 99%) cause Polymarket to switch to finer precision; if an order fails here, call invalidateTickSize to force a refresh
const DEFAULT_TICK_SIZE = "0.01" as const;
type TickSize = Awaited<ReturnType<ClobClient["getTickSize"]>>;
const tickSizeCache = new Map<string, TickSize>();

/** synchronously returns the cached value; if not cached returns the default 0.01 and fetches asynchronously (fills the cache immediately after the first call) */
function getCachedTickSize(tokenId: string): TickSize {
  const cached = tickSizeCache.get(tokenId);
  if (cached !== undefined) return cached;
  // not cached: use the default value as a stopgap, fill the real value asynchronously (subscribeWindow pre-fetches at startup)
  tickSizeCache.set(tokenId, DEFAULT_TICK_SIZE as TickSize);
  void refreshTickSize(tokenId);
  return DEFAULT_TICK_SIZE as TickSize;
}

async function refreshTickSize(tokenId: string): Promise<TickSize> {
  if (!clobClient) return DEFAULT_TICK_SIZE as TickSize;
  try {
    const real = await clobClient.getTickSize(tokenId);
    const prev = tickSizeCache.get(tokenId);
    tickSizeCache.set(tokenId, real);
    if (prev !== undefined && String(prev) !== String(real)) {
      console.warn(`[Price.Precision] ${tokenId.slice(-8)} changed: ${prev} -> ${real}`);
    }
    return real;
  } catch {
    return tickSizeCache.get(tokenId) ?? (DEFAULT_TICK_SIZE as TickSize);
  }
}

/** force refresh on order failure (one-sided market precision switch scenario) */
async function invalidateTickSize(tokenId: string): Promise<TickSize> {
  tickSizeCache.delete(tokenId);
  return refreshTickSize(tokenId);
}
function getClaimProvider(): ethers.JsonRpcProvider {
  if (!cachedClaimProvider) {
    cachedClaimProvider = new ethers.JsonRpcProvider(
      "https://polygon-bor-rpc.publicnode.com",
      CLAIM_NETWORK,
      { staticNetwork: CLAIM_NETWORK },
    );
    // silence RPC error (the original console.error would repeatedly print the same error)
    cachedClaimProvider.on("error", () => { /* handled by caller */ });
  }
  return cachedClaimProvider;
}

async function runClaim(options: { refreshAfter?: boolean } = {}): Promise<{ title: string; txHash?: string; error?: string }[]> {
  const { refreshAfter = true } = options;
  if (!PROXY_ADDRESS || !PRIVATE_KEY) return [];
  if (claimInProgress) return [];
  if (!claimablePositions.length) return [];
  claimInProgress = true;

  const contracts = getContractConfig(137);
  const USDC_ADDR = contracts.collateral;  // pUSD after the V2 upgrade
  // V2: redeem goes through CtfCollateralAdapter (internally burns CTF token then auto-wraps into pUSD)
  const ADAPTER = "0xADa100874d00e3331D00F2007a9c336a65009718";
  const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

  const provider = getClaimProvider();
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const ctfIface = new ethers.Interface([
    "function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)",
    "function setApprovalForAll(address operator, bool approved)",
    "function isApprovedForAll(address account, address operator) view returns (bool)",
  ]);
  const safeIface = new ethers.Interface([
    "function nonce() view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)",
    "function execTransaction(address to, uint256 value, bytes calldata data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address payable refundReceiver, bytes memory signatures) public payable returns (bool)",
  ]);
  const safe = new ethers.Contract(PROXY_ADDRESS, safeIface, wallet);

  const snapshot = [...claimablePositions];
  const total = snapshot.length;
  const results: { title: string; txHash?: string; error?: string }[] = [];
  console.log(`[Claim] starting claim, ${total} total: ${snapshot.map(p => p.title).join(' | ')}`);
  // maintain nonce locally, to avoid safe.nonce() reading a stale value when the RPC node hasn't synced in time
  let localNonce: bigint = await safe.nonce();
  console.log(`[Claim] starting nonce:${localNonce}`);

  // check and initiate one-time approval: the Safe must approve the Adapter to transferFrom CTF tokens to complete redeem
  // not approving will throw GS013 (inner call revert: "ERC1155: need operator approval for 3rd party transfers.")
  try {
    const ctfRO = new ethers.Contract(contracts.conditionalTokens, [
      "function isApprovedForAll(address account, address operator) view returns (bool)",
    ], provider);
    const approved: boolean = await ctfRO.isApprovedForAll(PROXY_ADDRESS, ADAPTER);
    if (!approved) {
      console.log(`[Claim] Safe has not approved Adapter, initiating one-time approval first...`);
      const approveCalldata = ctfIface.encodeFunctionData("setApprovalForAll", [ADAPTER, true]);
      const approveTxHash: string = await safe.getTransactionHash(contracts.conditionalTokens, 0, approveCalldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, localNonce);
      const approveSig = await wallet.signMessage(ethers.getBytes(approveTxHash));
      const approveV = parseInt(approveSig.slice(-2), 16) + 4;
      const approveAdjusted = approveSig.slice(0, -2) + approveV.toString(16).padStart(2, '0');
      const approveTx = await safe.execTransaction(contracts.conditionalTokens, 0, approveCalldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, approveAdjusted);
      console.log(`[Claim] approval transaction txHash:${approveTx.hash}, waiting for on-chain confirmation...`);
      const approveReceipt = await Promise.race([
        approveTx.wait(),
        new Promise<null>((_, reject) => setTimeout(() => reject(new Error('approval on-chain wait timeout (30s)')), 30000)),
      ]);
      if (!approveReceipt) throw new Error('approval on-chain wait timeout');
      console.log(`[Claim] ✓ approval succeeded block:${approveReceipt.blockNumber}`);
      localNonce++;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Claim] approval failed, aborting this claim round: ${msg}`);
    claimInProgress = false;
    return [];
  }
  try {
    const CLAIM_TX_INTERVAL_MS = 5000;  // 5-second interval between two transactions
    const CLAIM_MAX_RETRIES = 1;        // retry a single failed transaction once

    for (let i = 0; i < snapshot.length; i++) {
      const p = snapshot[i];
      console.log(`[Claim] (${i+1}/${total}) ${p.title} amount:${p.currentValue.toFixed(2)} conditionId:${p.conditionId}`);
      broadcast("claimProgress", { current: i, total, title: p.title, status: "running" });

      let success = false;
      let lastErr = "";
      for (let attempt = 0; attempt <= CLAIM_MAX_RETRIES; attempt++) {
        try {
          if (attempt > 0) {
            console.log(`[Claim] retry attempt ${attempt}...`);
            await new Promise(r => setTimeout(r, 2000));
            // refresh nonce before retrying (the previous tx may still be unconfirmed in the mempool or already succeeded)
            const onChainNonce: bigint = await safe.nonce();
            if (onChainNonce > localNonce) localNonce = onChainNonce;
          }
          const calldata = ctfIface.encodeFunctionData("redeemPositions", [
            USDC_ADDR, ZERO_BYTES32, p.conditionId, [1, 2]
          ]);
          const nonce = localNonce;
          console.log(`[Claim] nonce:${nonce} building transaction...`);
          const txHash = await safe.getTransactionHash(ADAPTER, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, nonce);
          const sig = await wallet.signMessage(ethers.getBytes(txHash));
          const v = parseInt(sig.slice(-2), 16) + 4;
          const adjustedSig = sig.slice(0, -2) + v.toString(16).padStart(2, '0');
          console.log(`[Claim] sending transaction...`);
          const tx = await safe.execTransaction(ADAPTER, 0, calldata, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, adjustedSig);
          console.log(`[Claim] waiting for on-chain txHash:${tx.hash}`);
          const receipt = await Promise.race([
            tx.wait(),
            new Promise<null>((_, reject) => setTimeout(() => reject(new Error('on-chain wait timeout (30s)')), 30000)),
          ]);
          if (!receipt) throw new Error('on-chain wait timeout (30s)');
          console.log(`[Claim] ✓ success ${p.title} -> ${tx.hash}`);
          results.push({ title: p.title, txHash: tx.hash });
          localNonce++;  // local nonce auto-increment
          broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "success" });
          success = true;
          break;
        } catch (err) {
          lastErr = err instanceof Error ? err.message : String(err);
          console.error(`[Claim] ✗ attempt ${attempt + 1} failed ${p.title}: ${lastErr}`);
        }
      }
      if (!success) {
        results.push({ title: p.title, error: lastErr });
        broadcast("claimProgress", { current: i + 1, total, title: p.title, status: "error", error: lastErr });
      }

      // interval between two transactions (no wait after the last one)
      if (i < snapshot.length - 1) {
        await new Promise(r => setTimeout(r, CLAIM_TX_INTERVAL_MS));
      }
    }
  } finally {
    claimInProgress = false;
  }
  console.log(`[Claim] complete success:${results.filter(r=>r.txHash).length} failed:${results.filter(r=>r.error).length}`);
  if (refreshAfter) {
    await syncClaimable({ clearOnError: true });
    await syncUsdcBalance();
    broadcastState();
  }
  return results;
}

function extractOrderError(result: unknown): string {
  const obj = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const candidates = [obj.error, obj.message, obj.errorMsg, obj.errorMessage];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function fmtOrderField(value: unknown): string {
  if (value == null || value === "") return "-";
  return String(value);
}

function getDecimalPlaces(value: string | number): number {
  const text = String(value);
  const [, decimals = ""] = text.split(".");
  return decimals.replace(/0+$/, "").length;
}

function floorToDecimals(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.floor((value + Number.EPSILON) * factor) / factor;
}

function isOrderWindowStale(now = Date.now()): boolean {
  if (!state.windowStart || !state.windowEnd) return true;
  if (state.windowEnd * 1000 <= now) return true;
  return state.windowStart < getCurrentWindowStart(now);
}

function getStrategyRemainingSeconds(now = Date.now()): number {
  return state.windowEnd ? state.windowEnd - Math.floor(now / 1000) : 0;
}

function buildTickContext(rem: number, upPct: number | null, dnPct: number | null, diff: number | null, now: number): import("./strategies/types.js").StrategyTickContext {
  // diffBps: a cross-symbol generic percentage (per ten-thousand, i.e. bps).
  // BTC ~$70000, ETH ~$3000, SOL ~$200, the dollar diff magnitude varies hugely; using bps lets thresholds be reused across markets.
  let diffBps: number | null = null;
  if (diff != null && state.priceToBeat != null && state.priceToBeat > 0) {
    diffBps = Math.round((diff / state.priceToBeat) * 10000 * 100) / 100;
  }
  return {
    rem, upPct, dnPct, diff, diffBps, volPct: state.volPct, now,
    prevUpPct: strategyRuntime.prevUpPct,
    kline1m: state.kline1m,
    kline5m: state.kline5m,
    marketHoursOnly: strategyConfig.marketHoursOnly,
  };
}

// whether the current activeMarket is in the strategy's declared supportedMarkets list
// not declared / empty array = supports all markets (backward compatible with old strategies)
function isStrategySupportedHere(s: import("./strategies/types.js").IStrategy): boolean {
  const desc = s.getDescription();
  const list = desc.supportedMarkets;
  if (!list || list.length === 0) return true;
  return list.includes(activeMarket.key);
}

function checkEntry(ctx: import("./strategies/types.js").StrategyTickContext): { strategy: StrategyKey; dir: StrategyDirection } | null {
  for (const s of getAllStrategies()) {
    if (!strategyConfig.enabled[s.key]) continue;
    if (!isStrategySupportedHere(s)) continue; // does not support the current market, skip
    const signal = s.checkEntry(ctx);
    if (signal) return { strategy: s.key, dir: signal.direction };
  }
  return null;
}

function checkExit(ctx: import("./strategies/types.js").StrategyTickContext): import("./strategies/types.js").ExitSignal {
  const key = strategyRuntime.activeStrategy;
  const direction = strategyRuntime.direction;
  if (!key || !direction) return null;
  const s = getStrategy(key);
  if (!s) return null;
  return s.checkExit(ctx, direction);
}

interface PlaceOrderInput {
  direction: StrategyDirection;
  side: "buy" | "sell";
  amount: number;
  slippage?: number;
  source?: string;
  exitReason?: string;
  roundEntry?: string;
  // conditional orders (only carried on buy, created after the fill triggers)
  stopProfit?: { pctDelta?: number; targetPrice?: number };
  stopLoss?: { pctDelta?: number; diffValue?: number; slippage?: number };
}

interface OrderExecutionResult {
  success: boolean;
  statusCode: number;
  body: Record<string, unknown>;
  errorMessage?: string;
}

async function placeOrder(input: PlaceOrderInput): Promise<OrderExecutionResult> {
  const { direction, side, amount, source = "manual" } = input;
  const slippageVal = typeof input.slippage === "number" && input.slippage >= 0
    ? input.slippage
    : strategyConfig.slippage;
  const orderTag = `[Order:${source}]`;

  if (!direction || !side || !amount || amount <= 0) {
    return { success: false, statusCode: 400, body: { error: "invalid params" }, errorMessage: "invalid params" };
  }
  if (!(await ensureClobClient())) {
    return {
      success: false,
      statusCode: 500,
      body: { error: "CLOB client not initialized, please check POLYMARKET_PRIVATE_KEY" },
      errorMessage: "CLOB client not initialized, please check POLYMARKET_PRIVATE_KEY",
    };
  }
  if (isOrderWindowStale()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "the current market window has expired, waiting to switch to a new window" },
      errorMessage: "the current market window has expired, waiting to switch to a new window",
    };
  }
  if (!isProbabilityReady()) {
    return {
      success: false,
      statusCode: 409,
      body: { error: "order book probability temporarily unavailable, waiting for WS to recover" },
      errorMessage: "order book probability temporarily unavailable, waiting for WS to recover",
    };
  }

  const tokenId = direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) {
    return {
      success: false,
      statusCode: 400,
      body: { error: "the current window market is not ready" },
      errorMessage: "the current window market is not ready",
    };
  }

  // prefer the in-memory order book pushed by Market WS (saves ~200ms HTTP); fall back to GET when stale or not ready
  // note: state.bestBid / state.bestAsk only track the up token (see the Market WS book event filtering upTokenId).
  // binary option identity: up + down = 1 -> down bid = 1 - up ask, down ask = 1 - up bid.
  //
  // fast-path guard: only require the side's price needed by this order to be valid (buy -> ask / sell -> bid),
  // allow the fast path even in a one-sided market (the other side has 0 depth), to avoid unnecessary fallback.
  let bestBid = 0;
  let bestAsk = 0;
  const BOOK_MAX_AGE_MS = 3000;
  const bookAgeMs = lastBestBidAskTimestamp > 0 ? Date.now() - lastBestBidAskTimestamp : Infinity;
  const stateBid = Number(state.bestBid);
  const stateAsk = Number(state.bestAsk);
  // convert to the target token's order book based on the order direction first
  let candidateBid = 0;
  let candidateAsk = 0;
  if (Number.isFinite(stateBid) && Number.isFinite(stateAsk)) {
    if (direction === "up") {
      candidateBid = stateBid;
      candidateAsk = stateAsk;
    } else {
      // down conversion: if the up side is 0, the conversion result 1-0=1 is an unrealistic "full price", treated as invalid
      candidateBid = stateAsk > 0 ? 1 - stateAsk : 0;
      candidateAsk = stateBid > 0 ? 1 - stateBid : 0;
    }
  }
  const neededForSide = side === "buy" ? candidateAsk : candidateBid;
  const wsUsable = marketBestReady && bookAgeMs < BOOK_MAX_AGE_MS && neededForSide > 0;
  if (wsUsable) {
    bestBid = candidateBid;
    bestAsk = candidateAsk;
  } else {
    // fallback: GET on the spot when the WS order book is not ready / stale / the target side's price is missing
    try {
      ({ bestBid, bestAsk } = await fetchBookTopOfBook(tokenId));
      console.log(`${orderTag} WS order book fallback GET (age=${bookAgeMs}ms ready=${marketBestReady} need=${neededForSide}) bid=${bestBid} ask=${bestAsk}`);
    } catch {
      return {
        success: false,
        statusCode: 500,
        body: { error: "unable to fetch order book price" },
        errorMessage: "unable to fetch order book price",
      };
    }
  }
  // buy orders need bestAsk (counterparty's sell price); sell orders need bestBid (counterparty's buy price). In extreme markets the other side may be 0.
  const needed = side === "buy" ? bestAsk : bestBid;
  if (!(needed > 0)) {
    return {
      success: false,
      statusCode: 500,
      body: { error: side === "buy" ? "no sell orders in the book (insufficient depth)" : "no buy orders in the book (insufficient depth)" },
      errorMessage: side === "buy" ? "no sell orders in the book (insufficient depth)" : "no buy orders in the book (insufficient depth)",
    };
  }

  const worstPrice = side === "buy"
    ? Math.min(bestAsk + slippageVal, 0.99)
    : Math.max(bestBid - slippageVal, 0.01);

  try {
    const tickSize = getCachedTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedAmount = floorToDecimals(amount, 2);
    const normalizedWorstPrice = floorToDecimals(worstPrice, priceDecimals);
    const orderDebug = `tickSize:${tickSize} amount:${amount}->${normalizedAmount} worstPrice:${worstPrice}->${normalizedWorstPrice}`;
    if (normalizedAmount <= 0 || normalizedWorstPrice <= 0) {
      console.warn(`${orderTag} params invalid after precision handling ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: "order params invalid after precision handling", bestBid, bestAsk, worstPrice: normalizedWorstPrice },
        errorMessage: "order params invalid after precision handling",
      };
    }

    const marketOrderArgs = { tokenID: tokenId, side: side === "buy" ? Side.BUY : Side.SELL, amount: normalizedAmount, price: normalizedWorstPrice };
    const marketOrderOpts = { tickSize, negRisk: false };
    console.log("[RAW]", `${orderTag} createMarketOrder args:`, JSON.stringify(marketOrderArgs), "opts:", JSON.stringify(marketOrderOpts), "ctx:", JSON.stringify({
      source, direction, side, amount, normalizedAmount, slippageVal, bestBid, bestAsk, worstPrice, normalizedWorstPrice, tokenId, tickSize, priceDecimals, bookAgeMs, marketBestReady,
      exitReason: input.exitReason, roundEntry: input.roundEntry, stopProfit: input.stopProfit, stopLoss: input.stopLoss,
      windowStart: state.windowStart, marketKey: activeMarket.key,
    }));
    const signedOrder = await clobClient!.createMarketOrder(marketOrderArgs, marketOrderOpts);
    console.log("[RAW]", `${orderTag} signedOrder:`, JSON.stringify(signedOrder));
    // -- latency monitoring (1): start timing before this machine initiates postOrder --
    const latencyT0 = Date.now();
    const result = await clobClient!.postOrder(signedOrder, OrderType.FOK);
    const httpMs = Date.now() - latencyT0;  // for log debugging only
    console.log("[RAW]", `${orderTag} postOrder raw result:`, JSON.stringify(result), `HTTP:${httpMs}ms t0:${latencyT0}`);
    const sideZh = side === "buy" ? "buy" : "sell";
    const dirZh = direction === "up" ? "up" : "down";
    const rawStatus = result?.status ?? "unknown";
    const orderError = extractOrderError(result);

    if (result?.status === 400 || orderError) {
      console.warn(`${orderTag} ${activeMarket.displayName} ${sideZh} ${dirZh} ${normalizedAmount} status:${rawStatus} reason:${orderError || "-"} ${orderDebug}`);
      return {
        success: false,
        statusCode: 400,
        body: { error: orderError || `order rejected status=${rawStatus}`, result, bestBid, bestAsk, worstPrice: normalizedWorstPrice },
        errorMessage: orderError || `order rejected status=${rawStatus}`,
      };
    }

    // -- latency monitoring (2): order succeeded, register orderID (if WS already arrived it settles immediately) --
    const orderIdFromResult = typeof result?.orderID === "string" ? result.orderID : "";
    if (rawStatus === "matched" && orderIdFromResult) {
      registerOrderLatencyStart(orderIdFromResult, latencyT0);
    }

    const dirArrow = direction === "up" ? "⬆" : "⬇";
    const okMark = rawStatus === "matched" ? "✓" : "•";
    console.log(`${orderTag} ${okMark} ${dirArrow} ${sideZh} ${dirZh} ${normalizedAmount}@${normalizedWorstPrice} filled=${fmtOrderField(result?.takingAmount)} spent=${fmtOrderField(result?.makingAmount)} orderID=${fmtOid(orderIdFromResult)} HTTP=${httpMs}ms`);
    rememberPendingTradeMeta({
      orderId: typeof result?.orderID === "string" && result.orderID ? result.orderID : undefined,
      ts: Date.now(),
      windowStart: state.windowStart,
      side,
      direction,
      amount: normalizedAmount,
      worstPrice: normalizedWorstPrice,
      source,
      exitReason: input.exitReason,
      roundEntry: input.roundEntry,
      stopProfit: side === "buy" ? input.stopProfit : undefined,
      stopLoss: side === "buy" ? input.stopLoss : undefined,
    });
    if (!(typeof result?.orderID === "string" && result.orderID)) {
      console.warn(`${orderTag} order response missing orderID, the MINED event will degrade to matching by direction/quantity`);
    }
    broadcastState();
    return {
      success: true,
      statusCode: 200,
      body: { success: true, result, bestBid, bestAsk, worstPrice: normalizedWorstPrice },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${orderTag} failed:`, msg);
    return {
      success: false,
      statusCode: 500,
      body: { error: msg },
      errorMessage: msg,
    };
  }
}

async function strategyBuy(direction: StrategyDirection, amount: number): Promise<void> {
  strategyRuntime.posBeforeBuy = getDirectionLocalSize(direction);
  strategyRuntime.actionTs = Date.now();
  strategyRuntime.buyLockUntil = Date.now() + STRAT_BUY_LOCK_MS;
  strategyRuntime.state = "WAIT_FILL";
  broadcastState();

  // read the strategy config's GTC take-profit target price (e.g. d1 = 0.99)
  const stratKey = strategyRuntime.activeStrategy ?? "";
  const stratInstance = stratKey ? getStrategy(stratKey) : undefined;
  const tpPrice = stratInstance?.getMarketTakeProfitPrice?.() ?? null;

  const orderResult = await placeOrder({
    direction,
    side: "buy",
    amount,
    slippage: strategyConfig.slippage,
    source: `strategy${stratKey}`,
    roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
    stopProfit: tpPrice != null && tpPrice > 0 && tpPrice < 1 ? { targetPrice: tpPrice } : undefined,
  });

  if (!orderResult.success) {
    console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] buy failed: ${orderResult.errorMessage || "order failed"}`);
    strategyRuntime.buyLockUntil = 0;
    strategyRuntime.state = "SCANNING";
    strategyRuntime.activeStrategy = null;
    broadcastState();
  }
}

async function strategySell(direction: StrategyDirection, exitReason?: string): Promise<void> {
  const totalPos = getDirectionLocalSize(direction);
  const shares = getSellableShares(direction);
  if (shares <= 0) {
    transitionToDone();
    return;
  }

  strategyRuntime.posBeforeSell = totalPos;
  strategyRuntime.waitVerifyAfterSell = !isDirectionVerified(direction);
  strategyRuntime.actionTs = Date.now();
  strategyRuntime.state = "WAIT_SELL_FILL";
  broadcastState();

  const orderResult = await placeOrder({
    direction,
    side: "sell",
    amount: shares,
    slippage: strategyConfig.slippage,
    source: `strategy${strategyRuntime.activeStrategy ?? ""}`,
    exitReason,
    roundEntry: `${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}`,
  });

  if (!orderResult.success) {
    console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] sell failed: ${orderResult.errorMessage || "order failed"}`);
    strategyRuntime.waitVerifyAfterSell = false;
    strategyRuntime.state = "HOLDING";
    broadcastState();
  }
}

// -- Backtest data collection -------------------------------------
const BACKTEST_STATE_FILE = resolve(__dirname, ".backtest-state.json");

function loadBacktestState(): boolean {
  try {
    if (!existsSync(BACKTEST_STATE_FILE)) return false;  // off by default on first run, enable in the frontend as needed
    const data = JSON.parse(readFileSync(BACKTEST_STATE_FILE, "utf-8"));
    return typeof data.collecting === "boolean" ? data.collecting : false;
  } catch {
    return false;
  }
}

function persistBacktestState(): void {
  try {
    writeFileSync(BACKTEST_STATE_FILE, JSON.stringify({ collecting: backtestCollecting }, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[Backtest] state save failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

let backtestCollecting = loadBacktestState();
let backtestLastTickTs = 0;
let backtestLastCleanupDate = "";
const BACKTEST_RETENTION_DAYS = 30;

// ensure the data directory exists at startup (prevents the first write from failing)
if (backtestCollecting) {
  try { mkdirSync(BACKTEST_DATA_DIR, { recursive: true }); } catch { /* ignore */ }
}

function setBacktestCollecting(enabled: boolean): void {
  backtestCollecting = enabled;
  console.log(`[Backtest] data collection ${enabled ? "enabled" : "disabled"}`);
  persistBacktestState();
  if (enabled) {
    mkdirSync(BACKTEST_DATA_DIR, { recursive: true });
    cleanupOldBacktestFiles();
  }
  broadcastBacktestStatus();
}

function cleanupOldBacktestFiles(): void {
  try {
    if (!existsSync(BACKTEST_DATA_DIR)) return;
    // compatible with three naming schemes: YYYY-MM-DD.jsonl (old BTC 5m) / YYYY-MM-DD-{sym}.jsonl (old multi-symbol 5m) / YYYY-MM-DD-{sym}-{period}.jsonl (new)
    const files = readdirSync(BACKTEST_DATA_DIR).filter((f) => /^\d{4}-\d{2}-\d{2}(-\w+)?(-\w+)?\.jsonl$/.test(f));
    // group by "base date", keep the latest BACKTEST_RETENTION_DAYS days per group
    const byDate = new Map<string, string[]>();
    for (const f of files) {
      const date = f.slice(0, 10);
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(f);
    }
    const dates = [...byDate.keys()].sort();
    if (dates.length <= BACKTEST_RETENTION_DAYS) return;
    const datesToDelete = dates.slice(0, dates.length - BACKTEST_RETENTION_DAYS);
    for (const d of datesToDelete) {
      for (const f of byDate.get(d) || []) {
        try {
          unlinkSync(resolve(BACKTEST_DATA_DIR, f));
          console.log(`[Backtest] cleaned up old data file: ${f}`);
        } catch {}
      }
    }
  } catch (err) {
    console.warn(`[Backtest] failed to clean up old files: ${(err as Error).message}`);
  }
}

function broadcastBacktestStatus(): void {
  broadcast("backtestStatus", { collecting: backtestCollecting });
}

function getBacktestFilePath(): string {
  // BTC 5m keeps the original filename (backward compatible with existing data), others use the -{sym}-{period} suffix
  // naming rule: YYYY-MM-DD.jsonl (old BTC 5m) / YYYY-MM-DD-{sym}-{period}.jsonl (new)
  const sym = activeMarket.symbol;
  const period = activeMarket.period;
  const suffix = (sym === "btc" && period === "5m") ? "" : `-${sym}-${period}`;
  return resolve(BACKTEST_DATA_DIR, `${getCstDateStr()}${suffix}.jsonl`);
}

function backtestAppend(record: Record<string, unknown>): void {
  try {
    appendFileSync(getBacktestFilePath(), JSON.stringify(record) + "\n");
  } catch (err) {
    console.warn(`[Backtest] write failed: ${(err as Error).message}`);
  }
}

function backtestTick(): void {
  if (!backtestCollecting) return;
  const now = Date.now();
  if (now - backtestLastTickTs < 1000) return;

  const snapshot = getProbabilitySnapshot();
  const diff = getStrategyDiff();
  const rem = getStrategyRemainingSeconds(now);
  if (snapshot == null || diff == null || !state.windowStart) return;

  // clean up old files (older than the retention days) on the first write each day
  const todayStr = getCstDateStr();
  if (todayStr !== backtestLastCleanupDate) {
    cleanupOldBacktestFiles();
    backtestLastCleanupDate = todayStr;
  }

  // diff precision based on the current price magnitude (shares the same threshold definition as the frontend priceDecimals)
  // avoids small-price symbols like SOL/XRP/DOGE losing precision due to 2-decimal rounding (e.g. SOL diff -0.0712 -> -0.07)
  const dec = priceDecimals(state.priceToBeat);
  const factor = Math.pow(10, dec);

  backtestAppend({
    type: "tick",
    ts: now,
    symbol: activeMarket.symbol,
    period: activeMarket.period,
    windowStart: state.windowStart,
    diff: Math.round(diff * factor) / factor,
    upPct: snapshot.upPct,
    rem,
  });
  backtestLastTickTs = now;
}


// event-driven strategy scheduler: multiple events in a short time trigger only one tick
let strategyTickScheduled = false;
let strategyTickLastRunTs = 0;
const STRATEGY_TICK_MIN_GAP_MS = 10;  // minimum interval between consecutive ticks (prevents storms)

function scheduleStrategyTick(): void {
  if (strategyTickScheduled) return;
  strategyTickScheduled = true;
  const now = Date.now();
  const elapsed = now - strategyTickLastRunTs;
  if (elapsed >= STRATEGY_TICK_MIN_GAP_MS) {
    setImmediate(() => {
      strategyTickScheduled = false;
      strategyTickLastRunTs = Date.now();
      runStrategyTick();
    });
  } else {
    setTimeout(() => {
      strategyTickScheduled = false;
      strategyTickLastRunTs = Date.now();
      runStrategyTick();
    }, STRATEGY_TICK_MIN_GAP_MS - elapsed);
  }
}

function runStrategyTick(): void {
  const snapshot = getProbabilitySnapshot();
  const upPct = snapshot?.upPct ?? null;
  const dnPct = snapshot?.dnPct ?? null;
  const diff = getStrategyDiff();
  const now = Date.now();
  const rem = getStrategyRemainingSeconds(now);
  const currentPosition = getDirectionLocalSize(strategyRuntime.direction);
  const ctx = buildTickContext(rem, upPct, dnPct, diff, now);
  const finalize = () => {
    strategyRuntime.prevUpPct = upPct;
    // notify all strategies that have finalizeTick (record historical data like lastDiff, regardless of whether enabled)
    for (const s of getAllStrategies()) {
      if ("finalizeTick" in s && typeof (s as any).finalizeTick === "function") {
        (s as any).finalizeTick(diff);
      }
    }
  };

  if (isOrderWindowStale(now)) {
    finalize();
    return;
  }

  if (!strategyRuntime.positionsReady) {
    finalize();
    return;
  }

  // update the guard state of enabled strategies (cooldown locks, etc.);
  // strategies that are not enabled but declare alwaysComputeData also call computeData (e.g. the s6 factor panel)
  // note: strategies that do not support the current market are skipped entirely, to avoid running computations on the wrong market
  for (const s of getAllStrategies()) {
    if (!isStrategySupportedHere(s)) continue;
    if (strategyConfig.enabled[s.key]) {
      s.updateGuards(ctx);
    } else if (s.alwaysComputeData && typeof s.computeData === "function") {
      s.computeData(ctx);
    }
  }

  // conditional order monitoring: TP/SL tick check (independent of the strategy state machine)
  if (activeConditionOrders.size > 0 && upPct != null && dnPct != null) {
    void checkConditionOrdersTick(upPct, dnPct, diff);
  }

  // limit strategies: first scan pre-sign requirements (async-sign and cache), then run the limit scheduler
  runPresignTick();
  runLimitStrategyTick();

  if (strategyRuntime.cleanupAfterVerify && strategyRuntime.direction) {
    if (!isDirectionVerified(strategyRuntime.direction)) {
      finalize();
      return;
    }
    if (currentPosition < 0.01) {
      strategyRuntime.cleanupAfterVerify = false;
      transitionToDone();
      finalize();
      return;
    }
    strategyRuntime.cleanupAfterVerify = false;
    strategyRuntime.state = "SELLING";
    console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] position calibrated, ${currentPosition.toFixed(2)} remaining, executing liquidation sell`);
    broadcastState();
    void strategySell(strategyRuntime.direction, `calibrated liquidation, ${currentPosition.toFixed(2)} remaining`);
    finalize();
    return;
  }

  if (strategyRuntime.state === "IDLE") {
    if (upPct == null || diff == null) {
      finalize();
      return;
    }
    if (anyStrategyEnabled()) {
      strategyRuntime.state = "SCANNING";
      broadcastState();
    }
    finalize();
    return;
  }

  if (strategyRuntime.state === "SCANNING") {
    if (!anyStrategyEnabled()) {
      strategyRuntime.state = "IDLE";
      broadcastState();
      finalize();
      return;
    }
    if (hasOpenPosition() || hasPendingStrategyBuyLock(now) || upPct == null || dnPct == null || diff == null) {
      finalize();
      return;
    }
    if (strategyRuntime.roundEntryCount >= strategyConfig.maxRoundEntries) {
      finalize();
      return;
    }
    // US Eastern weekend pause: do not enter new entries (positions/TP/SL/Claim are unaffected)
    if (strategyConfig.weekendPause && isUsWeekend()) {
      logWeekendPauseOnce();
      finalize();
      return;
    }
    const entry = checkEntry(ctx);
    if (!entry) {
      finalize();
      return;
    }
    const buyAmount = strategyConfig.amount[entry.strategy];
    if (!hasEnoughUsdcForBuy(buyAmount)) {
      finalize();
      return;
    }
    strategyRuntime.roundEntryCount++;
    strategyRuntime.activeStrategy = entry.strategy;
    strategyRuntime.direction = entry.dir;
    strategyRuntime.buyAmount = buyAmount;
    strategyRuntime.state = "BUYING";
    console.log(`[Strategy.${entry.strategy}] entry triggered (${strategyRuntime.roundEntryCount}/${strategyConfig.maxRoundEntries}) ${entry.dir === "up" ? "buy up" : "buy down"} amount:${buyAmount}`);
    broadcastState();
    void strategyBuy(entry.dir, buyAmount);
    finalize();
    return;
  }

  if (strategyRuntime.state === "WAIT_FILL") {
    if (hasConfirmedBuyPosition()) {
      strategyRuntime.buyLockUntil = 0;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] buy fill confirmed`);
      // notify the strategy of the buy fill (used for initializing the tracking peak, etc.)
      if (strategyRuntime.activeStrategy && strategyRuntime.direction) {
        const activeStrat = getStrategy(strategyRuntime.activeStrategy);
        if (activeStrat?.onEntryFilled) activeStrat.onEntryFilled(ctx, strategyRuntime.direction);
      }
      broadcastState();
    } else if (now - strategyRuntime.actionTs > WAIT_FILL_TIMEOUT_MS) {
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] buy not confirmed after 10s, entering delayed-confirmation wait`);
      strategyRuntime.state = "RECONCILING_FILL";
      broadcastState();
      finalize();
      return;
    } else {
      finalize();
      return;
    }
  }

  if (strategyRuntime.state === "RECONCILING_FILL") {
    if (hasConfirmedBuyPosition()) {
      strategyRuntime.buyLockUntil = 0;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] delayed confirmation succeeded, resuming position management`);
      if (strategyRuntime.activeStrategy && strategyRuntime.direction) {
        const activeStrat = getStrategy(strategyRuntime.activeStrategy);
        if (activeStrat?.onEntryFilled) activeStrat.onEntryFilled(ctx, strategyRuntime.direction);
      }
      broadcastState();
    } else if (canReleaseUnconfirmedBuy(now)) {
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] over 15s and API confirms no position, resuming scanning`);
      strategyRuntime.state = "SCANNING";
      strategyRuntime.activeStrategy = null;
      strategyRuntime.direction = null;
      strategyRuntime.buyAmount = 0;
      strategyRuntime.posBeforeBuy = 0;
      strategyRuntime.actionTs = 0;
      strategyRuntime.buyLockUntil = 0;
      broadcastState();
      finalize();
      return;
    } else {
      finalize();
      return;
    }
  }

  if (strategyRuntime.state === "HOLDING") {
    if (currentPosition <= 0) {
      transitionToDone();
      finalize();
      return;
    }
    if (upPct == null || dnPct == null || diff == null) {
      finalize();
      return;
    }
    const exit = checkExit(ctx);
    if (exit && strategyRuntime.direction) {
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] ${exit.signal === "tp" ? "TP" : "SL"} triggered: ${exit.reason}`);
      strategyRuntime.state = "SELLING";
      broadcastState();
      void strategySell(strategyRuntime.direction, exit.reason);
    }
    finalize();
    return;
  }

  if (strategyRuntime.state === "WAIT_SELL_FILL") {
    if (currentPosition < strategyRuntime.posBeforeSell - 0.01) {
      if (currentPosition < 0.01) {
        strategyRuntime.waitVerifyAfterSell = false;
        strategyRuntime.cleanupAfterVerify = false;
        console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] sell confirmed, done`);
        transitionToDone();
        finalize();
        return;
      }

      if (strategyRuntime.waitVerifyAfterSell) {
        strategyRuntime.waitVerifyAfterSell = false;
        if (isDirectionVerified(strategyRuntime.direction)) {
          console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] calibrated after sell, ${currentPosition.toFixed(2)} remaining, executing liquidation immediately`);
          strategyRuntime.cleanupAfterVerify = false;
          strategyRuntime.state = "SELLING";
          broadcastState();
          if (strategyRuntime.direction) void strategySell(strategyRuntime.direction, `calibrated liquidation, ${currentPosition.toFixed(2)} remaining`);
          finalize();
          return;
        }
        strategyRuntime.cleanupAfterVerify = true;
        strategyRuntime.state = "DONE";
        console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] sell confirmed, waiting for calibration before checking remaining position`);
        broadcastState();
        finalize();
        return;
      }

      strategyRuntime.waitVerifyAfterSell = false;
      strategyRuntime.state = "HOLDING";
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] sell confirmed, ${currentPosition.toFixed(2)} remaining, continuing to process`);
      broadcastState();
      finalize();
      return;
    }

    if (now - strategyRuntime.actionTs > WAIT_FILL_TIMEOUT_MS) {
      console.log(`[Strategy.${strategyRuntime.activeStrategy ?? ""}] sell timeout, back to holding`);
      strategyRuntime.waitVerifyAfterSell = false;
      strategyRuntime.state = "HOLDING";
      broadcastState();
    }
    finalize();
    return;
  }

  finalize();
}

function buildApiStatePayload(includeHistory: boolean = true): Record<string, unknown> {
  return {
    ...buildStatePayload(includeHistory),
    wsStatus,
    claimable: {
      total: claimableTotal,
      positions: claimablePositions,
    },
    claimCooldown: {
      running: claimCycleRunning || claimInProgress,
      nextCheckAt: claimNextCheckAt,
      cooldownUntil: claimCooldownUntil,
    },
  };
}

// derived metrics for the monitor page (today's PnL/win rate/trade count), same algorithm as the TG push
// also returns todayClosedCount + todayWins so the monitor page can correctly weight-aggregate (averaging win rates directly would distort)
function computeTodayPnlMetrics(): {
  todayPnl: number | null;
  todayCount: number | null;
  todayWinRate: number | null;
  todayClosedCount: number | null;
  todayWins: number | null;
} {
  if (!pmPnlManager.isInitialized()) {
    return { todayPnl: null, todayCount: null, todayWinRate: null, todayClosedCount: null, todayWins: null };
  }
  const todaySec = Math.floor(getCstDayStartMs() / 1000);
  const snap = pmPnlManager.computeSnapshot(todaySec);
  return {
    todayPnl: snap.netPnl,
    todayCount: snap.positions,
    todayWinRate: snap.closedPositions > 0 ? snap.wins / snap.closedPositions : null,
    todayClosedCount: snap.closedPositions,
    todayWins: snap.wins,
  };
}

app.get("/api/state", (req, res) => {
  // ?lite=1 skips priceHistory/binanceHistory/coinbaseHistory (for the monitor page, saves ~98% traffic)
  const lite = req.query.lite === "1" || req.query.lite === "true";
  const payload = buildApiStatePayload(!lite) as Record<string, unknown>;
  // inject the derived metrics the monitor page needs (same source data as the TG push)
  payload.pmPnl = computeTodayPnlMetrics();
  res.json(payload);
});

app.get("/api/version", (_req, res) => {
  res.json({ version: APP_VERSION });
});

app.get("/api/market/list", (_req, res) => {
  res.json({
    active: activeMarket.key,
    activeSymbol: activeMarket.symbol,
    activePeriod: activeMarket.period,
    symbols: ALL_SYMBOLS,
    periods: ALL_PERIODS,
    markets: Object.values(MARKETS).map(m => ({
      key: m.key, symbol: m.symbol, period: m.period, displayName: m.displayName,
    })),
  });
});

app.post("/api/market/switch", async (req, res) => {
  // supports two input forms: { key: "btc-15m" } or { symbol: "btc", period: "15m" }
  const body = (req.body as Record<string, unknown> | undefined) || {};
  let key = String(body.key || "");
  if (!key && body.symbol && body.period) key = `${body.symbol}-${body.period}`;
  if (!isValidKey(key)) {
    return res.status(400).json({ ok: false, reason: `unknown market: ${key}` });
  }
  const result = await switchMarket(key);
  if (!result.ok) return res.status(409).json(result);
  res.json(result);
});

app.get("/api/strategy/descriptions", (_req, res) => {
  res.json(getAllDescriptions());
});

app.get("/api/backtest/status", (_req, res) => {
  res.json({ collecting: backtestCollecting });
});

app.post("/api/backtest/toggle", (_req, res) => {
  setBacktestCollecting(!backtestCollecting);
  res.json({ collecting: backtestCollecting });
});

// manually trigger a full PmPnl refresh (frontend refresh button)
app.post("/api/pmpnl/refresh", async (_req, res) => {
  const ok = await pmPnlManager.fetchAll();
  pmPnlNextRefreshAt = Date.now() + PMPNL_REFRESH_INTERVAL_MS;
  broadcastPmPnl();
  res.json({ ok, nextRefreshAt: pmPnlNextRefreshAt, lastRefreshAt: pmPnlManager.getLastRefreshAt() });
});

app.post("/api/strategy/config", (req, res) => {
  const prevAutoClaim = strategyConfig.autoClaimEnabled;
  const { config, error } = applyStrategyConfigUpdate(strategyConfig, req.body);
  if (!config) {
    res.status(400).json({ error: error || "config error" });
    return;
  }

  strategyConfig = config;
  savePersistedStrategyConfig(config);
  // immediately inject the tunable params into all strategy instances (avoids the next fill reading stale values)
  for (const s of getAllStrategies()) applyTunableParamsToStrategy(s);
  const configSummary = ALL_STRATEGY_KEYS.map((k) => `${k}:${config.enabled[k] ? "on" : "off"}(${config.amount[k]})`).join(" ");
  console.log(`[Strategy.Config] updated ${configSummary} maxRound:${config.maxRoundEntries} active in the current process`);
  broadcastState();

  // autoClaimEnabled from off -> on: immediately trigger a query and claim check
  if (!prevAutoClaim && config.autoClaimEnabled) {
    scheduleClaimCycle(0);
  }

  res.json({ success: true, strategyConfig });
});

// read/write the manual order config (amount / slippage / TP-SL)
app.get("/api/manual/config", (_req, res) => {
  res.json({ manualConfig });
});
app.post("/api/manual/config", (req, res) => {
  const err = applyManualConfigUpdate(req.body);
  if (err) { res.status(400).json({ error: err }); return; }
  broadcast("manualConfig", { manualConfig });
  res.json({ success: true, manualConfig });
});

// -- REST: order endpoint ----------------------------------------
// manually cancel a conditional order
app.post("/api/cond/cancel", async (req, res) => {
  const { id } = req.body as { id: string };
  const cond = activeConditionOrders.get(id);
  if (!cond) {
    res.status(404).json({ error: "conditional order does not exist or has ended" });
    return;
  }
  if (cond.kind === "tp" && cond.polymarketOrderId) {
    const ok = await cancelTakeProfitOrder(cond.polymarketOrderId);
    if (!ok) {
      // cancel failed: keep it in the list, mark failed, the user can retry manually or wait for pollGtcOrderStatus fallback
      cond.status = "failed";
      cond.failReason = "cancel resting order failed, please retry";
      broadcastConditionOrders();
      res.status(500).json({ error: "Polymarket cancel resting order failed", polymarketCancelFailed: true });
      return;
    }
  }
  cond.status = "canceled";
  activeConditionOrders.delete(cond.id);
  broadcastConditionOrders();
  res.json({ success: true });
});

// one-click clear all active conditional orders (includes TP GTC and local SL)
app.post("/api/cond/cancel-all", async (_req, res) => {
  const all = [...activeConditionOrders.values()];
  if (all.length === 0) {
    res.json({ success: true, count: 0, failed: 0 });
    return;
  }
  let canceled = 0;
  let failed = 0;
  for (const cond of all) {
    if (cond.kind === "tp" && cond.polymarketOrderId) {
      const ok = await cancelTakeProfitOrder(cond.polymarketOrderId);
      if (!ok) {
        // keep the failed ones for the user / polling fallback to handle
        cond.status = "failed";
        cond.failReason = "cancel resting order failed during full clear";
        failed++;
        continue;
      }
    }
    cond.status = "canceled";
    activeConditionOrders.delete(cond.id);
    canceled++;
  }
  broadcastConditionOrders();
  console.log(`[Cond] manual full clear: ${canceled} succeeded, ${failed} failed (failed ones kept for retry)`);
  res.json({ success: failed === 0, count: canceled, failed });
});

// in-memory limit order list (shared by manual + strategy)
interface ManualLimitOrder {
  orderID: string;
  direction: StrategyDirection;
  side: "buy" | "sell";
  size: number;
  price: number;
  createdAt: number;
  /** source: manual=manual, strategy:t8=strategy resting order */
  source?: string;
  /** the window it belongs to (used for window management of strategy resting orders) */
  windowStart?: number;
  /** filled shares (partial-fill tracking) */
  filledSize?: number;
}
const manualLimitOrders = new Map<string, ManualLimitOrder>();

// -- Strategy limit order scheduling (limit/both strategies like t8) --------------
//
// design:
//   - each strategy has at most 1 active resting order (per window)
//   - place only once per window (after cancel, do not re-place, wait for the next window)
//   - on cancel failure, enter the fallback retry queue (every 5s, up to 12 times or 90s or window end)

interface StrategyLimitOrder {
  orderID: string;
  strategyKey: string;
  /** "buy" = entry buy order (default); "sell" = take-profit sell order placed after the fill */
  side: "buy" | "sell";
  direction: StrategyDirection;
  /** the token id at resting time, ensures placing TP after MINED uses the same window's token (state has changed after window switch) */
  tokenId: string;
  price: number;
  shares: number;
  /** cumulative filled shares confirmed at the match layer (MATCHED push, not on-chain) */
  matchedSize: number;
  /** cumulative filled shares confirmed on-chain (MINED push + on-chain calibration) */
  filledSize: number;
  /** total TP sell shares already placed for on-chain-confirmed shares (avoids placing TP twice for the same shares) */
  takeProfitPlacedSize: number;
  windowStart: number;
  createdAt: number;
  /** on cancel, found already matched/filled, keep the order awaiting MINED handling (avoids stratOrder being deleted prematurely causing TP/SL loss) */
  pendingMined?: boolean;
}

// the currently active strategy limit order (at most 1 per strategy)
const strategyLimitOrders = new Map<string, StrategyLimitOrder>();
// the set of strategies that have "already attempted to place" within this window (implements "place only once per window")
const strategyLimitWindowMark = new Set<string>();  // value: `${strategyKey}:${windowStart}`
// orderIDs with cancel in progress (prevents the same tick / poll from concurrently invoking the same cancel API)
const cancelInFlight = new Set<string>();

// -- GTC order status WS+REST dual confirmation mechanism --------------------
// purpose: resolve the blind spot of "called the order/cancel HTTP but the actual status did not change"
// flow: after postOrder/cancelOrder register pending -> wait for WS event_type:order push or getOrder fallback after 8 seconds
// market FOK does not use this path (the HTTP response already contains the full result, it will not stay on the book)
const ORDER_CONFIRM_TIMEOUT_MS = 3000;
// the middle of the order ID is elided for easier terminal reading (raw log still keeps the full ID)
function fmtOid(id: string | undefined | null): string {
  if (!id || typeof id !== "string") return "-";
  if (id.length <= 16) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}

// order context (for logging only, prints price / direction / side / size on cancel/confirm)
type OrderCtx = { price?: number; direction?: string; side?: string; size?: number };
function fmtOrderCtx(ctx: OrderCtx | undefined): string {
  if (!ctx) return "";
  const parts: string[] = [];
  if (ctx.side) parts.push(`side=${ctx.side}`);
  if (ctx.direction) parts.push(`dir=${ctx.direction}`);
  if (typeof ctx.size === "number") parts.push(`size=${ctx.size}`);
  if (typeof ctx.price === "number") parts.push(`price=${ctx.price}`);
  return parts.length ? ` [${parts.join(" ")}]` : "";
}
function getOrderCtxFromMaps(orderID: string): OrderCtx | undefined {
  const so = strategyLimitOrders.get(orderID);
  if (so) return { price: so.price, direction: so.direction, side: so.side, size: so.shares };
  const mo = manualLimitOrders.get(orderID);
  if (mo) return { price: mo.price, direction: mo.direction, side: mo.side, size: mo.size };
  return undefined;
}
type PendingOrderConfirm = {
  orderID: string;
  source: string;          // caller identifier, for logging only
  ctx?: OrderCtx;
  t0: number;
  resolved: boolean;       // set to true after WS arrives, the timeout branch will skip the query
  timer: ReturnType<typeof setTimeout>;
};
type PendingCancelConfirm = {
  orderID: string;
  reason: string;
  ctx?: OrderCtx;
  t0: number;
  resolved: boolean;
  timer: ReturnType<typeof setTimeout>;
  rounds: number;          // how many rounds of 8s fallback have elapsed (avoids an infinite loop when both WS+REST are down)
};
const CANCEL_MAX_ROUNDS = 3;  // at most 3 rounds = ~24 seconds cumulative + 3 cancelOrderImmediate (each with 3 internal HTTP retries)
// when verifyCancelViaRest re-cancels, pass through the current round to cancelOrderImmediate -> registerCancelConfirm
const cancelRoundOverride = new Map<string, number>();
const pendingOrderConfirm = new Map<string, PendingOrderConfirm>();
const pendingCancelConfirm = new Map<string, PendingCancelConfirm>();
// scenario where WS arrives before the HTTP response: cache the WS signal first, on register check for a hit and do not start the timer
type EarlyWsCache = { ts: number; reason: string };
const earlyOrderConfirmCache = new Map<string, EarlyWsCache>();
const earlyCancelConfirmCache = new Map<string, EarlyWsCache>();
const EARLY_WS_CACHE_TTL_MS = 30_000;
function rememberEarlyWs(map: Map<string, EarlyWsCache>, orderID: string, reason: string): void {
  if (!orderID) return;
  map.set(orderID, { ts: Date.now(), reason });
  setTimeout(() => map.delete(orderID), EARLY_WS_CACHE_TTL_MS).unref?.();
}

function registerOrderConfirm(orderID: string, source: string, ctx?: OrderCtx): void {
  if (!orderID) return;
  // an existing one (same orderID registered twice, should not happen) -> clear the old one
  const old = pendingOrderConfirm.get(orderID);
  if (old) clearTimeout(old.timer);
  // WS arrived before the HTTP response? accept immediately
  const early = earlyOrderConfirmCache.get(orderID);
  if (early) {
    earlyOrderConfirmCache.delete(orderID);
    console.log(`[Trade.Confirm] WS arrived first orderID=${fmtOid(orderID)}${fmtOrderCtx(ctx)} reason:${early.reason} (source=${source})`);
    return;
  }
  const entry: PendingOrderConfirm = {
    orderID, source, ctx, t0: Date.now(), resolved: false,
    timer: setTimeout(() => verifyOrderViaRest(orderID), ORDER_CONFIRM_TIMEOUT_MS),
  };
  pendingOrderConfirm.set(orderID, entry);
}
function resolveOrderConfirm(orderID: string, reason: string): void {
  const entry = pendingOrderConfirm.get(orderID);
  if (!entry) return;
  entry.resolved = true;
  clearTimeout(entry.timer);
  pendingOrderConfirm.delete(orderID);
  console.log(`[Trade.Confirm] WS confirmed orderID=${fmtOid(orderID)}${fmtOrderCtx(entry.ctx)} elapsed:${Date.now() - entry.t0}ms reason:${reason} (source=${entry.source})`);
}
async function verifyOrderViaRest(orderID: string): Promise<void> {
  const entry = pendingOrderConfirm.get(orderID);
  if (!entry || entry.resolved) return;
  pendingOrderConfirm.delete(orderID);
  console.warn(`[Trade.Confirm] ${ORDER_CONFIRM_TIMEOUT_MS}ms no WS PLACEMENT/MATCHED received, getOrder fallback orderID=${fmtOid(orderID)} source=${entry.source}`);
  if (!clobClient) {
    console.warn(`[Trade.Confirm] CLOB not initialized, cannot fall back`);
    return;
  }
  try {
    const order = await clobClient.getOrder(orderID);
    console.log("[RAW]", `[Trade.Confirm] getOrder fallback orderID=${orderID} raw:`, JSON.stringify(order));
    const status = typeof order?.status === "string" ? order.status.toUpperCase() : "";
    if (status === "LIVE" || status === "MATCHED" || status === "FILLED") {
      console.log(`[Trade.Confirm] ✓ getOrder confirmed exists orderID=${fmtOid(orderID)} status=${status} (just slow WS)`);
    } else if (status === "CANCELED") {
      console.warn(`[Trade.Confirm] ⚠ orderID=${fmtOid(orderID)} was cancelled (abnormal state, clearing local)`);
      strategyLimitOrders.delete(orderID);
      manualLimitOrders.delete(orderID);
      clearPendingTradeMetaByOrderId(orderID);
      broadcastManualLimitOrders();
    } else {
      console.warn(`[Trade.Confirm] ⚠ orderID=${fmtOid(orderID)} unknown status status=${status || "(empty)"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|404|does not exist/i.test(msg)) {
      console.warn(`[Trade.Confirm] ❌ getOrder 404 -> order not placed orderID=${fmtOid(orderID)} source=${entry.source} (clearing local, not auto re-placing)`);
      strategyLimitOrders.delete(orderID);
      manualLimitOrders.delete(orderID);
      clearPendingTradeMetaByOrderId(orderID);
      broadcastManualLimitOrders();
    } else {
      console.warn(`[Trade.Confirm] getOrder failed orderID=${fmtOid(orderID)}:`, msg);
    }
  }
}

function registerCancelConfirm(orderID: string, reason: string, ctx?: OrderCtx, rounds: number = 0): void {
  if (!orderID) return;
  const old = pendingCancelConfirm.get(orderID);
  if (old) clearTimeout(old.timer);
  // ctx prefers the input arg, otherwise reverse-look it up from the in-memory Map (the Map is usually still there on cancel)
  const finalCtx = ctx ?? getOrderCtxFromMaps(orderID);
  // WS CANCELED arrived before the HTTP response? accept immediately
  const early = earlyCancelConfirmCache.get(orderID);
  if (early) {
    earlyCancelConfirmCache.delete(orderID);
    console.log(`[Trade.Cancel] WS arrived first orderID=${fmtOid(orderID)}${fmtOrderCtx(finalCtx)} reason:${early.reason} (call reason=${reason})`);
    return;
  }
  const entry: PendingCancelConfirm = {
    orderID, reason, ctx: finalCtx, t0: Date.now(), resolved: false, rounds,
    timer: setTimeout(() => verifyCancelViaRest(orderID), ORDER_CONFIRM_TIMEOUT_MS),
  };
  pendingCancelConfirm.set(orderID, entry);
}
function resolveCancelConfirm(orderID: string, reason: string): void {
  const entry = pendingCancelConfirm.get(orderID);
  if (!entry) return;
  entry.resolved = true;
  clearTimeout(entry.timer);
  pendingCancelConfirm.delete(orderID);
  console.log(`[Trade.Cancel] WS confirmed cancel orderID=${fmtOid(orderID)}${fmtOrderCtx(entry.ctx)} elapsed:${Date.now() - entry.t0}ms reason:${reason}`);
}
async function verifyCancelViaRest(orderID: string): Promise<void> {
  const entry = pendingCancelConfirm.get(orderID);
  if (!entry || entry.resolved) return;
  pendingCancelConfirm.delete(orderID);
  const round = entry.rounds + 1;
  console.warn(`[Trade.Cancel] ${ORDER_CONFIRM_TIMEOUT_MS}ms no WS CANCELED received, getOrder fallback orderID=${fmtOid(orderID)} round=${round}/${CANCEL_MAX_ROUNDS}`);
  if (!clobClient) return;
  try {
    const order = await clobClient.getOrder(orderID);
    console.log("[RAW]", `[Trade.Cancel] getOrder fallback orderID=${orderID} raw:`, JSON.stringify(order));
    const status = typeof order?.status === "string" ? order.status.toUpperCase() : "";
    if (status === "CANCELED" || status === "CANCELLED") {
      console.log(`[Trade.Cancel] ✓ orderID=${fmtOid(orderID)} already ${status} (clearing local)`);
      strategyLimitOrders.delete(orderID);
      manualLimitOrders.delete(orderID);
      clearPendingTradeMetaByOrderId(orderID);
      broadcastManualLimitOrders();
    } else if (status === "FILLED") {
      // fully filled: keep the order awaiting MINED handling (avoids stratOrder being deleted prematurely causing TP/SL loss)
      const so = strategyLimitOrders.get(orderID);
      if (so) so.pendingMined = true;
      console.log(`[Trade.Cancel] ⚠ orderID=${fmtOid(orderID)} already FILLED, keeping order awaiting MINED handling`);
    } else if (status === "LIVE" || status === "MATCHED") {
      if (round >= CANCEL_MAX_ROUNDS) {
        console.error(`[Trade.Cancel] ❌ orderID=${fmtOid(orderID)} still ${status}, reached max re-cancel rounds ${CANCEL_MAX_ROUNDS}, giving up and force-clearing local (PM actual status may still be LIVE, needs manual check or wait for window-switch cleanup)`);
        strategyLimitOrders.delete(orderID);
        manualLimitOrders.delete(orderID);
        broadcastManualLimitOrders();
      } else {
        console.warn(`[Trade.Cancel] ⚠ orderID=${fmtOid(orderID)} still ${status}, triggering re-cancel round=${round}`);
        // pass through round to the next register (cancelOrderImmediate will call registerCancelConfirm)
        // use a temp variable so cancelOrderImmediate knows the current round
        cancelRoundOverride.set(orderID, round);
        void cancelOrderImmediate(orderID);
      }
    } else {
      console.warn(`[Trade.Cancel] ⚠ orderID=${fmtOid(orderID)} unknown status status=${status || "(empty)"}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found|404|does not exist/i.test(msg)) {
      console.log(`[Trade.Cancel] ✓ orderID=${fmtOid(orderID)} REST 404 (no longer exists, treated as cancelled)`);
      strategyLimitOrders.delete(orderID);
      manualLimitOrders.delete(orderID);
      clearPendingTradeMetaByOrderId(orderID);
      broadcastManualLimitOrders();
    } else {
      console.warn(`[Trade.Cancel] getOrder failed orderID=${fmtOid(orderID)}:`, msg);
    }
  }
}

type CancelResult = "canceled" | "soft_matched" | "soft_other" | false;
/** immediately attempt to cancel (retry 3 times), returns a tri-state
 *  parses the cancelOrder response structure: { canceled: [orderID...], not_canceled: { orderID: reason } }
 *  - canceled contains the target -> "canceled" (really cancelled)
 *  - not_canceled reason contains filled/matched -> "soft_matched" (actually filled, caller must keep the order awaiting MINED)
 *  - not_canceled reason contains not.?found/already, etc. -> "soft_other" (order does not exist, can be cleaned up)
 *  - otherwise -> returns false when retries are exhausted
 */
async function cancelOrderImmediate(orderID: string, reason: string = "immediate"): Promise<CancelResult> {
  if (!clobClient) return false;
  // register WS fallback confirmation; if this is a re-cancel from verifyCancelViaRest, pass through the current round
  const overrideRound = cancelRoundOverride.get(orderID);
  if (overrideRound !== undefined) cancelRoundOverride.delete(orderID);
  registerCancelConfirm(orderID, reason, undefined, overrideRound ?? 0);
  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = Date.now();
    console.log("[RAW]", `[Trade.Cancel] cancelOrder args:`, JSON.stringify({ orderID }), `attempt:${attempt}/3 reason:${reason}`);
    try {
      const result = await clobClient.cancelOrder({ orderID });
      const dt = Date.now() - t0;
      console.log("[RAW]", `[Trade.Cancel] cancelOrder raw result:`, JSON.stringify(result), `HTTP:${dt}ms attempt:${attempt}`);
      const canceledList = Array.isArray((result as any)?.canceled) ? (result as any).canceled as string[] : [];
      const notCanceled = (result as any)?.not_canceled;
      const wasCanceled = canceledList.includes(orderID);
      const ncReason = notCanceled && typeof notCanceled === "object" ? String((notCanceled as Record<string, unknown>)[orderID] ?? "") : "";
      if (wasCanceled) {
        // HTTP confirmed success, but the WS fallback is still kept (so verifyCancelViaRest does not double-handle when the WS actually arrives)
        return "canceled";
      }
      if (ncReason) {
        // matched/filled takes priority: also classified as soft_matched when the reason also contains already
        if (/filled|matched/i.test(ncReason)) {
          console.log(`[Trade.Cancel] orderID=${fmtOid(orderID)} not_canceled already filled (keeping order awaiting MINED): ${ncReason}`);
          resolveCancelConfirm(orderID, "HTTP not_canceled soft success (matched)");
          return "soft_matched";
        }
        if (/not.?found|does not exist|already/i.test(ncReason)) {
          console.log(`[Trade.Cancel] orderID=${fmtOid(orderID)} not_canceled order does not exist: ${ncReason}`);
          resolveCancelConfirm(orderID, "HTTP not_canceled soft success (not_found)");
          return "soft_other";
        }
        console.warn(`[Trade.Cancel] orderID=${fmtOid(orderID)} not_canceled reason needs retry: ${ncReason}`);
      } else {
        console.warn(`[Trade.Cancel] orderID=${fmtOid(orderID)} response has neither a canceled hit nor a not_canceled reason, retrying`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const dt = Date.now() - t0;
      console.log("[RAW]", `[Trade.Cancel] cancelOrder threw attempt:${attempt}/3 HTTP:${dt}ms err:`, msg);
      // the throw path cannot distinguish matched/canceled, conservatively classify as soft_other (does not affect the fix goal -- matched goes through the HTTP response path, not the throw path)
      if (/not found|does not exist|already/i.test(msg)) {
        resolveCancelConfirm(orderID, "HTTP threw not found");
        return "soft_other";
      }
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

/**
 * cancel a strategy limit order (unified entry point)
 * - first cancel: event-driven call (instant)
 * - after failure: 1-second poll auto-retry (pollLimitOrderCancellations)
 * - if the strategy changes its mind during retry (checkCancelOrder=false) -> auto-stop
 * - after cancel succeeds: delete stratOrder + clear mark (if the strategy allows re-placing)
 */
async function cancelStrategyLimitOrder(orderID: string, reason: string): Promise<void> {
  // prevent concurrent cancels of the same orderID (event-driven + polling may collide)
  if (cancelInFlight.has(orderID)) return;
  cancelInFlight.add(orderID);
  const stratOrder = strategyLimitOrders.get(orderID);
  const tag = stratOrder?.strategyKey ?? "?";
  let result: CancelResult = false;
  try {
    result = await cancelOrderImmediate(orderID);
  } finally {
    cancelInFlight.delete(orderID);
  }
  if (result === "canceled" || result === "soft_other") {
    // really cancelled / order no longer exists: clear local
    strategyLimitOrders.delete(orderID);
    manualLimitOrders.delete(orderID);
    broadcastManualLimitOrders();
    if (stratOrder && stratOrder.side === "buy") {
      const stratInstance = getStrategy(stratOrder.strategyKey);
      if (stratInstance?.limitAllowReplaceAfterCancel) {
        strategyLimitWindowMark.delete(`${stratOrder.strategyKey}:${stratOrder.windowStart}`);
        console.log(`[Strategy.${tag}] re-placing allowed after cancel, window mark cleared`);
      }
    }
    console.log(`[Strategy.${tag}] ✖ cancel succeeded orderID=${fmtOid(orderID)} reason: ${reason}`);
  } else if (result === "soft_matched") {
    // hit a fill during cancel: keep the order awaiting MINED to trigger TP/SL placement (fixes the bug where stratOrder was deleted prematurely leaving the position exposed)
    if (stratOrder) stratOrder.pendingMined = true;
    console.log(`[Strategy.${tag}] ⚠ already filled during cancel orderID=${fmtOid(orderID)} keeping order awaiting MINED handling reason: ${reason}`);
  } else {
    // do not enqueue, pollLimitOrderCancellations 1-second poll auto-retries
    console.warn(`[Strategy.${tag}] ⚠ cancel failed, will auto-retry via polling orderID=${fmtOid(orderID)} reason: ${reason}`);
  }
}

/**
 * limit order cancel polling (every 1 second)
 *
 * logic: scan all active stratOrders, the strategy says cancel + the order is still there -> call cancel
 * - order not in strategyLimitOrders = already successfully cancelled, auto-skip
 * - strategy checkCancelOrder=false (condition bounced back) = let the order keep resting, do not cancel
 * - cancel succeeds -> delete + the next loop no longer iterates it
 * - cancel fails -> retry after 1 second (no limit, naturally terminated by the strategy's intent)
 */
async function pollLimitOrderCancellations(): Promise<void> {
  if (strategyLimitOrders.size === 0) return;
  const snapshot = getProbabilitySnapshot();
  const upPct = snapshot?.upPct ?? null;
  const dnPct = snapshot?.dnPct ?? null;
  const diff = getStrategyDiff();
  const now = Date.now();
  const rem = getStrategyRemainingSeconds(now);
  const ctx = buildTickContext(rem, upPct, dnPct, diff, now);

  const currentWs = getCurrentWindowStart();
  for (const stratOrder of [...strategyLimitOrders.values()]) {
    if (cancelInFlight.has(stratOrder.orderID)) continue;
    // order already filled awaiting MINED handling: no longer cancel, no longer trigger any action (wait for MINED to place TP/SL + clean up)
    if (stratOrder.pendingMined) continue;
    // cross-window residual -> force cancel (applies to both buy/sell, the position has settled and is meaningless)
    if (stratOrder.windowStart !== currentWs) {
      void cancelStrategyLimitOrder(stratOrder.orderID, "window expired");
      continue;
    }
    if (stratOrder.side !== "buy") continue;  // sell (TP) is managed by the cond system within the current window, does not participate in strategy checkCancelOrder
    // strategy disabled -> force cancel
    if (!strategyConfig.enabled[stratOrder.strategyKey]) {
      void cancelStrategyLimitOrder(stratOrder.orderID, "strategy disabled");
      continue;
    }
    const strat = getStrategy(stratOrder.strategyKey);
    if (!strat?.checkCancelOrder) continue;
    const runtime = {
      direction: stratOrder.direction,
      price: stratOrder.price,
      shares: stratOrder.shares,
      filledSize: stratOrder.filledSize,
      windowStart: stratOrder.windowStart,
    };
    if (strat.checkCancelOrder(ctx, runtime)) {
      void cancelStrategyLimitOrder(stratOrder.orderID, "polling cancel");
    }
  }
}

// -- Pre-sign infrastructure (generic) --------------------------------------
// strategies declare requirements via getPresignRequest, the server async-creates and caches the signed package when rem in [remMin, remMax]
// async-createOrder caches the signature package in the background; on trigger placeStrategyLimitOrder prefers the cache
// skipping signing latency. Conservatively no retry on failure, falls back to live-signing when the cache is empty.

interface PresignedPack {
  strategyKey: string;
  direction: StrategyDirection;
  windowStart: number;
  tokenId: string;
  price: number;
  shares: number;
  signed: unknown;          // the signature package returned by clobClient.createOrder, type determined by the SDK
}

/** key = `${strategyKey}:${windowStart}:${direction}` */
const strategyPresigned = new Map<string, PresignedPack>();
/** the set of keys currently being signed, to avoid duplicate triggers within the same tick */
const presignInflight = new Set<string>();

function presignKey(strategyKey: string, ws: number, direction: StrategyDirection): string {
  return `${strategyKey}:${ws}:${direction}`;
}

/** clear all pre-sign caches on window switch (the old window's tokenId is no longer valid) */
function clearAllPresigned(): void {
  if (strategyPresigned.size === 0 && presignInflight.size === 0) return;
  console.log(`[Strategy.Presign] cleared ${strategyPresigned.size} cached pre-sign packages (window switch)`);
  strategyPresigned.clear();
  presignInflight.clear();
}

async function presignOne(
  strategyKey: string,
  direction: StrategyDirection,
  price: number,
  shares: number,
  ws: number,
): Promise<void> {
  const key = presignKey(strategyKey, ws, direction);
  if (presignInflight.has(key)) return;
  if (strategyPresigned.has(key)) return;
  if (!(await ensureClobClient())) return;
  const tokenId = direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) return;
  // the window may have already switched
  if (getCurrentWindowStart() !== ws) return;

  presignInflight.add(key);
  const startedAt = Date.now();
  try {
    const tickSize = getCachedTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedSize = floorToDecimals(shares, 2);
    const normalizedPrice = floorToDecimals(price, priceDecimals);
    if (normalizedSize < 5 || normalizedPrice <= 0) {
      console.warn(`[Strategy.Presign.${strategyKey}] params invalid size=${normalizedSize} price=${normalizedPrice}`);
      return;
    }
    const signed = await clobClient!.createOrder(
      { tokenID: tokenId, side: Side.BUY, price: normalizedPrice, size: normalizedSize },
      { tickSize, negRisk: false },
    );
    // check the window again after signing (it may have switched during the async period)
    if (getCurrentWindowStart() !== ws) {
      console.log(`[Strategy.Presign.${strategyKey}] ${direction} signed but window switched, discarding`);
      return;
    }
    strategyPresigned.set(key, {
      strategyKey,
      direction,
      windowStart: ws,
      tokenId,
      price: normalizedPrice,
      shares: normalizedSize,
      signed,
    });
    console.log(`[Strategy.Presign.${strategyKey}] ${direction} signed size=${normalizedSize} price=${normalizedPrice} elapsed ${Date.now() - startedAt}ms`);
  } catch (err) {
    // conservative: no retry on failure, falls back when the cache is empty on trigger
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Strategy.Presign.${strategyKey}] ${direction} signing failed (conservatively no retry): ${msg}`);
  } finally {
    presignInflight.delete(key);
  }
}

/** called every tick: scan all strategies' pre-sign requirements, async-sign when the timing is right (does not block the tick) */
function runPresignTick(): void {
  const ws = getCurrentWindowStart();
  if (!ws) return;
  const rem = getStrategyRemainingSeconds(Date.now());

  for (const s of getAllStrategies()) {
    if (!isStrategySupportedHere(s)) continue;
    if (!strategyConfig.enabled[s.key]) continue;
    if (!s.getPresignRequest) continue;
    const req = s.getPresignRequest();
    if (!req) continue;
    if (rem < req.remMin || rem > req.remMax) continue;

    for (const direction of req.directions) {
      const key = presignKey(s.key, ws, direction);
      if (strategyPresigned.has(key) || presignInflight.has(key)) continue;
      // async-sign, do not await
      void presignOne(s.key, direction, req.price, req.shares, ws);
    }
  }
}

/** strategy limit order (place a GTC order by the strategy signal) */
async function placeStrategyLimitOrder(
  strategyKey: string,
  signal: { direction: StrategyDirection; price: number; shares: number },
): Promise<void> {
  if (!(await ensureClobClient())) return;
  const tokenId = signal.direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) {
    console.warn(`[Strategy.${strategyKey}] current window not ready, skipping resting order`);
    return;
  }
  try {
    const tickSize = getCachedTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedSize = floorToDecimals(signal.shares, 2);
    const normalizedPrice = floorToDecimals(signal.price, priceDecimals);
    if (normalizedSize < 5 || normalizedPrice <= 0) {
      console.warn(`[Strategy.${strategyKey}] params invalid size=${normalizedSize} price=${normalizedPrice}`);
      return;
    }

    // prefer the pre-sign cache: on hit skip createOrder (saves ~200ms signing latency)
    // only use it when direction + tokenId + price + shares all match, otherwise live-sign
    const ws = getCurrentWindowStart();
    const pkey = presignKey(strategyKey, ws, signal.direction);
    const cached = strategyPresigned.get(pkey);
    let signed;
    let usedPresign = false;
    const createOrderArgs = { tokenID: tokenId, side: Side.BUY, price: normalizedPrice, size: normalizedSize };
    const createOrderOpts = { tickSize, negRisk: false };
    console.log("[RAW]", `[Strategy.${strategyKey}] placeStrategyLimitOrder ctx:`, JSON.stringify({
      strategyKey, signal, normalizedSize, normalizedPrice, tickSize, priceDecimals,
      tokenId, windowStart: ws, presignCacheKey: pkey, presignHit: !!cached,
    }), "createOrder args:", JSON.stringify(createOrderArgs), "opts:", JSON.stringify(createOrderOpts));
    if (
      cached &&
      cached.tokenId === tokenId &&
      cached.price === normalizedPrice &&
      cached.shares === normalizedSize
    ) {
      signed = cached.signed as Awaited<ReturnType<NonNullable<typeof clobClient>["createOrder"]>>;
      usedPresign = true;
      strategyPresigned.delete(pkey);
      // the other direction's pre-sign package will not be used again within the same window after trigger, clear it immediately to save memory
      const otherDir: StrategyDirection = signal.direction === "up" ? "down" : "up";
      strategyPresigned.delete(presignKey(strategyKey, ws, otherDir));
    } else {
      signed = await clobClient!.createOrder(createOrderArgs, createOrderOpts);
    }
    console.log("[RAW]", `[Strategy.${strategyKey}] signedOrder:`, JSON.stringify(signed));
    const postT0 = Date.now();
    const result = await clobClient!.postOrder(signed, OrderType.GTC);
    const postHttpMs = Date.now() - postT0;
    console.log("[RAW]", `[Strategy.${strategyKey}] postOrder GTC raw result:`, JSON.stringify(result), `HTTP:${postHttpMs}ms t0:${postT0}`);
    const orderID = typeof result?.orderID === "string" ? result.orderID : "";
    if (!orderID) {
      const errMsg = typeof result?.error === "string" ? result.error : "response has no orderID";
      console.warn(`[Strategy.${strategyKey}] resting order failed: ${errMsg}`);
      return;
    }
    const order: StrategyLimitOrder = {
      orderID,
      strategyKey,
      side: "buy",
      direction: signal.direction,
      tokenId,
      price: normalizedPrice,
      shares: normalizedSize,
      matchedSize: 0,
      filledSize: 0,
      takeProfitPlacedSize: 0,
      windowStart: ws,
      createdAt: Date.now(),
    };
    strategyLimitOrders.set(orderID, order);
    // also stuff into manualLimitOrders so the frontend can see it
    manualLimitOrders.set(orderID, {
      orderID,
      direction: signal.direction,
      side: "buy",
      size: normalizedSize,
      price: normalizedPrice,
      createdAt: order.createdAt,
      source: `strategy:${strategyKey}`,
      windowStart: ws,
      filledSize: 0,
    });
    // write pendingTradeMeta: after the MINED event hits, source is used to call notifyTradeForPnl,
    // so the real PnL panel attributes this fill to the corresponding strategy (otherwise it falls to "manual")
    rememberPendingTradeMeta({
      orderId: orderID,
      ts: order.createdAt,
      windowStart: ws,
      side: "buy",
      direction: signal.direction,
      amount: normalizedSize,
      worstPrice: normalizedPrice,
      source: `strategy${strategyKey}`,
    });
    broadcastManualLimitOrders();
    strategyLimitWindowMark.add(`${strategyKey}:${ws}`);
    console.log(`[Strategy.${strategyKey}] ➕ ${signal.direction === "up" ? "⬆" : "⬇"} resting order buy ${signal.direction === "up" ? "up" : "down"} ${normalizedSize}@${normalizedPrice} orderID=${fmtOid(orderID)}${usedPresign ? " ⚡presign" : ""}`);
    registerOrderConfirm(orderID, `strategy:${strategyKey}`, {
      side: "buy", direction: signal.direction, size: normalizedSize, price: normalizedPrice,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Strategy.${strategyKey}] resting order exception: ${msg}`);
  }
}

/**
 * strategy take-profit resting order: called after the buy maker order is confirmed filled on-chain, places a same-direction GTC sell order
 *
 * price fixed at 0.10 (10x profit), shares = the newly confirmed fill shares this time (partial fills are accumulated and placed)
 * will not place twice: order.takeProfitPlacedSize accumulates the already-placed amount, ensuring the same shares are placed only once
 */
async function placeStrategyTakeProfitOrder(
  buyOrder: StrategyLimitOrder,
  sellSize: number,
  sellPrice: number,
): Promise<void> {
  if (!(await ensureClobClient())) return;
  if (sellSize < 5) {
    console.warn(`[Strategy.${buyOrder.strategyKey}] TP shares ${sellSize.toFixed(2)} < 5, skipping maker path`);
    return;
  }
  // use the buy order's tokenId at the time (avoids state.upTokenId already being the new window's after a window switch)
  const tokenId = buyOrder.tokenId;
  if (!tokenId) {
    console.warn(`[Strategy.${buyOrder.strategyKey}] TP: buy order missing tokenId, skipping`);
    return;
  }
  // window-switch protection: do not place if the buy order's window has ended (position settled or zeroed)
  const currentWs = getCurrentWindowStart();
  if (buyOrder.windowStart !== currentWs) {
    console.warn(`[Strategy.${buyOrder.strategyKey}] TP: buy order belongs to the previous window (${buyOrder.windowStart} != ${currentWs}), position settled, skipping TP`);
    return;
  }
  try {
    const tickSize = getCachedTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedSize = floorToDecimals(sellSize, 2);
    const normalizedPrice = floorToDecimals(sellPrice, priceDecimals);
    if (normalizedSize < 5 || normalizedPrice <= 0) {
      console.warn(`[Strategy.${buyOrder.strategyKey}] TP params invalid size=${normalizedSize} price=${normalizedPrice}`);
      return;
    }
    const stratTpArgs = { tokenID: tokenId, side: Side.SELL, price: normalizedPrice, size: normalizedSize };
    const stratTpOpts = { tickSize, negRisk: false };
    console.log("[RAW]", `[Strategy.${buyOrder.strategyKey}] TP createOrder args:`, JSON.stringify(stratTpArgs), "opts:", JSON.stringify(stratTpOpts), "ctx:", JSON.stringify({
      buyOrderID: buyOrder.orderID, buyDirection: buyOrder.direction, buyWindow: buyOrder.windowStart,
      sellSize, sellPrice, normalizedSize, normalizedPrice, tickSize, priceDecimals, currentWs,
    }));
    const signed = await clobClient!.createOrder(stratTpArgs, stratTpOpts);
    console.log("[RAW]", `[Strategy.${buyOrder.strategyKey}] TP signedOrder:`, JSON.stringify(signed));
    const stratTpT0 = Date.now();
    const result = await clobClient!.postOrder(signed, OrderType.GTC);
    const stratTpHttpMs = Date.now() - stratTpT0;
    console.log("[RAW]", `[Strategy.${buyOrder.strategyKey}] TP postOrder GTC raw result:`, JSON.stringify(result), `HTTP:${stratTpHttpMs}ms`);
    const orderID = typeof result?.orderID === "string" ? result.orderID : "";
    if (!orderID) {
      const errMsg = typeof result?.error === "string" ? result.error : "response has no orderID";
      console.warn(`[Strategy.${buyOrder.strategyKey}] TP resting order failed: ${errMsg}`);
      return;
    }
    const ws = getCurrentWindowStart();
    const sellOrder: StrategyLimitOrder = {
      orderID,
      strategyKey: buyOrder.strategyKey,
      side: "sell",
      direction: buyOrder.direction,
      tokenId,
      price: normalizedPrice,
      shares: normalizedSize,
      matchedSize: 0,
      filledSize: 0,
      takeProfitPlacedSize: 0,
      windowStart: ws,
      createdAt: Date.now(),
    };
    strategyLimitOrders.set(orderID, sellOrder);
    manualLimitOrders.set(orderID, {
      orderID,
      direction: buyOrder.direction,
      side: "sell",
      size: normalizedSize,
      price: normalizedPrice,
      createdAt: sellOrder.createdAt,
      source: `strategy:${buyOrder.strategyKey}:tp`,
      windowStart: ws,
      filledSize: 0,
    });
    registerOrderConfirm(orderID, `strategy:${buyOrder.strategyKey}:tp`, {
      side: "sell", direction: buyOrder.direction, size: normalizedSize, price: normalizedPrice,
    });
    // write pendingTradeMeta: after the MINED sell event hits, source can be found
    rememberPendingTradeMeta({
      orderId: orderID,
      ts: sellOrder.createdAt,
      windowStart: ws,
      side: "sell",
      direction: buyOrder.direction,
      amount: normalizedSize,
      worstPrice: normalizedPrice,
      source: `strategy${buyOrder.strategyKey}tp`,
    });
    broadcastManualLimitOrders();
    buyOrder.takeProfitPlacedSize += normalizedSize;
    console.log(`[Strategy.${buyOrder.strategyKey}] TP resting order sell ${buyOrder.direction} size=${normalizedSize} price=${normalizedPrice} orderID=${fmtOid(orderID)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Strategy.${buyOrder.strategyKey}] TP resting order exception: ${msg}`);
  }
}

/**
 * limit-strategy TP sell order on-chain confirmation (MINED side=sell):
 * accumulate the sell stratOrder's filledSize, clean up when it reaches shares
 */
function onStrategyTakeProfitMined(
  strategyKey: string,
  direction: StrategyDirection,
  minedSize: number,
): void {
  if (minedSize <= 0) return;
  const candidates = [...strategyLimitOrders.values()].filter(o =>
    o.strategyKey === strategyKey && o.side === "sell" && o.direction === direction
    && o.filledSize < o.shares - 0.01
  );
  if (candidates.length === 0) {
    console.log(`[Strategy.${strategyKey}] TP MINED ${minedSize.toFixed(2)} shares but no matching sell order found`);
    return;
  }
  candidates.sort((a, b) => a.createdAt - b.createdAt);

  let remaining = minedSize;
  for (const order of candidates) {
    if (remaining <= 0) break;
    const need = order.shares - order.filledSize;
    const take = Math.min(remaining, need);
    order.filledSize += take;
    remaining -= take;
    const ml = manualLimitOrders.get(order.orderID);
    if (ml) ml.filledSize = order.filledSize;
    if (order.filledSize >= order.shares - 0.01) {
      console.log(`[Strategy.${strategyKey}] TP sell on-chain confirmed ${order.shares} shares @${order.price} (order:${order.orderID.slice(0, 10)}...)`);
      strategyLimitOrders.delete(order.orderID);
      manualLimitOrders.delete(order.orderID);
      clearPendingTradeMetaByOrderId(order.orderID);
    } else {
      console.log(`[Strategy.${strategyKey}] TP sell partial on-chain confirmation +${take.toFixed(2)} shares confirmed ${order.filledSize.toFixed(2)}/${order.shares}`);
    }
    broadcastManualLimitOrders();
  }
}

/**
 * called after a limit-strategy maker buy order is confirmed filled on-chain:
 * - find the corresponding buy stratOrder
 * - accumulate filledSize (on-chain confirmed shares)
 * - place TP sell orders for the newly confirmed shares (place on every MINED increment, plan B)
 * - clean up the buy stratOrder when filledSize reaches shares
 */
async function onStrategyLimitMined(
  strategyKey: string,
  direction: StrategyDirection,
  minedSize: number,
  orderID?: string,
): Promise<void> {
  if (minedSize <= 0) return;
  // fix C: prefer exact matching by orderID (avoids cross-talk between multiple stratOrders)
  // when orderID is not passed, fall back to fuzzy lookup by strategyKey + direction (backward compatible)
  let candidates: StrategyLimitOrder[];
  if (orderID) {
    const order = strategyLimitOrders.get(orderID);
    if (!order || order.side !== "buy" || order.direction !== direction || order.filledSize >= order.shares - 0.01) {
      console.log(`[Strategy.${strategyKey}] MINED on-chain confirmed ${minedSize.toFixed(2)} shares orderID=${fmtOid(orderID)} but the order is no longer present or already full (may have been cleaned up or duplicated)`);
      return;
    }
    candidates = [order];
  } else {
    candidates = [...strategyLimitOrders.values()].filter(o =>
      o.strategyKey === strategyKey && o.side === "buy" && o.direction === direction
      && o.filledSize < o.shares - 0.01
    );
    if (candidates.length === 0) {
      console.log(`[Strategy.${strategyKey}] MINED on-chain confirmed ${minedSize.toFixed(2)} shares but no matching buy order found (may have been cleaned up)`);
      return;
    }
    // ascending by createdAt: consume the old ones first (those placed earlier in the same window confirm first)
    candidates.sort((a, b) => a.createdAt - b.createdAt);
  }

  let remaining = minedSize;
  for (const order of candidates) {
    if (remaining <= 0) break;
    const need = order.shares - order.filledSize;
    const take = Math.min(remaining, need);
    order.filledSize += take;
    remaining -= take;
    const ml = manualLimitOrders.get(order.orderID);
    if (ml) ml.filledSize = order.filledSize;
    if (order.filledSize >= order.shares - 0.01) {
      console.log(`[Strategy.${strategyKey}] limit order on-chain confirmed ${order.direction} ${order.shares} shares @${order.price} (order:${order.orderID.slice(0, 10)}...)`);
      strategyLimitOrders.delete(order.orderID);
      manualLimitOrders.delete(order.orderID);
      clearPendingTradeMetaByOrderId(order.orderID);
    } else {
      console.log(`[Strategy.${strategyKey}] limit order partial on-chain confirmation +${take.toFixed(2)} shares confirmed ${order.filledSize.toFixed(2)}/${order.shares}`);
    }
    broadcastManualLimitOrders();
    // place TP/SL for the newly confirmed shares
    const tpPending = order.filledSize - order.takeProfitPlacedSize;
    if (tpPending > 0) {
      const stratInstance = getStrategy(strategyKey);
      // prefer the cond system (TP+SL co-group management)
      const condCfg = stratInstance?.getLimitConditionOrder?.() ?? null;
      if (condCfg && (condCfg.stopProfit || condCfg.stopLoss)) {
        await createConditionOrdersAfterFill({
          direction: order.direction,
          assetId: order.tokenId,
          entryPrice: order.price,
          filledSize: tpPending,
          windowStart: order.windowStart,
          stopProfit: condCfg.stopProfit,
          stopLoss: condCfg.stopLoss,
        });
        order.takeProfitPlacedSize = order.filledSize;
        console.log(`[Strategy.${strategyKey}] created conditional orders (TP/SL) for ${tpPending.toFixed(2)} shares`);
      } else {
        // fall back to the old TP-only path
        const tpPrice = stratInstance?.getLimitTakeProfitPrice?.() ?? null;
        if (tpPrice == null) {
          // no TP, skip (filled shares are held to settlement)
          order.takeProfitPlacedSize = order.filledSize;
        } else if (tpPending >= 5) {
          await placeStrategyTakeProfitOrder(order, tpPending, tpPrice);
        } else {
          console.log(`[Strategy.${strategyKey}] TP pending ${tpPending.toFixed(2)} shares < 5 (maker minimum limit), not placing for now`);
        }
      }
    }
  }
}

/** limit-strategy scheduling (called every tick) */
function runLimitStrategyTick(): void {
  const snapshot = getProbabilitySnapshot();
  const upPct = snapshot?.upPct ?? null;
  const dnPct = snapshot?.dnPct ?? null;
  const diff = getStrategyDiff();
  const now = Date.now();
  const rem = getStrategyRemainingSeconds(now);
  const ctx = buildTickContext(rem, upPct, dnPct, diff, now);
  const currentWs = getCurrentWindowStart();

  for (const s of getAllStrategies()) {
    if (!isStrategySupportedHere(s)) continue;
    if (!strategyConfig.enabled[s.key]) continue;
    if (!s.checkLimitOrder) continue; // not a limit strategy

    // find the current strategy's active buy resting order (sell is the TP order, auto-managed by the server, strategy does not participate)
    // orders with pendingMined have hit a fill, awaiting MINED handling, do not participate in this path (avoids repeatedly triggering cancel)
    const existingOrder = [...strategyLimitOrders.values()].find(o => o.strategyKey === s.key && o.side === "buy" && !o.pendingMined);

    if (existingOrder) {
      // check whether to cancel
      if (s.checkCancelOrder) {
        const runtime = {
          direction: existingOrder.direction,
          price: existingOrder.price,
          shares: existingOrder.shares,
          filledSize: existingOrder.filledSize,
          windowStart: existingOrder.windowStart,
        };
        if (s.checkCancelOrder(ctx, runtime)) {
          void cancelStrategyLimitOrder(existingOrder.orderID, "strategy cancel condition triggered");
        }
      }
    } else {
      // no resting order, check whether to place a new one (note: place only once per window)
      const mark = `${s.key}:${currentWs}`;
      if (strategyLimitWindowMark.has(mark)) continue;

      // inject the latest shares config into the strategy instance (so checkLimitOrder uses the latest value)
      if ("shares" in s) {
        const cfgShares = strategyConfig.shares[s.key];
        if (cfgShares != null && cfgShares >= 5) {
          (s as any).shares = cfgShares;
        }
      }
      // inject the latest tunable params into the strategy instance (e.g. l1's tpDelta/slDiff)
      applyTunableParamsToStrategy(s);

      // US Eastern weekend pause: do not place new limit orders (existing ones are not cancelled, filled ones' TP/SL run as usual)
      if (strategyConfig.weekendPause && isUsWeekend()) {
        logWeekendPauseOnce();
        continue;
      }

      const signal = s.checkLimitOrder(ctx);
      if (signal) {
        // mark immediately, to avoid the next tick placing again
        strategyLimitWindowMark.add(mark);
        void placeStrategyLimitOrder(s.key, signal);
      }
    }
  }
}


function broadcastManualLimitOrders(): void {
  broadcast("manualLimitOrders", { list: [...manualLimitOrders.values()].sort((a, b) => b.createdAt - a.createdAt) });
}

app.get("/api/orders/open", (_req, res) => {
  res.json({ list: [...manualLimitOrders.values()].sort((a, b) => b.createdAt - a.createdAt) });
});

app.post("/api/orders/cancel", async (req, res) => {
  const { orderID } = req.body as { orderID: string };
  if (!orderID) { res.status(400).json({ error: "invalid params" }); return; }
  if (!(await ensureClobClient())) { res.status(500).json({ error: "CLOB not initialized" }); return; }
  registerCancelConfirm(orderID, "manual");
  const t0 = Date.now();
  console.log("[RAW]", `[Trade.Limit] cancelOrder args:`, JSON.stringify({ orderID }));
  try {
    const result = await clobClient!.cancelOrder({ orderID });
    const dt = Date.now() - t0;
    console.log("[RAW]", `[Trade.Limit] cancelOrder raw result:`, JSON.stringify(result), `HTTP:${dt}ms`);
    const canceledList = Array.isArray((result as any)?.canceled) ? (result as any).canceled as string[] : [];
    const notCanceled = (result as any)?.not_canceled;
    const ncReason = notCanceled && typeof notCanceled === "object" ? String((notCanceled as Record<string, unknown>)[orderID] ?? "") : "";
    if (canceledList.includes(orderID)) {
      manualLimitOrders.delete(orderID);
      broadcastManualLimitOrders();
      console.log(`[Trade.Limit] ✖ cancel orderID=${fmtOid(orderID)}`);
      res.json({ success: true });
      return;
    }
    if (ncReason) {
      if (/filled|matched|not.?found|does not exist|already/i.test(ncReason)) {
        manualLimitOrders.delete(orderID);
        broadcastManualLimitOrders();
        resolveCancelConfirm(orderID, "HTTP not_canceled soft success");
        console.log(`[Trade.Limit] orderID=${fmtOid(orderID)} handled: ${ncReason}`);
        res.json({ success: true, note: ncReason });
        return;
      }
      console.warn(`[Trade.Limit] cancel not_canceled: ${ncReason}`);
      res.status(500).json({ error: `cancel rejected: ${ncReason}` });
      return;
    }
    console.warn(`[Trade.Limit] cancel response ambiguous orderID=${fmtOid(orderID)}`);
    res.status(500).json({ error: "cancel response not confirmed" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const dt = Date.now() - t0;
    console.log("[RAW]", `[Trade.Limit] cancelOrder threw HTTP:${dt}ms err:`, msg);
    if (/not found|does not exist|already/i.test(msg)) {
      manualLimitOrders.delete(orderID);
      broadcastManualLimitOrders();
      resolveCancelConfirm(orderID, "HTTP threw not found");
      res.json({ success: true, note: "order no longer exists" });
      return;
    }
    console.warn(`[Trade.Limit] cancel failed orderID=${fmtOid(orderID)} err:`, msg);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/order/limit", async (req, res) => {
  const { direction, side, size, price } = req.body as {
    direction: StrategyDirection; side: "buy" | "sell"; size: number; price: number;
  };
  if (!direction || !side || !size || !price || size < 5 || price <= 0 || price >= 1) {
    res.status(400).json({ error: "invalid params" });
    return;
  }
  if (!(await ensureClobClient())) {
    res.status(500).json({ error: "CLOB client not initialized" });
    return;
  }
  const tokenId = direction === "up" ? state.upTokenId : state.downTokenId;
  if (!tokenId) { res.status(400).json({ error: "the current window market is not ready" }); return; }
  try {
    const tickSize = getCachedTickSize(tokenId);
    const priceDecimals = getDecimalPlaces(tickSize);
    const normalizedSize  = floorToDecimals(size, 2);
    const normalizedPrice = floorToDecimals(price, priceDecimals);
    if (normalizedSize <= 0 || normalizedPrice <= 0) {
      res.status(400).json({ error: "params invalid after precision handling" }); return;
    }
    const manualLimitArgs = { tokenID: tokenId, side: side === "buy" ? Side.BUY : Side.SELL, price: normalizedPrice, size: normalizedSize };
    const manualLimitOpts = { tickSize, negRisk: false };
    console.log("[RAW]", `[Trade.Limit] createOrder args:`, JSON.stringify(manualLimitArgs), "opts:", JSON.stringify(manualLimitOpts), "ctx:", JSON.stringify({ direction, side, size, price, normalizedSize, normalizedPrice, tickSize, priceDecimals, tokenId, windowStart: state.windowStart }));
    const signed = await clobClient!.createOrder(manualLimitArgs, manualLimitOpts);
    console.log("[RAW]", `[Trade.Limit] signedOrder:`, JSON.stringify(signed));
    const limitT0 = Date.now();
    const result = await clobClient!.postOrder(signed, OrderType.GTC);
    const limitHttpMs = Date.now() - limitT0;
    console.log("[RAW]", `[Trade.Limit] postOrder GTC raw result:`, JSON.stringify(result), `HTTP:${limitHttpMs}ms`);
    const orderID = typeof result?.orderID === "string" ? result.orderID : "";
    if (!orderID) {
      const errMsg = typeof result?.error === "string" ? result.error : "response has no orderID";
      res.status(400).json({ error: errMsg }); return;
    }
    console.log(`[Trade.Limit] ➕ ${direction === "up" ? "⬆" : "⬇"} ${side === "buy" ? "buy" : "sell"} ${direction === "up" ? "up" : "down"} ${normalizedSize}@${normalizedPrice} orderID=${fmtOid(orderID)}`);
    registerOrderConfirm(orderID, "manual-limit", { side, direction, size: normalizedSize, price: normalizedPrice });
    manualLimitOrders.set(orderID, { orderID, direction, side, size: normalizedSize, price: normalizedPrice, createdAt: Date.now() });
    broadcastManualLimitOrders();
    res.json({ orderID });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: msg });
  }
});

app.post("/api/order", async (req, res) => {
  const { direction, side, amount, slippage, stopProfit, stopLoss } = req.body as {
    direction: "up" | "down";
    side: "buy" | "sell";
    amount: number;
    slippage?: number;
    // conditional order params (only effective when side=buy; percentage is the delta relative to the fill price, 0~1 float)
    stopProfit?: { pctDelta: number };
    stopLoss?: { pctDelta: number; slippage?: number };
  };
  if (side === "buy" && (stopProfit || stopLoss)) {
    const tp = stopProfit ? `TP+${(stopProfit.pctDelta * 100).toFixed(1)}%` : "";
    const sl = stopLoss ? `SL-${(stopLoss.pctDelta * 100).toFixed(1)}%(slippage ${((stopLoss.slippage ?? 0.15) * 100).toFixed(0)}%)` : "";
    console.log(`[Cond] received conditional order params ${[tp, sl].filter(Boolean).join(" · ")} (direction=${direction} amount=${amount})`);
  }
  const result = await placeOrder({
    direction, side, amount, slippage,
    source: "manual",
    stopProfit: side === "buy" ? stopProfit : undefined,
    stopLoss: side === "buy" ? stopLoss : undefined,
  });
  res.status(result.statusCode).json(result.body);
});

// -- REST: Telegram push config ----------------------------------
app.get("/api/tg/config", (_req, res) => {
  const masked = tgConfig.botToken ? tgConfig.botToken.slice(0, 10) + "***" + tgConfig.botToken.slice(-4) : "";
  res.json({
    enabled: tgConfig.enabled,
    botToken: masked,
    botTokenSet: !!tgConfig.botToken,
    chatId: tgConfig.chatId,
    intervalMinutes: tgConfig.intervalMinutes,
    scheduledEnabled: tgConfig.scheduledEnabled,
    postTradeEnabled: tgConfig.postTradeEnabled,
  });
});

app.post("/api/tg/config", (req, res) => {
  const body = req.body as Partial<TgConfig>;
  if (typeof body.enabled === "boolean") tgConfig.enabled = body.enabled;
  if (typeof body.botToken === "string" && body.botToken && !body.botToken.includes("***")) {
    tgConfig.botToken = body.botToken.trim();
  }
  if (typeof body.chatId === "string") tgConfig.chatId = body.chatId.trim();
  if (typeof body.intervalMinutes === "number" && body.intervalMinutes >= 5) {
    tgConfig.intervalMinutes = Math.floor(body.intervalMinutes);
  }
  if (typeof body.scheduledEnabled === "boolean") tgConfig.scheduledEnabled = body.scheduledEnabled;
  if (typeof body.postTradeEnabled === "boolean") tgConfig.postTradeEnabled = body.postTradeEnabled;
  saveTgConfig(tgConfig);
  startTgPushLoop();  // hot-restart the scheduled task
  broadcastTgConfig();
  res.json({ ok: true });
});

app.post("/api/tg/test", async (_req, res) => {
  if (!tgConfig.botToken || !tgConfig.chatId) {
    res.status(400).json({ ok: false, error: "please configure the Bot Token and Chat ID first" });
    return;
  }
  const text = `🧪 ${activeMarket.displayName} test message\n\n${buildTgMessage()}`;
  const result = await sendTgMessage(tgConfig, text);
  res.json(result);
});

// auto-detect Chat ID (take the chat.id of the most recent message from getUpdates)
app.post("/api/tg/detect-chat-id", async (req, res) => {
  const body = req.body as { botToken?: string };
  // prefer the token in the request (just entered by the frontend user), otherwise use the saved one
  let token = body.botToken && !body.botToken.includes("***") ? body.botToken.trim() : tgConfig.botToken;
  if (!token) {
    res.status(400).json({ ok: false, error: "please enter the Bot Token first" });
    return;
  }
  const result = await autoDetectChatId(token);
  res.json(result);
});

// -- Browser WS connection ----------------------------------------
if (wss) {
  wss.on("connection", (ws, req) => {
    const dataMode = resolveClientDataModeFromUrl(req.url);
    clientSessions.set(ws, createClientSession(dataMode));
    console.log(`[System.Frontend] browser connected, current: ${wss!.clients.size} mode=${dataMode}`);
    send(ws, "clientConfig", { dataMode });
    sendStateToClient(ws, { includeHistory: true });
    sendPmPnlToClient(ws);
    sendHttpHeartbeatToClient(ws);
    sendOrderLatencyToClient(ws);
    sendConditionOrdersToClient(ws);
    send(ws, "manualLimitOrders", { list: [...manualLimitOrders.values()].sort((a, b) => b.createdAt - a.createdAt) });
    send(ws, "manualConfig", { manualConfig });
    sendTgConfigToClient(ws);
    send(ws, "wsStatus", wsStatus as unknown as Record<string, unknown>);
    send(ws, "claimable", { total: claimableTotal, positions: claimablePositions });
    send(ws, "claimCooldown", { running: claimCycleRunning || claimInProgress, nextCheckAt: claimNextCheckAt, cooldownUntil: claimCooldownUntil });
    send(ws, "backtestStatus", { collecting: backtestCollecting });
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        // frontend -> backend RTT test: reply pong immediately (echo clientTs back, frontend computes RTT)
        if (msg && msg.type === "ping") {
          send(ws, "pong", { clientTs: msg.clientTs });
          return;
        }
        applyClientConfig(ws, msg);
      } catch {
        // ignore non-JSON or non-config messages
      }
    });
    ws.on("close", () => {
      const session = clientSessions.get(ws);
      if (session) {
        clearStateTimer(session);
        clientSessions.delete(ws);
      }
      console.log(`[System.Frontend] browser disconnected, current: ${wss!.clients.size}`);
    });
  });
}

// -- Before startup: load all strategy plugins first (the core of the plugin architecture) --------------
await initStrategies();
initStrategyConfig();
// limit strategies: read the shares config from env and inject into the strategy instance
for (const s of getAllStrategies()) {
  const upper = s.key.toUpperCase();
  const sharesEnv = process.env[`STRATEGY_${upper}_SHARES`];
  if (sharesEnv != null && "shares" in s) {
    const v = Number(sharesEnv);
    if (Number.isFinite(v) && v >= 5) {
      (s as any).shares = v;
      console.log(`[Strategy] ${s.key} shares config set to ${v}`);
    }
  }
  // tunable params: env STRATEGY_<KEY>_PARAM_<NAME> override -> write into strategyConfig.params
  const defs = getStrategyTunableParams(s.key);
  if (defs.length) {
    if (strategyConfig.params[s.key] == null) strategyConfig.params[s.key] = {};
    for (const def of defs) {
      const envName = `STRATEGY_${upper}_PARAM_${def.key.toUpperCase()}`;
      const envRaw = process.env[envName];
      if (envRaw != null) {
        const v = Number(envRaw);
        if (Number.isFinite(v) && v >= def.min && (def.max == null || v <= def.max)) {
          strategyConfig.params[s.key][def.key] = v;
          console.log(`[Strategy] ${s.key}.${def.key} = ${v} (from ${envName})`);
        }
      }
    }
  }
  // inject the persisted/env params into the strategy instance
  applyTunableParamsToStrategy(s);
}

// -- Startup ----------------------------------------------------
// WebSocketServer is attached to the http server; when the server reports EADDRINUSE, wss also fires an error event.
// must register a silent handler on wss to prevent Node from treating it as an unhandled 'error' and crashing directly.
if (wss) wss.on("error", (err) => {
  const e = err as NodeJS.ErrnoException;
  if (e.code === "EADDRINUSE") return; // handled by listenWithFallback retry
  console.warn(`[System.Frontend] error:`, e.message);
});

async function listenWithFallback(): Promise<void> {
  for (let i = 0; i < PORT_MAX_TRIES; i++) {
    const tryPort = PORT_BASE + i;
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(tryPort);
      });
      PORT = tryPort;
      if (i > 0) console.log(`[System.Port] ${PORT_BASE} is occupied, auto-switched to ${PORT}`);
      // write .port so start.sh knows the actual port (readable immediately after startup; a stale file from a dead PID is harmless)
      try { writeFileSync(resolve(__dirname, ".port"), String(PORT)); } catch { /* ignore */ }
      return;
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code !== "EADDRINUSE") throw err;
      console.log(`[System.Port] ${tryPort} is occupied, trying the next one...`);
    }
  }
  throw new Error(`[System.Port] ports ${PORT_BASE}-${PORT_BASE + PORT_MAX_TRIES - 1} are all occupied, startup failed`);
}

await listenWithFallback();

(async () => {
  console.log(`\n ${activeMarket.displayName} 5m order book monitor service started  v${APP_VERSION}`);
  console.log(`  by Penguin Sensei · 岳 | X: @x_188888_x`);
  console.log(`  run mode:    ${APP_MODE}`);
  console.log(`  state API:   http://localhost:${PORT}/api/state`);
  if (IS_FULL_MODE) {
    console.log(`  open browser: http://localhost:${PORT}`);
    console.log(`  WS address:  ws://localhost:${PORT}`);
  }
  console.log("");

  await ensureClobClient();
  void ensureAccountName();
  startUserWs();
  startBinanceWs();
  startCoinbaseWs();
  await syncPositionsFromApi();
  await syncUsdcBalance();
  // start the 15s polling loop (whether it actually queries/claims is decided by the autoClaimEnabled config)
  scheduleClaimCycle();

  setInterval(async () => { await syncPositionsFromApi(); broadcastState(); }, 2000);
  setInterval(async () => { await syncUsdcBalance(); broadcastState(); }, 5000);
  setInterval(() => { refreshBinanceOffset("scheduled", { allowLatestFallback: false }); }, BINANCE_ALIGN_REFRESH_MS);
  setInterval(() => { refreshGenericOffset(COINBASE_SPEC, "scheduled", { allowLatestFallback: false }); }, BINANCE_ALIGN_REFRESH_MS);
  // market + limit strategies share a tick (event-driven + 250ms fallback, so limit-strategy cancels also respond in a second)
  setInterval(() => { runStrategyTick(); backtestTick(); }, STRATEGY_TICK_MS);
  // limit cancel polling (every 1 second: strategy says cancel + order still there -> call cancel API)
  setInterval(() => { void pollLimitOrderCancellations(); }, 1000);
  // the old GTC take-profit fallback polling has been removed: now relies on UserWS event_type:order real-time push + 8s register fallback,
  // on window switch all GTC are cancelled uniformly, residual UI state lags at most until the next window
  // the Claim feature has moved to the Polymarket official site (Settings -> Auto Redeem), no longer auto-executed locally

  // HTTP Keep-Alive heartbeat: ping CLOB /time every 20 seconds, to prevent the server from closing the idle connection
  // measured: the server closes in 30-60 seconds, a 20-second interval has a 10+ second safety margin
  // each channel pings once: undici (fetch) + axios (Node https globalAgent)
  setInterval(async () => {
    // undici channel
    {
      const t0 = Date.now();
      try {
        const r = await fetch(`${CLOB_URL}/time`);
        await r.text();
        httpHeartbeat.latencyMs = Date.now() - t0;
        httpHeartbeat.lastAt = Date.now();
        httpHeartbeat.ok = true;
        // print only on anomaly (>1000ms considered suspicious)
        if (httpHeartbeat.latencyMs > 1000) {
          console.warn(`[Health.undici] ⚠ ${httpHeartbeat.latencyMs}ms (>1000ms)`);
        }
      } catch (err) {
        httpHeartbeat.latencyMs = -1;
        httpHeartbeat.lastAt = Date.now();
        httpHeartbeat.ok = false;
        console.error(`[Health.undici] ❌ heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      broadcastHttpHeartbeat();
    }
    // axios channel: use Node native https (defaults to globalAgent, shares the connection pool with axios)
    {
      const t0 = Date.now();
      try {
        await new Promise<void>((res, rej) => {
          const req = httpsMod.request(`${CLOB_URL}/time`, { method: "GET" }, (r) => {
            r.on("data", () => { /* drain */ });
            r.on("end", () => res());
            r.on("error", rej);
          });
          req.on("error", rej);
          req.setTimeout(5000, () => { req.destroy(new Error("timeout")); });
          req.end();
        });
        axiosHeartbeat.latencyMs = Date.now() - t0;
        axiosHeartbeat.lastAt = Date.now();
        axiosHeartbeat.ok = true;
        if (axiosHeartbeat.latencyMs > 1000) {
          console.warn(`[Health.axios] ⚠ ${axiosHeartbeat.latencyMs}ms (>1000ms)`);
        }
      } catch (err) {
        axiosHeartbeat.latencyMs = -1;
        axiosHeartbeat.lastAt = Date.now();
        axiosHeartbeat.ok = false;
        console.error(`[Health.axios] ❌ heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      broadcastAxiosHeartbeat();
    }
  }, 20000);

  // Polymarket real PnL: full load at startup + full refresh every 5 minutes
  const schedulePmPnlRefresh = () => {
    pmPnlNextRefreshAt = Date.now() + PMPNL_REFRESH_INTERVAL_MS;
  };
  pmPnlManager.init().then(() => {
    schedulePmPnlRefresh();
    broadcastPmPnl();
  }).catch((err) => {
    console.warn(`[PnL] startup load failed: ${err instanceof Error ? err.message : String(err)}`);
    schedulePmPnlRefresh();
  });
  setInterval(async () => {
    await pmPnlManager.fetchAll();
    schedulePmPnlRefresh();
    broadcastPmPnl();
  }, PMPNL_REFRESH_INTERVAL_MS);

  // Telegram push: read the config, start the scheduled task per the config
  startTgPushLoop();

  const currentWindow = getCurrentWindowStart();
  fetchRecentResults(currentWindow, true);
  await subscribeWindow(currentWindow);
})();

function gracefulShutdown(signal: string): void {
  console.log(`[System.Exit] received ${signal}, preparing to shut down (force exit after 3 seconds)`);
  // fallback: SIGKILL if not exited within 3 seconds (unref so it does not block a normal exit)
  setTimeout(() => {
    console.warn("[System.Exit] not finished in 3 seconds, forcing SIGKILL");
    process.kill(process.pid, "SIGKILL");
  }, 3000).unref();

  stopped = true;
  if (switchTimer)    clearTimeout(switchTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (claimCycleTimer) clearTimeout(claimCycleTimer);
  if (marketWs)    marketWs.close();
  if (chainlinkWs) chainlinkWs.close();
  if (userWs)      (userWs as WebSocket).close();
  if (binanceWs)   binanceWs.close();
  server.close();
  process.exit(0);
}

process.on("SIGINT",  () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGHUP",  () => gracefulShutdown("SIGHUP"));
