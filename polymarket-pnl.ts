/**
 * Polymarket real PnL module
 *
 * Data sources:
 *   - /activity?type=TRADE    all CLOB buy/sell fills (both maker / taker, covers cases like t8 limit orders being taken)
 *   - /activity?type=REDEEM   Claim credited
 *   - /positions              current unprocessed positions (not sold / not claimed)
 *
 * Note: earlier we used the /trades endpoint, but it only returns fills from the taker's perspective,
 *       so limit orders like t8 that get taken as maker would be missing; therefore we switched to /activity?type=TRADE.
 *
 * Design:
 *   - Full load on startup (paginate to the end)
 *   - Incremental sync filtered by lastSyncTs, only pulling new data
 *   - A full refresh every 5 minutes as a fallback
 *   - Pair by (conditionId, outcome) to compute the full PnL of each position
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Constants ───────────────────────────────────────────────
const API_BASE = "https://data-api.polymarket.com";
const API_HEADERS = { "User-Agent": "Mozilla/5.0" };
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 15000;
// Polymarket official fee formula: fee = C × feeRate × p × (1 - p)
// For crypto markets (BTC 5m etc.) feeRate = 7.2% (max fee $1.80 / 100 shares @ p=0.5)
// Reference: https://docs.polymarket.com/trading/fees
const CRYPTO_FEE_RATE = 0.072;

// ── Types ───────────────────────────────────────────────────
export interface PmTrade {
  proxyWallet: string;
  side: "BUY" | "SELL";
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;       // Unix seconds
  outcome: string;         // "Up" / "Down"
  outcomeIndex: number;
  title: string;
  slug: string;
  eventSlug: string;
  transactionHash: string;
}

export interface PmRedeem {
  proxyWallet: string;
  conditionId: string;
  timestamp: number;       // Unix seconds
  size: number;
  usdcSize: number;        // Claim credited amount
  transactionHash: string;
  title: string;
  slug: string;
  eventSlug: string;
}

export interface PmPosition {
  proxyWallet: string;
  conditionId: string;
  asset: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  realizedPnl: number;
  redeemable: boolean;
  outcome: string;
  outcomeIndex: number;
  title: string;
  endDate: string;
}

export interface PositionSummary {
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  title: string;
  slug: string;
  windowStart: number;          // parsed from slug
  firstTs: number;              // first trade time (seconds)
  lastTs: number;               // last trade time (seconds)
  buys: PmTrade[];
  sells: PmTrade[];
  redeems: PmRedeem[];
  buyCost: number;              // total buy spend (excluding fee)
  sellRevenue: number;          // total sell revenue (excluding fee)
  redeemRevenue: number;        // total Claim payback
  totalFee: number;             // total fee
  netPnl: number;               // real net PnL = sell + Claim - buy - fee
  status: "claimed" | "sold" | "pending" | "settled_lost";
  strategySource?: string;      // source from local .strategy-sources.json
  // Extra info for unsettled positions (from /positions)
  currentValue?: number;
  currentRedeemable?: boolean;
}

/** A flattened single row (one per BUY/SELL/REDEEM/LOST) */
export interface PnlEvent {
  ts: number;                   // seconds
  kind: "BUY" | "SELL" | "REDEEM" | "LOST";   // LOST = settled to zero (virtual event)
  outcome: string;              // Up / Down
  outcomeIndex: number;
  conditionId: string;
  title: string;
  slug: string;                 // market slug (e.g. "btc-updown-5m-1777139100"), used by frontend to filter by market
  size: number;
  price: number;                // = 1 for REDEEM (payout at 1 USDC/share)
  cost: number;                 // BUY=spend, SELL=revenue, REDEEM=credited
  fee: number;                  // BUY/SELL fee, REDEEM=0
  netAmount: number;            // net cash change (out=negative, in=positive, fee included)
  transactionHash: string;
  strategySource?: string;
  positionPnl?: number;         // position settlement PnL, attached only to the last exit row (SELL/REDEEM/LOST)
  positionStatus?: "claimed" | "sold" | "pending" | "settled_lost";
  pending?: true;               // locally pre-inserted, shows "pending calibration" before API data returns
}

