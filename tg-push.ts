/**
 * Telegram push module
 *
 * Features:
 *   - Scheduled push of account status (balance, PnL, enabled strategies, latest 5 trades)
 *   - Bot Token / Chat ID / frequency configurable from the frontend
 *   - Config persisted to .tg-config.json
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TG_CONFIG_FILE = resolve(__dirname, ".tg-config.json");

export interface TgConfig {
  enabled: boolean;              // Master switch: when off, no push is sent at all
  botToken: string;
  chatId: string;
  intervalMinutes: number;       // Scheduled push frequency (minutes), minimum 5
  scheduledEnabled: boolean;     // Whether to enable scheduled push
  postTradeEnabled: boolean;     // Whether to enable the "10 minutes after buy MINED" push
}

const DEFAULT_CONFIG: TgConfig = {
  enabled: false,
  botToken: "",
  chatId: "",
  intervalMinutes: 60,
  scheduledEnabled: true,
  postTradeEnabled: false,
};

export function loadTgConfig(): TgConfig {
  try {
    if (!existsSync(TG_CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    const raw = JSON.parse(readFileSync(TG_CONFIG_FILE, "utf-8"));
    return {
      enabled: !!raw.enabled,
      botToken: typeof raw.botToken === "string" ? raw.botToken : "",
      chatId: typeof raw.chatId === "string" ? raw.chatId : "",
      intervalMinutes: typeof raw.intervalMinutes === "number" && raw.intervalMinutes >= 5
        ? raw.intervalMinutes
        : 60,
      // Backward compatibility: when an old config lacks these two fields, scheduled push defaults to on (keeps original behavior), post-trade push defaults to off
      scheduledEnabled: typeof raw.scheduledEnabled === "boolean" ? raw.scheduledEnabled : true,
      postTradeEnabled: typeof raw.postTradeEnabled === "boolean" ? raw.postTradeEnabled : false,
    };
  } catch (err) {
    console.warn(`[TG] Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
    return { ...DEFAULT_CONFIG };
  }
}

export function saveTgConfig(cfg: TgConfig): void {
  try {
    writeFileSync(TG_CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  } catch (err) {
    console.warn(`[TG] Failed to save config: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Auto-detect Chat ID via getUpdates (only available after the user has sent the bot a message) */
export async function autoDetectChatId(botToken: string): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  if (!botToken) return { ok: false, error: "Bot Token is empty" };
  const url = `https://api.telegram.org/bot${botToken}/getUpdates`;
  try {
    const res = await fetch(url);
    const data = await res.json() as { ok: boolean; result?: Array<{ message?: { chat?: { id?: number } } }>; description?: string };
    if (!data.ok) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    const results = data.result || [];
    if (results.length === 0) {
      return { ok: false, error: "No messages found. Please first send the bot a message in Telegram (e.g. /start), then try again" };
    }
    // Take the chat.id of the last message
    for (let i = results.length - 1; i >= 0; i--) {
      const id = results[i].message?.chat?.id;
      if (typeof id === "number") {
        return { ok: true, chatId: String(id) };
      }
    }
    return { ok: false, error: "chat.id not found in messages" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Send a text message to Telegram */
export async function sendTgMessage(cfg: TgConfig, text: string): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.botToken || !cfg.chatId) {
    return { ok: false, error: "Bot Token or Chat ID not configured" };
  }
  const url = `https://api.telegram.org/bot${cfg.botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        disable_web_page_preview: true,
      }),
    });
    const data = await res.json() as { ok: boolean; description?: string };
    if (!data.ok) {
      return { ok: false, error: data.description || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
