/**
 * Polymarket multi-account monitor server
 *
 * Start: npx tsx monitor-server.ts
 * Open: http://localhost:8080
 *
 * Features:
 *   - Read the accounts.json list
 *   - Serve the monitor.html static page
 *   - Reverse-proxy /api/proxy?port=XXXX → http://localhost:XXXX/api/state?lite=1
 *   - Provide /api/accounts GET/PUT
 *   - Provide /api/tg/* config endpoints + long-polling responses for /status /d commands
 */
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { loadTgConfig, saveTgConfig, autoDetectChatId, sendTgMessage, editTgMessage, deleteTgMessage, answerCallbackQuery, maskToken, TgPoller, type TgConfig, type CallbackContext } from "./tg-push.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.MONITOR_PORT) || 8080;
const ACCOUNTS_FILE = resolve(__dirname, "accounts.json");
const HTML_FILE = resolve(__dirname, "monitor.html");
const HISTORY_FILE = resolve(__dirname, ".balance-history.json");

interface Account { name: string; port: number; enabled?: boolean }
function loadAccounts(includeDisabled = false): Account[] {
  try {
    const data = JSON.parse(readFileSync(ACCOUNTS_FILE, "utf-8"));
    if (Array.isArray(data)) {
      const valid: Account[] = data.filter(a => a && typeof a.name === "string" && typeof a.port === "number");
      if (includeDisabled) return valid;
      return valid.filter(a => a.enabled !== false);  // Enabled by default, only false disables
    }
  } catch (err) {
    console.warn("[monitor] Failed to read accounts.json:", err instanceof Error ? err.message : String(err));
  }
  return [];
}

// ── TG config (memory + file) ──
let tgConfig: TgConfig = loadTgConfig();
function tgConfigPublic(): Record<string, unknown> {
  return {
    enabled: tgConfig.enabled,
    botTokenSet: !!tgConfig.botToken,
    botTokenMasked: maskToken(tgConfig.botToken),
    chatId: tgConfig.chatId,
  };
}

// ── Fetch one machine's state (lite, ~5KB) ──
// On failure, return the cache if it's within 60s, marking it stale + age; TG push and the monitor page share this buffer
type FetchStateResult =
  | { ok: true; state: any; stale?: boolean; staleAgeMs?: number; error?: undefined }
  | { ok: false; state?: undefined; error: string };
const STATE_CACHE_MAX_MS = 60_000;
const _stateCache = new Map<number, { state: any; at: number }>();

async function fetchAccountState(port: number, timeoutMs = 8000): Promise<FetchStateResult> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const r = await fetch(`http://localhost:${port}/api/state?lite=1`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return _fallbackFromCache(port, `HTTP ${r.status}`);
    const state = await r.json();
    _stateCache.set(port, { state, at: Date.now() });
    return { ok: true, state };
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    const cause = (e as { cause?: { code?: string } })?.cause?.code || "";
    let err: string;
    if (cause === "ECONNREFUSED" || raw.includes("ECONNREFUSED")) err = "Connection closed";
    else if (cause === "ETIMEDOUT" || raw.includes("ETIMEDOUT")) err = "Connection timed out";
    else if (raw.includes("aborted") || raw.includes("AbortError")) err = "Request timed out";
    else if (cause === "ECONNRESET" || raw.includes("ECONNRESET")) err = "Connection closed";
    else if (raw === "fetch failed") err = "Connection closed";
    else err = raw.slice(0, 60);
    return _fallbackFromCache(port, err);
  }
}

function _fallbackFromCache(port: number, error: string): FetchStateResult {
  const cached = _stateCache.get(port);
  if (!cached) return { ok: false, error };
  const age = Date.now() - cached.at;
  if (age > STATE_CACHE_MAX_MS) return { ok: false, error };
  return { ok: true, state: cached.state, stale: true, staleAgeMs: age };
}

