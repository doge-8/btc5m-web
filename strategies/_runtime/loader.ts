/**
 * Strategy dynamic loader (plugin-ization core)
 *
 * On startup, automatically scans the following directories:
 *   - strategies/*.ts          main project built-in strategies
 *   - strategies/extensions/*  optional extension strategies (can be gitignored)
 *
 * As long as the filename matches sN.ts (s1 ~ s999), it is automatically imported and registered.
 * The main project code needs no changes anywhere, including types.ts / registry.ts.
 */

import { readdirSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { IStrategy } from "../types.js";
import { __setStrategyKeys } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STRATEGIES_DIR = resolve(__dirname, "..");
const EXTENSIONS_DIR = resolve(__dirname, "..", "extensions");

/** Recognize strategy filenames: <letter prefix><number>.ts  (e.g. s1.ts, d1.ts, p1.ts, m1.ts, le1.ts) */
/** Excludes the _core / _runtime / extensions subdirectory names, and shared modules like s6-core.ts (containing `-`) */
const STRATEGY_FILE_REGEX = /^([a-z]+)(\d+)\.ts$/;

interface LoadedFile {
  filePath: string;
  prefix: string;  // letter prefix, used for sorting
  number: number;  // numeric part
  source: "core" | "ext";
}

function scanDir(dir: string, source: "core" | "ext"): LoadedFile[] {
  if (!existsSync(dir)) return [];
  const files: LoadedFile[] = [];
  for (const f of readdirSync(dir)) {
    const match = f.match(STRATEGY_FILE_REGEX);
    if (!match) continue;
    files.push({
      filePath: resolve(dir, f),
      prefix: match[1],
      number: parseInt(match[2], 10),
      source,
    });
  }
  return files;
}

const strategies: Map<string, IStrategy> = new Map();
let loaded = false;

/** Called on startup to dynamically load all strategy files */
export async function loadAllStrategies(): Promise<IStrategy[]> {
  if (loaded) return [...strategies.values()];

  const files = [
    ...scanDir(STRATEGIES_DIR, "core"),
    ...scanDir(EXTENSIONS_DIR, "ext"),
  ].sort((a, b) => a.number - b.number);

  const instances: IStrategy[] = [];
  for (const f of files) {
    try {
      const url = pathToFileURL(f.filePath).href;
      const mod = await import(url);
      // Supports two export styles:
      //   1) Old-style class: `export class S1Enhanced implements IStrategy`, using `new ClassName()`
      //   2) New style: `export default defineStrategy({...})` or `export default <IStrategy instance>`
      let instance: IStrategy | null = null;

      if (mod.default) {
        // New style: default export
        if (typeof mod.default === "function") {
          instance = new mod.default();
        } else {
          instance = mod.default as IStrategy;
        }
      } else {
        // Old style: find the first class export
        for (const key of Object.keys(mod)) {
          const v = mod[key];
          if (typeof v === "function" && /^[A-Z]/.test(key)) {
            instance = new v();
            break;
          }
        }
      }

      if (!instance || typeof instance.checkEntry !== "function") {
        console.warn(`[StrategyLoader] ${f.filePath} no valid strategy instance found, skipping`);
        continue;
      }

      strategies.set(instance.key, instance);
      instances.push(instance);
    } catch (err) {
      console.warn(`[StrategyLoader] failed to load ${f.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Sort by key: first by letter prefix (d<l<p<t), then by number (d1 < d2)
  instances.sort(sortByKey);

  // Sync to types.ts global arrays (for backward compatibility with old code)
  __setStrategyKeys(
    instances.map(s => s.key),
    instances.map(s => s.number),
  );

  loaded = true;
  console.log(`[StrategyLoader] loaded ${instances.length} strategies: ${instances.map(s => s.key).join(", ")}`);
  return instances;
}

export function getStrategy(key: string): IStrategy | undefined {
  return strategies.get(key);
}

function sortByKey(a: IStrategy, b: IStrategy): number {
  const [, aPrefix = "", aNum = "0"] = a.key.match(/^([a-z]+)(\d+)?$/) ?? [];
  const [, bPrefix = "", bNum = "0"] = b.key.match(/^([a-z]+)(\d+)?$/) ?? [];
  if (aPrefix !== bPrefix) return aPrefix.localeCompare(bPrefix);
  return parseInt(aNum, 10) - parseInt(bNum, 10);
}

export function getAllStrategies(): IStrategy[] {
  return [...strategies.values()].sort(sortByKey);
}

export function getAllStrategyKeys(): string[] {
  return getAllStrategies().map(s => s.key);
}
