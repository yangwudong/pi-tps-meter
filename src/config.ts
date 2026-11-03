// Display mode persistence and tier overrides — the only module that touches the filesystem.
//
// File: <agent dir>/pi-tps-meter/config.json, where <agent dir> is $PI_CODING_AGENT_DIR or
// ~/.pi/agent, resolved the same way pi resolves its own config directory.
//
//   { "mode": "status", "tiers": { "tps": { "slow": 20, "normal": 50, "fast": 100 },
//                                  "ttft": { "fast": 10000, "ok": 20000 } } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { Tiers } from "./format.ts"

export type DisplayMode = "status" | "widget" | "off"

// Also the cycle order of a bare `/tps`.
export const DISPLAY_MODES: readonly DisplayMode[] = ["status", "widget", "off"]

export type MeterConfig = { mode: DisplayMode; tiers: Tiers }

export type LoadedConfig = { config: MeterConfig; warning?: string }

export type SaveResult = { ok: true } | { ok: false; error: string }

export function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === "string" && (DISPLAY_MODES as readonly string[]).includes(value)
}

export function nextMode(mode: DisplayMode): DisplayMode {
  return DISPLAY_MODES[(DISPLAY_MODES.indexOf(mode) + 1) % DISPLAY_MODES.length]
}

// The original's resolveConfig override shape: `tiers.tps` / `tiers.ttft`, field by field over
// the defaults. Values that are not finite numbers fall back to the default instead of reaching
// the tier comparisons, where a string or null would silently mis-tier every reading.
export function resolveConfig(raw: unknown): MeterConfig {
  const o = isObject(raw) ? raw : {}
  const tiers = isObject(o.tiers) ? o.tiers : {}
  const tp = isObject(tiers.tps) ? tiers.tps : {}
  const tt = isObject(tiers.ttft) ? tiers.ttft : {}
  return {
    mode: isDisplayMode(o.mode) ? o.mode : "status",
    tiers: {
      tps: { slow: num(tp.slow, 20), normal: num(tp.normal, 50), fast: num(tp.fast, 100) },
      ttft: { fast: num(tt.fast, 10_000), ok: num(tt.ok, 20_000) },
    },
  }
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.PI_CODING_AGENT_DIR
  if (!dir) return join(homedir(), ".pi", "agent")
  if (dir === "~") return homedir()
  return dir.startsWith("~/") ? join(homedir(), dir.slice(2)) : dir
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "pi-tps-meter", "config.json")
}

// A missing file is the normal first run. A file that does not parse falls back to the defaults
// with a warning, so a typo in hand-edited tiers is not ignored silently.
export function loadConfig(file: string = configPath()): LoadedConfig {
  const read = readJson(file)
  if (!read.ok) return { config: resolveConfig(undefined), warning: read.error }
  return { config: resolveConfig(read.value) }
}

// Rewrites only `mode` and keeps every other key (hand-edited tiers). A file that does not parse
// as a JSON object is left untouched and reported, rather than replaced by a bare { mode }.
// Never throws: a failed save must not stop the mode switch for the running session.
export function saveMode(mode: DisplayMode, file: string = configPath()): SaveResult {
  const read = readJson(file)
  if (!read.ok) return read
  const current = read.value === undefined ? {} : read.value
  if (!isObject(current)) return { ok: false, error: `${file}: not a JSON object, left unchanged` }
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify({ ...current, mode }, null, 2)}\n`, "utf8")
    return { ok: true }
  } catch (err) {
    return { ok: false, error: `${file}: ${errorMessage(err)}` }
  }
}

type ReadResult = { ok: true; value: unknown } | { ok: false; error: string }

// The single place file text becomes data. A missing file reads as `undefined`.
function readJson(file: string): ReadResult {
  try {
    return { ok: true, value: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined }
  } catch (err) {
    return { ok: false, error: `${file}: ${errorMessage(err)}` }
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
