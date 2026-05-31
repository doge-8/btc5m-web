/**
 * Strategy registry —— public interface layer
 *
 * After plugin-ization, the actual loading logic lives in `_runtime/loader.ts`.
 * This file is kept as the public interface so server.ts's imports do not need to change.
 *
 * Startup flow: server.ts awaits initStrategies() on startup, after which other modules can make calls.
 */

import type { IStrategy, StrategyDescription } from "./types.js";
import {
  loadAllStrategies,
  getStrategy as _getStrategy,
  getAllStrategies as _getAllStrategies,
  getAllStrategyKeys as _getAllStrategyKeys,
} from "./_runtime/loader.js";

let ready = false;

/** Must be called once on startup (server.ts awaits it before server.listen) */
export async function initStrategies(): Promise<void> {
  if (ready) return;
  await loadAllStrategies();
  ready = true;
}

export function getStrategy(key: string): IStrategy | undefined {
  return _getStrategy(key);
}

export function getAllStrategies(): IStrategy[] {
  return _getAllStrategies();
}

export function getAllStrategyKeys(): string[] {
  return _getAllStrategyKeys();
}

export function getAllDescriptions(): StrategyDescription[] {
  return _getAllStrategies().map(s => s.getDescription());
}
