/**
 * Monitor Telegram module (independent of the main project's tg-push)
 *
 * Features:
 *   - Config persisted to monitor/.tg-config.json
 *   - Auto-fetch chat_id (only available after the user has messaged the bot)
 *   - Long-poll getUpdates to receive and respond to commands
 *   - Commands: /status overview, /d <account name> single account, /help
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TG_CONFIG_FILE = resolve(__dirname, ".tg-config.json");

export interface TgConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

const DEFAULT_CONFIG: TgConfig = {
  enabled: false,
  botToken: "",
  chatId: "",
};

export function loadTgConfig(): TgConfig {
  try {
    if (!existsSync(TG_CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(TG_CONFIG_FILE, "utf-8"));
    return {
      enabled: !!raw.enabled,
      botToken: typeof raw.botToken === "string" ? raw.botToken : "",
      chatId: typeof raw.chatId === "string" ? raw.chatId : "",
    };
  } catch (err) {
    console.warn(`[monitor.TG] Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveTgConfig(cfg: TgConfig): void {
  try {
    writeFileSync(TG_CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[monitor.TG] Failed to save config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length < 14) return token.slice(0, 4) + "***";
  return token.slice(0, 10) + "***" + token.slice(-4);
}

/** Auto-fetch chat_id: the user must have sent the bot any message (e.g. /start) before updates exist */
export async function autoDetectChatId(botToken: string): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  if (!botToken) return { ok: false, error: "Bot Token is empty" };
  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  try {
    const res = await fetch(url);
    const data = await res.json() as { ok: boolean; result?: Array<{ message?: { chat?: { id?: number } } }>; description?: string };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
    const results = data.result || [];
    if (results.length === 0) return { ok: false, error: "No message found. Send the bot a message in Telegram first (e.g. /start), then try again" };
    for (let i = results.length - 1; i >= 0; i--) {
      const id = results[i].message?.chat?.id;
      if (typeof id === "number") return { ok: true, chatId: String(id) };
    }
    return { ok: false, error: "chat.id not found in the message" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface InlineButton { text: string; callback_data: string; }
export interface SendOpts {
  parseMode?: "Markdown" | "MarkdownV2" | "HTML";
  inlineKeyboard?: InlineButton[][];
  /** Specify a chatId to override cfg.chatId (used when responding to someone else's command) */
  toChatId?: string;
}

/** Send a message */
export async function sendTgMessage(cfg: TgConfig, text: string, opts: SendOpts = {}): Promise<{ ok: boolean; error?: string; messageId?: number }> {
  const targetChat = opts.toChatId || cfg.chatId;
  if (!cfg.botToken || !targetChat) return { ok: false, error: "Bot Token or Chat ID not configured" };
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  try {
    const body: Record<string, unknown> = {
      chat_id: targetChat,
      text,
      disable_web_page_preview: true,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { ok: boolean; description?: string; result?: { message_id?: number } };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
    return { ok: true, messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Delete a message (used by the "🔄 Refresh" button: delete the old one then send a new one, triggering TG's animation to signal a successful refresh) */
export async function deleteTgMessage(cfg: TgConfig, chatId: string, messageId: number): Promise<{ ok: boolean; error?: string }> {
  const url = `https://api.telegram.org/bot${cfg.botToken}/deleteMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) return { ok: false, error: data.description || `HTTP ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Edit an existing message (kept as a fallback; currently refresh uses the delete+send path) */
export async function editTgMessage(cfg: TgConfig, chatId: string, messageId: number, text: string, opts: { inlineKeyboard?: InlineButton[][]; parseMode?: "Markdown" | "MarkdownV2" | "HTML" } = {}): Promise<{ ok: boolean; error?: string }> {
  const url = `https://api.telegram.org/bot${cfg.botToken}/editMessageText`;
  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text,
      disable_web_page_preview: true,
    };
    if (opts.parseMode) body.parse_mode = opts.parseMode;
    if (opts.inlineKeyboard) body.reply_markup = { inline_keyboard: opts.inlineKeyboard };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    // "message is not modified" is not an error (TG rejects the edit when content is identical, but semantically it succeeded)
    if (!data.ok) {
      const desc = data.description || "";
      if (desc.includes("message is not modified")) return { ok: true };
      return { ok: false, error: desc || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Answer a callback_query (must ack after a button press, otherwise the TG client keeps spinning) */
export async function answerCallbackQuery(cfg: TgConfig, callbackQueryId: string, text?: string): Promise<void> {
  if (!cfg.botToken) return;
  const url = `https://api.telegram.org/bot${cfg.botToken}/answerCallbackQuery`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
  } catch {
    // Ignore ack errors
  }
}

// ── Long polling ──
export interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string };
    text?: string;
    date: number;
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  };
}

export interface CallbackContext {
  callbackQueryId: string;
  fromChatId: number;
  messageId?: number;
  data: string;
}

/** Long-poll getUpdates */
export class TgPoller {
  private offset = 0;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;
  private currentToken = "";

  constructor(
    private readonly getCfg: () => TgConfig,
    private readonly onCommand: (cmd: string, args: string, fromChatId: number) => Promise<void> | void,
    private readonly onCallback?: (ctx: CallbackContext) => Promise<void> | void,
  ) {}

  start(): void {
    this.stopped = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
  }

  /** Called when the token changes - resets offset to avoid getting stuck on 401 */
  resetOnTokenChange(): void {
    this.offset = 0;
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      const cfg = this.getCfg();
      // Idle when config is invalid, check every 2s
      if (!cfg.enabled || !cfg.botToken) {
        if (this.currentToken !== cfg.botToken) this.offset = 0;
        this.currentToken = cfg.botToken;
        await this.sleep(2000);
        continue;
      }
      // token changed → reset offset
      if (this.currentToken !== cfg.botToken) {
        this.offset = 0;
        this.currentToken = cfg.botToken;
      }
      try {
        const url = `https://api.telegram.org/bot${cfg.botToken}/getUpdates?timeout=25&offset=${this.offset}`;
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30_000);
        const res = await fetch(url, { signal: ctrl.signal });
        clearTimeout(timer);
        const data = await res.json() as { ok: boolean; result?: TgUpdate[]; description?: string };
        if (!data.ok) {
          console.warn(`[monitor.TG] getUpdates failed: ${data.description || res.status}`);
          await this.sleep(5000);
          continue;
        }
        for (const update of data.result || []) {
          this.offset = Math.max(this.offset, update.update_id + 1);
          // callback_query: button click
          if (update.callback_query && this.onCallback) {
            const cq = update.callback_query;
            try {
              await this.onCallback({
                callbackQueryId: cq.id,
                fromChatId: cq.from.id,
                messageId: cq.message?.message_id,
                data: cq.data || "",
              });
            } catch (err) {
              console.warn(`[monitor.TG] Error handling callback: ${err instanceof Error ? err.message : String(err)}`);
            }
            continue;
          }
          const msg = update.message;
          if (!msg || typeof msg.text !== "string") continue;
          const text = msg.text.trim();
          if (!text.startsWith("/")) continue;
          const space = text.indexOf(" ");
          // Command may carry an @bot suffix (in groups), strip it
          let cmd = (space === -1 ? text : text.slice(0, space)).toLowerCase();
          const at = cmd.indexOf("@");
          if (at !== -1) cmd = cmd.slice(0, at);
          const args = space === -1 ? "" : text.slice(space + 1).trim();
          try {
            await this.onCommand(cmd, args, msg.chat.id);
          } catch (err) {
            console.warn(`[monitor.TG] Error handling command: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!this.stopped) {
          console.warn(`[monitor.TG] Long-polling error: ${msg}`);
          await this.sleep(5000);
        }
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.timer = setTimeout(() => { this.timer = null; resolve(); }, ms);
    });
  }
}
