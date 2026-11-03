// Measurement core, ported from opencode-tps-meter/tui.tsx (the porting source of truth).
//
// Pure state machine: every function takes the clock as a parameter (`at` / `now`). Nothing
// here reads Date.now(), performs IO, or knows about pi — extensions/index.ts maps pi events
// onto these calls. The constants and the window / calibration / AVG arithmetic are the
// original's, unchanged; deviations are limited to the host mapping and are commented inline.

export const WINDOW_MS = 5_000
export const STALE_MS = 1_500
export const MIN_DURATION_MS = 1_000
export const MAX_CALIBRATION_RATIOS = 10

export type DeltaSample = { at: number; rawTokens: number }

export type SessionStats = {
  totalOutputTokens: number
  totalDurationMs: number
  calibrationRatios: number[]
}

// Which stream a delta came from. All three are generated output and all are inside
// usage.output, but only text/thinking may end the TTFT wait.
export type DeltaKind = "text" | "thinking" | "toolcall"

// The original kept one map per field, keyed by sessionID / messageID, because one opencode
// TUI watches many sessions. A pi extension instance belongs to exactly one session and pi
// streams one assistant message at a time, so each map collapses to a single field (the
// original field is named on the right).
export type MeterState = {
  samples: DeltaSample[] // samplesBySession
  stats: SessionStats // statsBySession
  turnStartedAt: number | undefined // when the current turn (one LLM request) began
  streaming: boolean // between an assistant message_start and its message_end
  ttftOrigin: number | undefined // messageCreatedAt (v1) / step.started (v2)
  firstDeltaAt: number | undefined // firstDeltaByMessage
  lastDeltaAt: number | undefined // lastDeltaByMessage
  estimatedTokens: number // estimatedTokensByMessage
  ttftMs: number | undefined // liveTtftBySession
}

export type MeterReading = {
  tps: number | undefined
  avg: number | undefined
  ttftMs: number | undefined
}

// UTF-8 bytes / 4. Deliberately crude: CJK text (3 bytes per character) and code tokenize very
// differently, and the calibration factor below corrects whatever bias the content mix has.
export function estimateTokens(delta: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(delta, "utf8") / 4))
}

// Median, not mean: one odd message (reasoning the provider bills but never streams, a huge
// tool payload) must not drag the factor used for the next ten messages.
export function median(values: number[]): number {
  if (values.length === 0) return 1.0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 !== 0) return sorted[mid]
  return Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 1e10) / 1e10
}

// 1.0 until the first message completes: the raw byte estimate is the best guess there is.
export function calibrationFactor(ratios: number[]): number {
  return ratios.length === 0 ? 1.0 : median(ratios)
}

// The span is wall clock (now - oldest sample), never a sum of inter-arrival gaps: providers
// batch several tokens into one network chunk, and summing the near-zero gaps between batched
// deltas inflates the rate. MIN_DURATION_MS keeps the first chunk of a stream from reading as
// a spike; STALE_MS blanks the reading once the stream pauses instead of letting it decay.
export function calculateLiveTps(samples: DeltaSample[], now: number, calibration: number): number | undefined {
  if (samples.length === 0) return undefined
  const cutoff = now - WINDOW_MS
  const relevant = samples.filter((s) => s.at >= cutoff)
  if (relevant.length === 0) return undefined
  const last = relevant[relevant.length - 1]
  if (now - last.at > STALE_MS) return undefined
  const oldest = relevant[0]
  const durationMs = Math.max(now - oldest.at, MIN_DURATION_MS)
  const totalRaw = relevant.reduce((sum, s) => sum + s.rawTokens, 0)
  return (totalRaw * calibration) / (durationMs / 1000)
}

export function createMeterState(): MeterState {
  return {
    samples: [],
    stats: { totalOutputTokens: 0, totalDurationMs: 0, calibrationRatios: [] },
    turnStartedAt: undefined,
    streaming: false,
    ttftOrigin: undefined,
    firstDeltaAt: undefined,
    lastDeltaAt: undefined,
    estimatedTokens: 0,
    ttftMs: undefined,
  }
}