function fmtUsd(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "" : "-";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

// ── Balance history (record a total-balance snapshot once a day at CST 00:05) ──
interface BalanceSnapshot { total: number; online: number; offline: number; }
type BalanceHistory = Record<string, BalanceSnapshot>;  // key: YYYY-MM-DD (CST)

function loadBalanceHistory(): BalanceHistory {
  try {
    if (!existsSync(HISTORY_FILE)) return {};
    const data = JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    return (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
  } catch (err) {
    console.warn("[monitor] Failed to read .balance-history.json:", err instanceof Error ? err.message : String(err));
    return {};
  }
}
function saveBalanceHistory(h: BalanceHistory): void {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(h, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn("[monitor] Failed to write .balance-history.json:", err instanceof Error ? err.message : String(err));
  }
}

/** CST date string: 2026-05-09 */
function cstDateStr(d = new Date()): string {
  const cn = new Date(d.getTime() + 8 * 3600 * 1000);
  return cn.toISOString().slice(0, 10);
}

/** Fetch all account balances, tally the total + online/offline counts */
async function snapshotAllBalances(): Promise<BalanceSnapshot> {
  const accounts = loadAccounts();
  if (accounts.length === 0) return { total: 0, online: 0, offline: 0 };
  const results = await Promise.all(accounts.map(a => fetchAccountState(a.port)));
  let total = 0, online = 0, offline = 0;
  for (const r of results) {
    if (r.ok && typeof r.state.usdc === "number") {
      total += r.state.usdc;
      online++;
    } else {
      offline++;
    }
  }
  return { total: Math.round(total * 100) / 100, online, offline };
}

/** Record a snapshot (overwrite mode: multiple records on the same day use the latest value) */
async function recordBalanceSnapshot(reason: string): Promise<void> {
  const accounts = loadAccounts();
  if (accounts.length === 0) {
    console.log(`[balance] Skipping snapshot (no accounts), reason: ${reason}`);
    return;
  }
  const snap = await snapshotAllBalances();
  if (snap.online === 0) {
    console.log(`[balance] Skipping snapshot (all offline), reason: ${reason}`);
    return;
  }
  const dateKey = cstDateStr();
  const history = loadBalanceHistory();
  history[dateKey] = snap;
  saveBalanceHistory(history);
  console.log(`[balance] Snapshot saved ${dateKey}: total=$${snap.total.toFixed(2)} online=${snap.online} offline=${snap.offline} (${reason})`);
}

/** Schedule the daily CST 0:05 snapshot trigger */
function scheduleDailyBalanceSnapshot(): void {
  const now = new Date();
  const cnNow = now.getTime() + 8 * 3600 * 1000;
  const next = new Date(cnNow);
  next.setUTCHours(0, 5, 0, 0);
  // If today's 0:05 has already passed, schedule for tomorrow
  if (next.getTime() <= cnNow) next.setUTCDate(next.getUTCDate() + 1);
  const delayMs = next.getTime() - cnNow;
  setTimeout(() => {
    void recordBalanceSnapshot("CST 00:05 scheduled");
    scheduleDailyBalanceSnapshot();  // Schedule the next day
  }, Math.max(60_000, delayMs)).unref?.();
}

/** Backfill on startup: if today has no data yet → record one immediately (avoids losing the day's data after a server restart) */
async function bootstrapBalanceSnapshot(): Promise<void> {
  const dateKey = cstDateStr();
  const history = loadBalanceHistory();
  if (history[dateKey]) {
    console.log(`[balance] Today ${dateKey} already has a snapshot, skipping startup backfill`);
    return;
  }
  // Delay 30 seconds so all accounts can connect before recording
  setTimeout(() => { void recordBalanceSnapshot("startup backfill"); }, 30_000);
}

function fmtPnl(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "-";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

const STATUS_PAGE_SIZE = 10;

// ── Build overview text (tree layout + pagination, offline first) ──
async function buildStatusText(page: number = 1): Promise<{ text: string; page: number; totalPages: number }> {
  const accounts = loadAccounts();
  if (accounts.length === 0) return { text: "⚠ accounts.json is empty, configure accounts on the monitor page first", page: 1, totalPages: 1 };

  const results = await Promise.all(accounts.map(async a => ({
    account: a,
    result: await fetchAccountState(a.port),
  })));

  // Full aggregation (independent of pagination); stale still counts as online
  let online = 0, offline = 0, staleCount = 0;
  let totalUsdc = 0, totalPnl = 0, totalCount = 0, totalClosed = 0, totalWins = 0;
  for (const { result } of results) {
    if (!result.ok) { offline++; continue; }
    online++;
    if (result.stale) staleCount++;
    const s = result.state;
    if (typeof s.usdc === "number") totalUsdc += s.usdc;
    const p = s.pmPnl || {};
    if (typeof p.todayPnl === "number") totalPnl += p.todayPnl;
    if (typeof p.todayCount === "number") totalCount += p.todayCount;
    if (typeof p.todayClosedCount === "number") totalClosed += p.todayClosedCount;
    if (typeof p.todayWins === "number") totalWins += p.todayWins;
  }

  // Sort: offline first, the rest keep accounts.json's original order
  const sorted = [...results].sort((a, b) => {
    const aOff = a.result.ok ? 1 : 0;
    const bOff = b.result.ok ? 1 : 0;
    return aOff - bOff;
  });

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / STATUS_PAGE_SIZE));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const start = (safePage - 1) * STATUS_PAGE_SIZE;
  const pageItems = sorted.slice(start, start + STATUS_PAGE_SIZE);

  const blocks: string[] = [];
  // Name format: account name takes priority (s.accountName), machine name (account.name) as a parenthesized subtitle
  const fmtName = (accName: string | null | undefined, machine: string): string => {
    if (accName && accName !== machine) return `${accName} (${machine})`;
    return machine;
  };
  for (const { account, result } of pageItems) {
    if (!result.ok) {
      blocks.push(`🔴 ${account.name}\n└ ${result.error}`);
      continue;
    }
    const s = result.state;
    const displayName = fmtName(typeof s.accountName === "string" ? s.accountName : null, account.name);
    const usdc = typeof s.usdc === "number" ? s.usdc : null;
    const p = s.pmPnl || {};
    const todayPnl = typeof p.todayPnl === "number" ? p.todayPnl : null;
    const todayCount = typeof p.todayCount === "number" ? p.todayCount : null;
    const todayClosed = typeof p.todayClosedCount === "number" ? p.todayClosedCount : null;
    const todayWins = typeof p.todayWins === "number" ? p.todayWins : null;

    const market = s.activeMarket?.displayName || "—";
    const cfg = s.strategyConfig || {};
    const fmtStratSize = (key: string): string | null => {
      const lk = String(key).toLowerCase();
      const isLimit = lk.startsWith("l");
      if (isLimit) {
        const sh = cfg.shares?.[lk];
        return typeof sh === "number" ? `${sh} shares` : null;
      }
      const am = cfg.amount?.[lk];
      return typeof am === "number" ? `$${am}` : null;
    };
    const enabledKeys = Object.keys(cfg.enabled || {}).filter(k => cfg.enabled[k]);
    let stratStr: string;
    if (!enabledKeys.length) {
      stratStr = "No strategy enabled";
    } else {
      stratStr = enabledKeys.map(k => {
        const sz = fmtStratSize(k);
        return sz ? `${k.toUpperCase()}(${sz})` : k.toUpperCase();
      }).join(" ");
    }
    const ws = s.wsStatus || {};
    const wsAllOk = ws.user && ws.market && ws.chainlink && ws.binance;
    // stale shows a yellow dot + appends the data age after the name
    const dot = result.stale ? "🟡" : (wsAllOk ? "🟢" : "🟡");
    let staleTag = "";
    if (result.stale) {
      const ageSec = Math.max(1, Math.round((result.staleAgeMs || 0) / 1000));
      staleTag = ageSec >= 60 ? ` ⏳${Math.round(ageSec / 60)}m ago` : ` ⏳${ageSec}s ago`;
    }

    const wrStr = todayClosed && todayClosed > 0
      ? `${Math.round((todayWins ?? 0) / todayClosed * 100)}%(${todayWins ?? 0}/${todayClosed})`
      : "—";

    blocks.push(
      `${dot} ${displayName}${staleTag} · ${market}\n` +
      `├ Balance ${fmtUsd(usdc)} · PnL ${fmtPnl(todayPnl)} · ${todayCount ?? 0} trades\n` +
      `└ Win rate ${wrStr} · Strategy ${stratStr}`
    );
  }

  const winRate = totalClosed > 0 ? `${Math.round((totalWins / totalClosed) * 100)}% (${totalWins}/${totalClosed})` : "—";
  const pageLine = totalPages > 1 ? `\n📄 Page ${safePage}/${totalPages}` : "";
  const head = [
    `📊 Monitor overview`,
    `🕒 ${new Date().toLocaleString("en-US", { hour12: false })}`,
    "",
    `📦 Machines ${accounts.length} (online ${online}${staleCount > 0 ? ` / cached ${staleCount}` : ""} / offline ${offline})`,
    "",
    `💰 Overview`,
    `├ Balance ${fmtUsd(totalUsdc)}`,
    `├ PnL ${fmtPnl(totalPnl)}`,
    `├ Trades ${totalCount}`,
    `└ Win rate ${winRate}`,
    "",
    `📋 Accounts${pageLine}`,
  ].join("\n");
  return { text: head + "\n" + blocks.join("\n\n"), page: safePage, totalPages };
}

/** Build the pagination + refresh inline keyboard */
function buildStatusKeyboard(page: number, totalPages: number): { text: string; callback_data: string }[][] {
  const buttons: { text: string; callback_data: string }[] = [];
  if (totalPages > 1) {
    if (page > 1) buttons.push({ text: "← Prev", callback_data: `status_page:${page - 1}` });
    buttons.push({ text: `${page}/${totalPages}`, callback_data: `noop` });
    if (page < totalPages) buttons.push({ text: "Next →", callback_data: `status_page:${page + 1}` });
  }
  buttons.push({ text: "🔄 Refresh", callback_data: `refresh:${page}` });
  return [buttons];
}

// ── Build single-account detail text ──
async function buildDetailText(name: string): Promise<string> {
  const accounts = loadAccounts();
  const target = accounts.find(a => a.name.toLowerCase() === name.toLowerCase());
  if (!target) {
    const list = accounts.map(a => a.name).join(", ") || "(empty)";
    return `⚠ Account "${name}" not found\n\nAvailable accounts: ${list}`;
  }
  const result = await fetchAccountState(target.port);
  if (!result.ok) return `${target.name} (port=${target.port})\nOffline: ${result.error}`;
  const s = result.state;
  const accName = s.accountName || target.name;
  const market = s.activeMarket?.displayName || "—";
  const usdc = typeof s.usdc === "number" ? s.usdc : null;
  const upPos = typeof s.upLocalSize === "number" ? s.upLocalSize : 0;
  const dnPos = typeof s.downLocalSize === "number" ? s.downLocalSize : 0;
  const lastTrade = s.lastTradeAt;
  const stratState = s.strategy?.state || "—";
  const stratActive = s.strategy?.activeStrategy;
  const enabledKeys = Object.keys(s.strategyConfig?.enabled || {}).filter(k => s.strategyConfig.enabled[k]).map(k => k.toUpperCase());
  const ws = s.wsStatus || {};
  const wsList = Object.entries(ws).map(([k, v]) => `${k}:${v ? "●" : "○"}`).join(" ");
  const p = s.pmPnl || {};

  const lines = [
    `📋 ${accName} (port=${target.port})`,
    `Market: ${market}`,
    `USDC: ${fmtUsd(usdc)}`,
    `Position: Up ${upPos.toFixed(2)} / Down ${dnPos.toFixed(2)}`,
    `Strategy: ${stratActive ? `${String(stratActive).toUpperCase()}·${stratState}` : `Enabled ${enabledKeys.join(" ") || "none"} · ${stratState}`}`,
    `Today: PnL ${fmtPnl(p.todayPnl)} | ${p.todayCount ?? 0} trades | Win rate ${p.todayClosedCount ? Math.round((p.todayWins ?? 0) / p.todayClosedCount * 100) + "%" : "—"} (${p.todayWins ?? 0}/${p.todayClosedCount ?? 0})`,
    `Last fill: ${lastTrade ? new Date(lastTrade).toLocaleString("en-US", { hour12: false }) : "—"}`,
    `WS: ${wsList}`,
  ];
  return lines.join("\n");
}

// ── Command dispatch ──
async function handleTgCommand(cmd: string, args: string, fromChatId: number): Promise<void> {
  // Security: only respond to the configured chatId (prevents strangers from sending commands)
  if (tgConfig.chatId && String(fromChatId) !== tgConfig.chatId) {
    console.warn(`[monitor.TG] Ignoring command from unauthorized chat_id: ${fromChatId}`);
    return;
  }
  if (cmd === "/start" || cmd === "/help") {
    const text = [
      "📊 Polymarket multi-account monitor",
      "",
      "Available commands:",
      "/status — Overview (all accounts)",
      "/d <account name> — Single-account details (e.g. /d T4-A)",
      "/help — Help",
    ].join("\n");
    await sendTgMessage({ ...tgConfig, chatId: String(fromChatId) }, text);
    return;
  }
  if (cmd === "/status" || cmd === "/s") {
    const r = await buildStatusText(1);
    await sendTgMessage({ ...tgConfig, chatId: String(fromChatId) }, r.text, {
      inlineKeyboard: buildStatusKeyboard(r.page, r.totalPages),
    });
    return;
  }
  if (cmd === "/d" || cmd === "/detail") {
    if (!args) {
      await sendTgMessage({ ...tgConfig, chatId: String(fromChatId) }, "Usage: /d <account name>\nExample: /d T4-A");
      return;
    }
    const text = await buildDetailText(args);
    await sendTgMessage({ ...tgConfig, chatId: String(fromChatId) }, text);
    return;
  }
  // Unknown commands are silently ignored
}

async function handleTgCallback(ctx: CallbackContext): Promise<void> {
  // Security: only respond to the authorized chat_id
  if (tgConfig.chatId && String(ctx.fromChatId) !== tgConfig.chatId) {
    await answerCallbackQuery(tgConfig, ctx.callbackQueryId, "Unauthorized");
    return;
  }
  // Compatible with the old refresh_status, plus the new formats status_page:N / refresh:N
  // Refresh (refresh:N): delete+send, triggers the animation, visibly signals a successful refresh
  // Page change (status_page:N): edit in place + top toast, doesn't jump to the bottom of the chat
  if (ctx.messageId && (ctx.data === "refresh_status" || ctx.data.startsWith("refresh:") || ctx.data.startsWith("status_page:"))) {
    const isRefresh = ctx.data === "refresh_status" || ctx.data.startsWith("refresh:");
    let page = 1;
    if (ctx.data.startsWith("refresh:")) {
      page = parseInt(ctx.data.slice("refresh:".length), 10) || 1;
    } else if (ctx.data.startsWith("status_page:")) {
      page = parseInt(ctx.data.slice("status_page:".length), 10) || 1;
    }
    const ackText = isRefresh ? "Refreshed" : `→ Page ${page}`;
    await answerCallbackQuery(tgConfig, ctx.callbackQueryId, ackText);
    const r = await buildStatusText(page);
    const keyboard = buildStatusKeyboard(r.page, r.totalPages);
    if (isRefresh) {
      const delRes = await deleteTgMessage(tgConfig, String(ctx.fromChatId), ctx.messageId);
      if (delRes.ok) {
        await sendTgMessage(tgConfig, r.text, { toChatId: String(ctx.fromChatId), inlineKeyboard: keyboard });
      } else {
        await editTgMessage(tgConfig, String(ctx.fromChatId), ctx.messageId, r.text, { inlineKeyboard: keyboard });
      }
    } else {
      await editTgMessage(tgConfig, String(ctx.fromChatId), ctx.messageId, r.text, { inlineKeyboard: keyboard });
    }
    return;
  }
  if (ctx.data === "noop") {
    await answerCallbackQuery(tgConfig, ctx.callbackQueryId);
    return;
  }
  await answerCallbackQuery(tgConfig, ctx.callbackQueryId);
}

const tgPoller = new TgPoller(() => tgConfig, handleTgCommand, handleTgCallback);
tgPoller.start();

// ── HTTP server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");

  // ── /api/accounts ──
  if (path === "/api/accounts") {
    if (req.method === "GET") {
      // The management panel needs to see disabled accounts; add ?all=1 to return everything; by default only enabled accounts are returned
      const includeDisabled = url.searchParams.get("all") === "1";
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(loadAccounts(includeDisabled)));
      return;
    }
    if (req.method === "PUT") {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        if (!Array.isArray(body)) throw new Error("body must be an array");
        const seen = new Set<number>();
        const cleaned: Account[] = [];
        for (const a of body) {
          if (!a || typeof a.name !== "string" || typeof a.port !== "number") {
            throw new Error("each item must contain name(string) and port(number)");
          }
          const name = a.name.trim();
          const port = Math.floor(a.port);
          if (!name) throw new Error("name cannot be empty");
          if (port < 1 || port > 65535) throw new Error(`port out of range: ${port}`);
          if (seen.has(port)) throw new Error(`duplicate port: ${port}`);
          seen.add(port);
          const item: Account = { name, port };
          if (a.enabled === false) item.enabled = false;  // Only write the field when explicitly disabled, keep enabled items clean
          cleaned.push(item);
        }
        writeFileSync(ACCOUNTS_FILE, JSON.stringify(cleaned, null, 2) + "\n", "utf-8");
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(cleaned));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Save failed", detail: msg }));
      }
      return;
    }
    res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
    return;
  }

  // ── /api/proxy ──
  if (path === "/api/proxy") {
    const port = Number(url.searchParams.get("port"));
    if (!port || port < 1 || port > 65535) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid port" }));
      return;
    }
    const result = await fetchAccountState(port);
    if (result.ok) {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        ...(result.stale ? { "X-State-Stale": "1", "X-State-Age-Ms": String(result.staleAgeMs || 0) } : {}),
      });
      res.end(JSON.stringify(result.state));
    } else {
      res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Upstream unreachable", detail: result.error }));
    }
    return;
  }

  // ── /api/tg/config GET / POST ──
  if (path === "/api/tg/config") {
    if (req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(tgConfigPublic()));
      return;
    }
    if (req.method === "POST") {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
        if (typeof body.enabled === "boolean") tgConfig.enabled = body.enabled;
        // botToken containing *** means the frontend didn't modify it (mask echoed back), skip
        if (typeof body.botToken === "string" && !body.botToken.includes("***")) {
          const oldToken = tgConfig.botToken;
          tgConfig.botToken = body.botToken.trim();
          if (oldToken !== tgConfig.botToken) tgPoller.resetOnTokenChange();
        }
        if (typeof body.chatId === "string") tgConfig.chatId = body.chatId.trim();
        saveTgConfig(tgConfig);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(tgConfigPublic()));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "Save failed", detail: e instanceof Error ? e.message : String(e) }));
      }
      return;
    }
  }

  // ── /api/tg/auto-chat: fetch chat_id from getUpdates ──
  if (path === "/api/tg/auto-chat" && req.method === "POST") {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Record<string, unknown>;
      // Prefer the token in the body (the frontend may have typed it and clicked fetch before saving)
      let token = typeof body.botToken === "string" && !body.botToken.includes("***") ? body.botToken.trim() : "";
      if (!token) token = tgConfig.botToken;
      if (!token) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: "Bot Token not configured" }));
        return;
      }
      const r = await autoDetectChatId(token);
      res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(r));
    } catch (e) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }

  // ── /api/balance-history: return balance snapshots for all dates ──
  if (path === "/api/balance-history" && req.method === "GET") {
    const history = loadBalanceHistory();
    // Wrap once so the frontend can sort by date
    const items = Object.entries(history)
      .map(([date, snap]) => ({ date, ...snap }))
      .sort((a, b) => a.date.localeCompare(b.date));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(items));
    return;
  }

  // ── /api/balance-history/now: trigger a snapshot immediately (for debugging/manual backfill) ──
  if (path === "/api/balance-history/now" && req.method === "POST") {
    void recordBalanceSnapshot("manual trigger");
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, message: "Snapshot triggered, query /api/balance-history in 30 seconds" }));
    return;
  }

  // ── /api/balance-history?date=YYYY-MM-DD: delete the snapshot for the given date ──
  if (path === "/api/balance-history" && req.method === "DELETE") {
    const date = url.searchParams.get("date") || "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "date parameter missing or malformed (need YYYY-MM-DD)" }));
      return;
    }
    const history = loadBalanceHistory();
    if (!(date in history)) {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "No snapshot record for that date" }));
      return;
    }
    delete history[date];
    saveBalanceHistory(history);
    console.log(`[monitor] Deleted balance snapshot: ${date}`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: true, date }));
    return;
  }

  // ── /api/tg/test: push an actual overview immediately (same as /status, with refresh button) ──
  if (path === "/api/tg/test" && req.method === "POST") {
    if (!tgConfig.botToken || !tgConfig.chatId) {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Bot Token or Chat ID not configured" }));
      return;
    }
    const status = await buildStatusText(1);
    const r = await sendTgMessage(tgConfig, status.text, {
      inlineKeyboard: buildStatusKeyboard(status.page, status.totalPages),
    });
    res.writeHead(r.ok ? 200 : 400, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(r));
    return;
  }

  // ── Static files ──
  if (path === "/" || path === "/monitor.html") {
    if (existsSync(HTML_FILE)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(HTML_FILE));
    } else {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("monitor.html does not exist");
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(PORT, () => {
  const accounts = loadAccounts();
  console.log(`✓ Monitor server started`);
  console.log(`  URL: http://localhost:${PORT}`);
  console.log(`  Accounts: ${accounts.length}`);
  if (accounts.length > 0) {
    accounts.forEach(a => console.log(`    - ${a.name} (port=${a.port})`));
  } else {
    console.log(`  ⚠ accounts.json is empty or missing, please edit ${ACCOUNTS_FILE}`);
  }
  if (tgConfig.enabled && tgConfig.botToken) {
    console.log(`✓ TG bot started (chatId=${tgConfig.chatId || "not configured"})`);
  } else {
    console.log(`  TG bot not enabled (configure it in the top-right of the monitor page)`);
  }
  // Balance history collection: backfill today on startup + schedule tomorrow's auto snapshot at 0:05
  void bootstrapBalanceSnapshot();
  scheduleDailyBalanceSnapshot();
});

process.on("SIGINT", () => {
  console.log("\n[monitor] Received SIGINT, exiting");
  tgPoller.stop();
  server.close();
  process.exit(0);
});
