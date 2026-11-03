// The "thinking" particle stream, ported from opencode-tps-meter/tui.tsx: while reasoning streams,
// a short FIFO of braille dots flows away from the meter, newest cell brightest, older cells fading
// into the muted colour, the bright colour drifting along a gradient over time.
//
// Pure: randomness and the clock are parameters. Colours are plain sRGB; the extension paints them
// through pi's theme, which converts to truecolor or 256 colours for the terminal.

export type Rgb = { r: number; g: number; b: number }

export type SpinnerConfig = { enabled: boolean; colors: Rgb[]; intervalMs: number; cells: number }

export type SpinnerState = { stream: string[]; hueFrame: number; lastFrameAt: number }

export type SpinnerCell = { glyph: string; color: Rgb }

export type Random = () => number

const DOT_GLYPHS = ["⠁", "⠂", "⠄", "⠈", "⠐", "⠠", "⠒", "⠑", "⠡", "⠢", "⠤", "⠨", "⠰", "⠸", "⠘", "⠔", "⠖", "⠦"]

// One full sweep of the gradient takes this many frames (6s at the default 100ms).
const HUE_FRAMES = 60

export const THEME_PRESETS: Record<string, string[]> = {
  tech: ["#00e5ff", "#2979ff", "#651fff"],
  red: ["#ff1744", "#ff5252", "#ff8a80"],
}

// "#rrggbb" or "#rgb". The leading # is required: without it, words such as "bad" or "add" would
// read as three-digit colours.
export function parseHex(hex: string): Rgb | undefined {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return undefined
  const h = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1]
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export function lerpColor(a: Rgb, b: Rgb, t: number): Rgb {
  return { r: Math.round(lerp(a.r, b.r, t)), g: Math.round(lerp(a.g, b.g, t)), b: Math.round(lerp(a.b, b.b, t)) }
}

// Position t in [0, 1] along a multi-stop gradient.
export function gradientColor(colors: Rgb[], t: number): Rgb {
  if (colors.length === 0) return { r: 136, g: 136, b: 136 }
  if (colors.length === 1) return colors[0]
  const c = Math.max(0, Math.min(1, t))
  const seg = c * (colors.length - 1)
  const i = Math.min(Math.floor(seg), colors.length - 2)
  return lerpColor(colors[i], colors[i + 1], seg - i)
}

// Roughly one cell in five is a gap, so the stream reads as particles rather than a solid bar.
function spawnGlyph(random: Random): string {
  return random() < 0.18 ? " " : DOT_GLYPHS[Math.floor(random() * DOT_GLYPHS.length)]
}

// A fresh stream each time thinking starts, so consecutive thinking spans do not look identical.
export function createSpinner(cells: number, now: number, random: Random): SpinnerState {
  return { stream: Array.from({ length: cells }, () => spawnGlyph(random)), hueFrame: 0, lastFrameAt: now }
}

// Frames follow wall time (one per `intervalMs`), not render calls, so the stream keeps its speed
// whatever the refresh rate. The frame count is capped so a long pause cannot loop for ages.
export function advanceSpinner(state: SpinnerState, cfg: SpinnerConfig, now: number, random: Random): void {
  const due = Math.floor((now - state.lastFrameAt) / cfg.intervalMs)
  if (due <= 0) return
  for (let i = 0; i < Math.min(due, cfg.cells); i++) {
    state.stream.unshift(spawnGlyph(random))
    if (state.stream.length > cfg.cells) state.stream.length = cfg.cells
  }
  state.hueFrame += due
  state.lastFrameAt += due * cfg.intervalMs
}

// Cell 0 is the newest and carries the current gradient colour; each older cell fades a step
// further toward `muted`. Gaps stay muted.
export function spinnerCells(state: SpinnerState, cfg: SpinnerConfig, muted: Rgb): SpinnerCell[] {
  const bright = gradientColor(cfg.colors, (state.hueFrame % HUE_FRAMES) / HUE_FRAMES)
  const last = Math.max(1, state.stream.length - 1)
  return state.stream.map((glyph, i) => ({ glyph, color: glyph === " " ? muted : lerpColor(bright, muted, i / last) }))
}