// turn_start: one pi turn is one LLM request — the counterpart of the original's
// session.step.started, i.e. "when the LLM call begins". pi's message_start cannot be the
// origin: pi emits it when the provider stream opens, after the HTTP response headers, and most
// backends only send those once queueing and prefill are done. Measured from message_start,
// TTFT reads ~0ms (observed: headers after 2.2s, message_start and the first delta in the same
// millisecond).
export function startTurn(state: MeterState, at: number): void {
  state.turnStartedAt = at
}

// message_start of an assistant message: a new generation begins. The previous TTFT is cleared
// here rather than at turn_end, so the old reading stays on screen through tool runs and the
// wait for the next response. Falls back to `at` when no turn_start was seen.
export function startMessage(state: MeterState, at: number): void {
  state.streaming = true
  state.ttftOrigin = state.turnStartedAt ?? at
  state.turnStartedAt = undefined
  state.ttftMs = undefined
  state.firstDeltaAt = undefined
  state.lastDeltaAt = undefined
  state.estimatedTokens = 0
  state.samples = []
}

// One streamed chunk (the original's recordDelta). Every kind feeds the window, the span and the
// calibration estimate, because usage.output counts all of them and tool-call arguments (edit /
// write payloads) are a large share of a coding agent's output: leaving them out would inflate
// the calibration ratio (up to its 3.0 clamp) and AVG, and blank TPS while a long tool call
// streams. Only text/thinking end the TTFT wait.
// Returns true when this delta produced the message's TTFT, so the caller can show it at once.
export function recordDelta(state: MeterState, at: number, delta: string, kind: DeltaKind): boolean {
  const rawTokens = estimateTokens(delta)
  const cutoff = at - WINDOW_MS
  state.samples = [...state.samples.filter((s) => s.at >= cutoff), { at, rawTokens }]
  if (state.firstDeltaAt === undefined) state.firstDeltaAt = at
  state.lastDeltaAt = at
  state.estimatedTokens += rawTokens
  if (kind === "toolcall" || state.ttftMs !== undefined || state.ttftOrigin === undefined) return false
  state.ttftMs = Math.max(0, at - state.ttftOrigin)
  return true
}

// message_end with the provider's authoritative output count (the original's
// recordMessageCompleted). pi's usage.output already includes reasoning tokens; the original
// summed tokens.output + tokens.reasoning only because opencode reports them separately.
export function completeMessage(state: MeterState, outputTokens: number): void {
  const stats = state.stats
  const actualTokens = outputTokens
  const generationMs = state.firstDeltaAt !== undefined && state.lastDeltaAt !== undefined
    ? Math.max(state.lastDeltaAt - state.firstDeltaAt, MIN_DURATION_MS) : 0

  if (actualTokens > 0 && generationMs > 0) {
    stats.totalOutputTokens += actualTokens
    stats.totalDurationMs += generationMs

    const estimated = state.estimatedTokens
    if (estimated > 0) {
      // Clamped so a single pathological message cannot swing the factor arbitrarily.
      const ratio = Math.min(Math.max(actualTokens / estimated, 0.3), 3.0)
      stats.calibrationRatios = [...stats.calibrationRatios, ratio].slice(-MAX_CALIBRATION_RATIOS)
    }
  }
  endMessage(state)
}

// message_end of an errored or aborted message — the counterpart of the original's
// session.step.failed: its usage is partial, so it touches neither AVG nor calibration.
// A TTFT it already produced stays on screen.
export function abandonMessage(state: MeterState): void {
  endMessage(state)
}

// Samples are dropped at the end of every message, as the original did on completion. In pi the
// tools run between messages; samples left in the 5s window would otherwise stretch the next
// message's window across the tool run and dilute its rate.
function endMessage(state: MeterState): void {
  state.streaming = false
  state.ttftOrigin = undefined
  state.firstDeltaAt = undefined
  state.lastDeltaAt = undefined
  state.estimatedTokens = 0
  state.samples = []
}

// What the meter shows at `now` (the original's MeterDisplay sync).
export function readMeter(state: MeterState, now: number): MeterReading {
  const stats = state.stats
  return {
    tps: calculateLiveTps(state.samples, now, calibrationFactor(stats.calibrationRatios)),
    avg: stats.totalDurationMs > 0 ? stats.totalOutputTokens / (stats.totalDurationMs / 1000) : undefined,
    ttftMs: state.ttftMs,
  }
}
