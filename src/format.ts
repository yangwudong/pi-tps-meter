// Display formatting and tier colouring, ported from opencode-tps-meter/tui.tsx, plus the layout
// of the thinking particle stream and right alignment.
// Pure: no pi imports. The caller decides whether the host renders ANSI.

import type { MeterReading } from "./core.ts"
import type { Rgb, SpinnerCell } from "./spinner.ts"

export type TpsTiers = { slow: number; normal: number; fast: number }
export type TtftTiers = { fast: number; ok: number }
export type Tiers = { tps: TpsTiers; ttft: TtftTiers }

export type SpeedTier = "slow" | "normal" | "fast" | "faster"
export type TtftTier = "fast" | "ok" | "slow"

// The original painted with opencode theme slots (error / warning / success / accent, labels in
// textMuted). A pi status line is a plain string, so each slot maps to its basic ANSI colour.
export type Hue = "red" | "yellow" | "green" | "cyan" | "muted"

// Precision follows magnitude: two decimals while the number is small, an integer once three
// digits would make the decimal noise.
export function formatTps(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined
  if (value >= 100) return Math.round(value).toString()
  if (value >= 10) return value.toFixed(1)
  return value.toFixed(2)
}

export function formatTtft(valueMs: number): string | undefined {
  if (!Number.isFinite(valueMs) || valueMs < 0) return undefined
  return `${(valueMs / 1000).toFixed(1)}s`
}

// Lower bounds are inclusive: exactly 20 TPS is "normal", exactly 10s of TTFT is "ok".
export function speedTier(tps: number, c: TpsTiers): SpeedTier {
  if (tps < c.slow) return "slow"
  if (tps < c.normal) return "normal"
  if (tps < c.fast) return "fast"
  return "faster"
}

export function ttftTier(ms: number, c: TtftTiers): TtftTier {
  if (ms < c.fast) return "fast"
  if (ms < c.ok) return "ok"
  return "slow"
}

export function speedHue(tier: SpeedTier): Hue {
  switch (tier) {
    case "slow": return "red" // theme.error
    case "normal": return "yellow" // theme.warning
    case "fast": return "green" // theme.success
    case "faster": return "cyan" // theme.accent
  }
}

// TTFT is lower-is-better, so its scale runs the other way.
export function ttftHue(tier: TtftTier): Hue {
  switch (tier) {
    case "fast": return "green"
    case "ok": return "yellow"
    case "slow": return "red"
  }
}

// Each code is closed by its own reset (39 = default foreground, 22 = normal intensity) rather
// than a blanket \x1b[0m, so the line never cancels styling the host wraps around it.
const SGR: Record<Hue, [open: string, close: string]> = {
  red: ["\x1b[31m", "\x1b[39m"],
  yellow: ["\x1b[33m", "\x1b[39m"],
  green: ["\x1b[32m", "\x1b[39m"],
  cyan: ["\x1b[36m", "\x1b[39m"],
  muted: ["\x1b[2m", "\x1b[22m"],
}

export function paint(text: string, hue: Hue): string {
  const [open, close] = SGR[hue]
  return `${open}${text}${close}`
}

type Cell = { text: string; hue: Hue }

// A missing reading is "--" in the muted colour, like the original's idle state.
const DASH: Cell = { text: "--", hue: "muted" }

function tpsCell(value: number | undefined, tiers: TpsTiers): Cell {
  const text = value === undefined ? undefined : formatTps(value)
  return value === undefined || text === undefined ? DASH : { text, hue: speedHue(speedTier(value, tiers)) }
}

function ttftCell(valueMs: number | undefined, tiers: TtftTiers): Cell {
  const text = valueMs === undefined ? undefined : formatTtft(valueMs)
  return valueMs === undefined || text === undefined ? DASH : { text, hue: ttftHue(ttftTier(valueMs, tiers)) }
}

// TPS 42.5 | AVG 38.2 | TTFT 0.8s — labels muted; TPS and AVG share the speed tiers.
export function renderLine(reading: MeterReading, tiers: Tiers, color: boolean): string {
  const cells: Cell[] = [
    { text: "TPS ", hue: "muted" },
    tpsCell(reading.tps, tiers.tps),
    { text: " | AVG ", hue: "muted" },
    tpsCell(reading.avg, tiers.tps),
    { text: " | TTFT ", hue: "muted" },
    ttftCell(reading.ttftMs, tiers.ttft),
  ]
  return cells.map((c) => (color ? paint(c.text, c.hue) : c.text)).join("")
}

// Gaps in the stream are U+2800, the empty braille cell: one column, blank on screen, and not
// whitespace. pi's footer sanitizer collapses runs of spaces and trims both ends of a status (JS
// trim() also strips no-break spaces), either of which would make the stream jitter in width.
const GAP = "\u2800"

// The particle stream flows away from the meter. After the reading (status / widget) it runs
// left to right, newest cell next to TTFT, as in the original. Before a right-aligned reading it
// is mirrored, newest cell next to TPS, so the reading itself never moves.
export function withSpinner(
  line: string,
  cells: SpinnerCell[],
  paintRgb: (text: string, color: Rgb) => string,
  side: "before" | "after",
): string {
  const ordered = side === "after" ? cells : [...cells].reverse()
  const stream = ordered.map((c) => (c.glyph === " " ? GAP : paintRgb(c.glyph, c.color))).join("")
  return side === "after" ? `${line} ${stream}` : `${stream} ${line}`
}

// Terminal columns of a string produced here: ANSI SGR codes take none, and every character used
// (ASCII, braille) takes exactly one.
export function visibleWidth(text: string): number {
  return [...text.replace(/\x1b\[[0-9;]*m/g, "")].length
}

// Pads `line` so it ends in the last column. A line too wide for the terminal loses its colours and
// is cut, because a TUI line must never exceed the width it is given.
export function alignRight(line: string, width: number): string {
  const w = visibleWidth(line)
  if (w <= width) return " ".repeat(width - w) + line
  return [...line.replace(/\x1b\[[0-9;]*m/g, "")].slice(w - width).join("")
}