// ── Network utilities ────────────────────────────────────────
async function fetchJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: API_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPaged<T>(path: string, extraQs: string = ""): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  while (true) {
    const qs = `limit=${PAGE_SIZE}&offset=${offset}${extraQs ? "&" + extraQs : ""}`;
    const url = `${API_BASE}/${path}${path.includes("?") ? "&" : "?"}${qs}`;
    const batch = await fetchJson<T[]>(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return items;
}

// ── API wrappers ─────────────────────────────────────────────
// Use /activity?type=TRADE instead of /trades: the former covers fills from the maker's perspective (e.g. t8 limit orders being taken),
// while the latter only returns taker fills and would miss records of being passively filled as the resting order side.
export async function fetchAllTrades(proxy: string): Promise<PmTrade[]> {
  return fetchPaged<PmTrade>(`activity?user=${proxy}&type=TRADE`);
}

export async function fetchAllRedeems(proxy: string): Promise<PmRedeem[]> {
  // Polymarket returns many empty redeem records with size=0 (multi-direction split noise from the same tx), filter them out
  const all = await fetchPaged<PmRedeem>(`activity?user=${proxy}&type=REDEEM`);
  return all.filter(r => (r.usdcSize > 0) || (r.size > 0));
}

export async function fetchAllPositions(proxy: string): Promise<PmPosition[]> {
  return fetchPaged<PmPosition>(`positions?user=${proxy}`);
}

/** Incremental fetch: only data with timestamp > sinceSec */
export async function fetchTradesSince(proxy: string, sinceSec: number): Promise<PmTrade[]> {
  // The Polymarket API returns in reverse chronological order. Fetch the first page; if the last item is still > sinceSec, continue to the next page
  const collected: PmTrade[] = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/activity?user=${proxy}&type=TRADE&limit=${PAGE_SIZE}&offset=${offset}`;
    const batch = await fetchJson<PmTrade[]>(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    const fresh = batch.filter(t => t.timestamp > sinceSec);
    collected.push(...fresh);
    if (fresh.length < batch.length) break;  // old data appeared, stop paging
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return collected;
}

export async function fetchRedeemsSince(proxy: string, sinceSec: number): Promise<PmRedeem[]> {
  const collected: PmRedeem[] = [];
  let offset = 0;
  while (true) {
    const url = `${API_BASE}/activity?user=${proxy}&type=REDEEM&limit=${PAGE_SIZE}&offset=${offset}`;
    const batch = await fetchJson<PmRedeem[]>(url);
    if (!Array.isArray(batch) || batch.length === 0) break;
    const fresh = batch.filter(r => r.timestamp > sinceSec);
    collected.push(...fresh);
    if (fresh.length < batch.length) break;
    if (batch.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return collected.filter(r => (r.usdcSize > 0) || (r.size > 0));
}

// ── Fee formula ──────────────────────────────────────────────
// Official formula: fee = C × feeRate × p × (1 - p), symmetric for buy/sell
// Makers are not charged, only the taker pays; our FOK orders are all takers
function feeOf(_side: "BUY" | "SELL", size: number, price: number): number {
  return size * CRYPTO_FEE_RATE * price * (1 - price);
}

/** Return the Unix seconds of today 0:00 in CST (UTC+8) */
function getCstDayStartSec(): number {
  const offsetMs = 8 * 3600_000;
  const cstMs = Date.now() + offsetMs;
  const cstDay = new Date(cstMs);
  cstDay.setUTCHours(0, 0, 0, 0);
  return Math.floor(cstDay.getTime() / 1000) - 8 * 3600;
}

// ── Position pairing ─────────────────────────────────────────
/**
 * Group trades + redeems by (conditionId, outcome), computing the full PnL for each group
 *
 * Note: redeem events do not contain outcome info; they are attributed to this market via conditionId.
 * If you bought both Up and Down under the same conditionId (rare), the redeem
 * is attributed to every outcome that appeared (only one side can win, the other has usdcSize=0 and has no effect).
 */
export function summarizePositions(
  trades: PmTrade[],
  redeems: PmRedeem[],
  positions: PmPosition[],
  strategySources: Map<string, string>,
): PositionSummary[] {
  type Key = string;
  const mk = (c: string, o: string): Key => `${c}::${o}`;
  const groups = new Map<Key, PositionSummary>();

  // 1. First group all trades by (conditionId, outcome)
  for (const t of trades) {
    const k = mk(t.conditionId, t.outcome);
    let g = groups.get(k);
    if (!g) {
      const ws = parseWindowStartFromSlug(t.slug);
      g = {
        conditionId: t.conditionId,
        outcome: t.outcome,
        outcomeIndex: t.outcomeIndex,
        title: t.title,
        slug: t.slug,
        windowStart: ws,
        firstTs: t.timestamp,
        lastTs: t.timestamp,
        buys: [],
        sells: [],
        redeems: [],
        buyCost: 0, sellRevenue: 0, redeemRevenue: 0, totalFee: 0, netPnl: 0,
        status: "pending",
      };
      groups.set(k, g);
    }
    if (t.side === "BUY") g.buys.push(t);
    else g.sells.push(t);
    g.firstTs = Math.min(g.firstTs, t.timestamp);
    g.lastTs = Math.max(g.lastTs, t.timestamp);
  }

  // 2. Attribute redeems by conditionId (a single conditionId may have multiple outcome groups)
  const redeemsByCond = new Map<string, PmRedeem[]>();
  for (const r of redeems) {
    const arr = redeemsByCond.get(r.conditionId) ?? [];
    arr.push(r);
    redeemsByCond.set(r.conditionId, arr);
  }

  // 3. Compute the PnL of each group
  for (const g of groups.values()) {
    const rs = redeemsByCond.get(g.conditionId) ?? [];
    // All redeems of the same conditionId are attached here (the winning side)
    g.redeems = rs;
    if (rs.length) g.lastTs = Math.max(g.lastTs, ...rs.map(r => r.timestamp));

    g.buyCost = g.buys.reduce((s, b) => s + b.size * b.price, 0);
    g.sellRevenue = g.sells.reduce((s, x) => s + x.size * x.price, 0);
    g.redeemRevenue = rs.reduce((s, r) => s + r.usdcSize, 0);
    g.totalFee =
      g.buys.reduce((s, b) => s + feeOf("BUY", b.size, b.price), 0) +
      g.sells.reduce((s, x) => s + feeOf("SELL", x.size, x.price), 0);

    g.netPnl = g.sellRevenue + g.redeemRevenue - g.buyCost - g.totalFee;

    // Determine status
    if (rs.length > 0) g.status = "claimed";
    else if (g.sells.length > 0) g.status = "sold";
    else g.status = "pending";

    // Strategy source: look up by the txHash of the first buy
    if (g.buys.length) {
      const src = strategySources.get(g.buys[0].transactionHash.toLowerCase());
      if (src) g.strategySource = src;
    }
  }

  // 4. Unsettled position info: supplement from /positions
  for (const p of positions) {
    const k = mk(p.conditionId, p.outcome);
    const g = groups.get(k);
    if (!g) continue;
    g.currentValue = p.currentValue;
    g.currentRedeemable = p.redeemable;
    // Settled but zeroed out: upgrade from pending to settled_lost
    if (g.status === "pending" && p.redeemable && p.currentValue === 0) {
      g.status = "settled_lost";
      // In this case cashPnl is -initialValue (position value goes to zero)
      // Already reflected in g.netPnl (sell=0, redeem=0, buyCost - fee is the loss)
    }
  }

  // 5. Return sorted by most recent time descending
  return [...groups.values()].sort((a, b) => b.lastTs - a.lastTs);
}

function parseWindowStartFromSlug(slug: string): number {
  // slug format "btc-updown-5m-1776762000"
  const m = slug.match(/(\d{10,})$/);
  return m ? parseInt(m[1], 10) : 0;
}

// ── Strategy source mapping (local persistence) ──────────────
const STRATEGY_SOURCES_FILE = resolve(__dirname, ".strategy-sources.json");

export function loadStrategySources(): Map<string, string> {
  try {
    if (!existsSync(STRATEGY_SOURCES_FILE)) return new Map();
    const data = JSON.parse(readFileSync(STRATEGY_SOURCES_FILE, "utf-8"));
    if (typeof data !== "object" || data == null) return new Map();
    return new Map(Object.entries(data as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  } catch (err) {
    console.warn(`[PmPnl] Failed to load strategy-sources: ${err instanceof Error ? err.message : String(err)}`);
    return new Map();
  }
}

export function saveStrategySources(map: Map<string, string>): void {
  try {
    const obj: Record<string, string> = {};
    for (const [k, v] of map) obj[k] = v;
    writeFileSync(STRATEGY_SOURCES_FILE, JSON.stringify(obj, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[PmPnl] Failed to save strategy-sources: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Manager: state + sync ────────────────────────────────────
export class PmPnlManager {
  private trades: PmTrade[] = [];
  private redeems: PmRedeem[] = [];
  private positions: PmPosition[] = [];
  private strategySources: Map<string, string> = loadStrategySources();
  private initialized = false;
  private refreshing = false;
  private lastRefreshAt = 0;   // timestamp of the most recent successful full fetch (ms)

  constructor(private proxy: string) {}

  /** Record the strategy source of a trade (txHash → source) */
  recordStrategySource(txHash: string, source: string): void {
    if (!txHash) return;
    this.strategySources.set(txHash.toLowerCase(), source);
    saveStrategySources(this.strategySources);
  }

  /** Startup load (fetch today's CST data, equivalent to fetchAll) */
  async init(): Promise<void> {
    if (this.initialized) return;
    await this.fetchAll();
    this.initialized = true;
  }

  /**
   * Fetch today's (from CST 0:00) trades/redeems + current positions, overwriting the local cache
   *
   * Note: although the function is named fetchAll, it actually only fetches "today's" fills, not the full history.
   *       Design reason: refreshing every 5 minutes + checking cross-day data on the Polymarket website is enough, no need to cache all history on the backend.
   */
  async fetchAll(): Promise<boolean> {
    if (!this.proxy || this.refreshing) return false;
    this.refreshing = true;
    try {
      const sinceSec = getCstDayStartSec();
      const [tradesRes, redeemsRes, positionsRes] = await Promise.allSettled([
        fetchTradesSince(this.proxy, sinceSec),
        fetchRedeemsSince(this.proxy, sinceSec),
        fetchAllPositions(this.proxy),
      ]);
      if (tradesRes.status === "fulfilled") this.trades = tradesRes.value;
      else console.warn(`[PmPnl] today's trades failed: ${tradesRes.reason?.message ?? tradesRes.reason}`);
      if (redeemsRes.status === "fulfilled") this.redeems = redeemsRes.value;
      else console.warn(`[PmPnl] today's redeems failed: ${redeemsRes.reason?.message ?? redeemsRes.reason}`);
      if (positionsRes.status === "fulfilled") this.positions = positionsRes.value;
      else console.warn(`[PmPnl] positions failed: ${positionsRes.reason?.message ?? positionsRes.reason}`);
      this.lastRefreshAt = Date.now();
      console.log(`[PmPnl] refresh (today CST): trades ${this.trades.length} / redeems ${this.redeems.length} / positions ${this.positions.length}`);
      return true;
    } catch (err) {
      console.warn(`[PmPnl] refresh exception: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      this.refreshing = false;
    }
  }

  getLastRefreshAt(): number { return this.lastRefreshAt; }

  /** Return a snapshot aggregated by position */
  getSummaries(limit?: number): PositionSummary[] {
    const all = summarizePositions(this.trades, this.redeems, this.positions, this.strategySources);
    return limit ? all.slice(0, limit) : all;
  }

  /** Return flattened per-event rows, in reverse chronological order. Returns only the last 7 days by default. */
  getEvents(opts?: { limit?: number; sinceDays?: number }): PnlEvent[] {
    const sinceDays = opts?.sinceDays ?? 7;
    const limit = opts?.limit;
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = sinceDays > 0 ? nowSec - sinceDays * 86400 : 0;
    const summaries = summarizePositions(this.trades, this.redeems, this.positions, this.strategySources);
    // Split each position: BUY + SELL + REDEEM each become a row, with position info attached
    const events: PnlEvent[] = [];
    for (const s of summaries) {
      for (const b of s.buys) {
        const fee = feeOf("BUY", b.size, b.price);
        const cost = b.size * b.price;
        events.push({
          ts: b.timestamp,
          kind: "BUY",
          outcome: b.outcome,
          outcomeIndex: b.outcomeIndex,
          conditionId: b.conditionId,
          title: b.title,
          slug: s.slug,
          size: b.size,
          price: b.price,
          cost, fee,
          netAmount: -(cost + fee),
          transactionHash: b.transactionHash,
          strategySource: s.strategySource,
        });
      }
      // Position settlement PnL is attached only to the last exit row (the one with the largest ts among SELL/REDEEM)
      // To avoid showing the same netPnl value repeatedly when a position has multiple exits
      const lastExitTs = Math.max(
        ...s.sells.map(x => x.timestamp),
        ...s.redeems.map(r => r.timestamp),
        -Infinity,
      );
      let pnlAttached = false;  // attach only once when multiple rows share the same ts
      for (const x of s.sells) {
        const fee = feeOf("SELL", x.size, x.price);
        const revenue = x.size * x.price;
        const isLastExit = !pnlAttached && x.timestamp === lastExitTs;
        if (isLastExit) pnlAttached = true;
        events.push({
          ts: x.timestamp,
          kind: "SELL",
          outcome: x.outcome,
          outcomeIndex: x.outcomeIndex,
          conditionId: x.conditionId,
          title: x.title,
          slug: s.slug,
          size: x.size,
          price: x.price,
          cost: revenue, fee,
          netAmount: revenue - fee,
          transactionHash: x.transactionHash,
          strategySource: s.strategySource,
          ...(isLastExit ? { positionPnl: s.netPnl, positionStatus: s.status } : {}),
        });
      }
      for (const r of s.redeems) {
        const isLastExit = !pnlAttached && r.timestamp === lastExitTs;
        if (isLastExit) pnlAttached = true;
        events.push({
          ts: r.timestamp,
          kind: "REDEEM",
          outcome: s.outcome,
          outcomeIndex: s.outcomeIndex,
          conditionId: r.conditionId,
          title: r.title,
          slug: s.slug,
          size: r.size,
          price: 1,
          cost: r.usdcSize, fee: 0,
          netAmount: r.usdcSize,
          transactionHash: r.transactionHash,
          strategySource: s.strategySource,
          ...(isLastExit ? { positionPnl: s.netPnl, positionStatus: s.status } : {}),
        });
      }

      // Virtual "settled to zero" event: BUY exists + no SELL + no REDEEM + the window's settlement time has passed
      // windowStart is parsed from slug, settlement time = windowStart + 300 seconds
      if (s.buys.length > 0 && s.sells.length === 0 && s.redeems.length === 0 && s.windowStart > 0) {
        const settleTs = s.windowStart + 300;
        if (nowSec >= settleTs) {
          // Synthesize a LOST row
          const totalSize = s.buys.reduce((sum, b) => sum + b.size, 0);
          events.push({
            ts: settleTs,
            kind: "LOST",
            outcome: s.outcome,
            outcomeIndex: s.outcomeIndex,
            conditionId: s.conditionId,
            title: s.title,
            slug: s.slug,
            size: totalSize,
            price: 0,
            cost: 0, fee: 0,
            netAmount: 0,              // zeroing out produces no cash flow (the money was already spent at buy time)
            transactionHash: s.buys[0].transactionHash,
            strategySource: s.strategySource,
            positionPnl: s.netPnl,     // real PnL of this position = -buy cost - fee
            positionStatus: "settled_lost",
          });
        }
      }
    }
    const filtered = sinceSec > 0 ? events.filter(e => e.ts >= sinceSec) : events;
    filtered.sort((a, b) => b.ts - a.ts);
    return limit ? filtered.slice(0, limit) : filtered;
  }

  /**
   * Unified stats snapshot (frontend panel / monitor page / TG share the same definition)
   *
   * Rules:
   *   - One trade = one trading window (deduped by conditionId) that has had a BUY
   *   - Settled = the window has either a SELL/REDEEM, or satisfies "window settlement time has passed + no sell, no redeem" (fallback, to handle the case where PM /positions does not return small positions)
   *   - Win = the window's net PnL > 0
   *
   * sinceSec=0 means all history; other values are Unix seconds, counting only positions with firstTs >= sinceSec
   */
  computeSnapshot(sinceSec: number = 0): {
    positions: number;        // total count (number of windows, including unsettled)
    closedPositions: number;  // number of settled trades
    wins: number;             // number of settled trades with net PnL > 0
    netPnl: number;           // net PnL (sum of settled positions + unsettled floating loss i.e. -buyCost-fee also counted, consistent with the frontend recalcTotal behavior)
    totalFee: number;
    buyCost: number;
    sellRevenue: number;
    redeemRevenue: number;
  } {
    const summaries = summarizePositions(this.trades, this.redeems, this.positions, this.strategySources);
    const nowSec = Math.floor(Date.now() / 1000);

    // Dedupe by conditionId into "windows", merging stats of multiple outcomes within the same cond
    interface WinRow {
      conditionId: string;
      firstTs: number;
      hasBuy: boolean;
      hasSettled: boolean;       // sells/redeems/settlement time has passed
      buyCost: number;
      sellRevenue: number;
      redeemRevenue: number;
      totalFee: number;
    }
    const windows = new Map<string, WinRow>();

    for (const s of summaries) {
      // Skip those never bought (defensive)
      if (s.buys.length === 0) continue;
      const cond = s.conditionId;
      let row = windows.get(cond);
      if (!row) {
        row = {
          conditionId: cond,
          firstTs: s.firstTs,
          hasBuy: false,
          hasSettled: false,
          buyCost: 0,
          sellRevenue: 0,
          redeemRevenue: 0,
          totalFee: 0,
        };
        windows.set(cond, row);
      }
      row.hasBuy = true;
      row.firstTs = Math.min(row.firstTs, s.firstTs);
      row.buyCost += s.buyCost;
      row.sellRevenue += s.sellRevenue;
      row.redeemRevenue += s.redeemRevenue;
      row.totalFee += s.totalFee;

      // Whether this outcome is settled
      const outcomeSettled =
        s.sells.length > 0 ||
        s.redeems.length > 0 ||
        s.status === "settled_lost" ||
        // Fallback: windowStart has passed + no sell, no redeem (PM /positions may not return small positions settled to zero)
        (s.windowStart > 0 && nowSec >= s.windowStart + 300 && s.sells.length === 0 && s.redeems.length === 0);
      if (outcomeSettled) row.hasSettled = true;
    }

    // Apply the sinceSec filter
    const filtered = sinceSec > 0
      ? [...windows.values()].filter(w => w.firstTs >= sinceSec)
      : [...windows.values()];

    let positions = 0, closedPositions = 0, wins = 0;
    let netPnl = 0, totalFee = 0, buyCost = 0, sellRevenue = 0, redeemRevenue = 0;
    for (const w of filtered) {
      if (!w.hasBuy) continue;
      positions++;
      buyCost += w.buyCost;
      sellRevenue += w.sellRevenue;
      redeemRevenue += w.redeemRevenue;
      totalFee += w.totalFee;
      const winNet = w.sellRevenue + w.redeemRevenue - w.buyCost - w.totalFee;
      netPnl += winNet;
      if (w.hasSettled) {
        closedPositions++;
        if (winNet > 0) wins++;
      }
    }
    return { positions, closedPositions, wins, netPnl, totalFee, buyCost, sellRevenue, redeemRevenue };
  }

  /** Total PnL (last 7 days only by default; pass sinceDays=0 for all) */
  getTotalPnl(sinceDays: number = 7): { totalBuy: number; totalSell: number; totalRedeem: number; totalFee: number; netPnl: number; positionCount: number } {
    const sinceSec = sinceDays > 0 ? Math.floor(Date.now() / 1000) - sinceDays * 86400 : 0;
    let totalBuy = 0, totalSell = 0, totalRedeem = 0, totalFee = 0;
    let count = 0;
    for (const t of this.trades) {
      if (sinceSec > 0 && t.timestamp < sinceSec) continue;
      if (t.side === "BUY") totalBuy += t.size * t.price;
      else totalSell += t.size * t.price;
      totalFee += feeOf(t.side, t.size, t.price);
      count++;
    }
    for (const r of this.redeems) {
      if (sinceSec > 0 && r.timestamp < sinceSec) continue;
      totalRedeem += r.usdcSize;
    }
    return {
      totalBuy, totalSell, totalRedeem, totalFee,
      netPnl: totalSell + totalRedeem - totalBuy - totalFee,
      positionCount: count,
    };
  }

  isInitialized(): boolean {
    return this.initialized;
  }
}
