// pi-tps-meter — live TPS / AVG / TTFT for the pi coding agent.
//
// Port of opencode-tps-meter: the measurement core (src/core.ts) and the formatting
// (src/format.ts) are the original's. This file is the replaced host layer: pi events in,
// a footer status line or a widget above the editor out.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { DISPLAY_MODES, isDisplayMode, loadConfig, nextMode, resolveConfig, saveMode, type DisplayMode, type MeterConfig } from "../src/config.ts"
import { abandonMessage, completeMessage, createMeterState, readMeter, recordDelta, startMessage, startTurn, type DeltaKind, type MeterState } from "../src/core.ts"
import { renderLine } from "../src/format.ts"

// One key for both surfaces: the footer status entry and the widget.
const KEY = "tps-meter"

// ~10Hz: smooth enough for a rolling number without re-rendering on every delta.
const REFRESH_MS = 100

type UI = ExtensionContext["ui"]

export default function tpsMeter(pi: ExtensionAPI): void {
  let state: MeterState = createMeterState()
  // Defaults until session_start reads the file: the factory may run in invocations that never
  // start a session, so it does no IO and starts no timers.
  let config: MeterConfig = resolveConfig(undefined)
  let ui: UI | undefined
  let color = false
  let ticker: ReturnType<typeof setInterval> | undefined
  // What is on screen right now, so unchanged readings cost no re-render.
  let shownMode: DisplayMode | undefined
  let shownLine: string | undefined

  // Handlers re-bind from their own ctx; the ticker only ever uses the latest binding.
  const bind = (ctx: ExtensionContext): void => {
    ui = ctx.hasUI ? ctx.ui : undefined
    // The TUI renders ANSI in status text and widget lines; RPC clients get plain text.
    color = ctx.mode === "tui"
  }

  const render = (): void => {
    if (!ui) return
    const mode = config.mode
    if (mode !== shownMode) {
      // Exactly one surface (or none) shows the meter: clear the one being left.
      if (shownMode === "status") ui.setStatus(KEY, undefined)
      if (shownMode === "widget") ui.setWidget(KEY, undefined)
      shownMode = mode
      shownLine = undefined
    }
    if (mode === "off") return
    const line = renderLine(readMeter(state, Date.now()), config.tiers, color)
    if (line === shownLine) return
    shownLine = line
    if (mode === "status") ui.setStatus(KEY, line)
    else ui.setWidget(KEY, [line])
  }

  const stopTicker = (): void => {
    if (ticker === undefined) return
    clearInterval(ticker)
    ticker = undefined
  }

  // Ticks only while a message streams: that is the only time the reading changes by itself
  // (the window slides, STALE_MS expires). Between messages the line is static.
  const startTicker = (): void => {
    if (ticker !== undefined || !ui || config.mode === "off" || !state.streaming) return
    ticker = setInterval(() => {
      render()
      if (!state.streaming || config.mode === "off") stopTicker()
    }, REFRESH_MS)
    // Never the reason the process stays alive.
    ticker.unref?.()
  }

  pi.on("session_start", (_event, ctx) => {
    stopTicker()
    state = createMeterState()
    const loaded = loadConfig()
    config = loaded.config
    shownMode = undefined
    shownLine = undefined
    bind(ctx)
    if (loaded.warning) ui?.notify(`tps-meter: config ignored, using defaults (${loaded.warning})`, "warning")
    render()
  })

  pi.on("turn_start", (event) => {
    startTurn(state, Number.isFinite(event.timestamp) ? event.timestamp : Date.now())
  })

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return
    bind(ctx)
    startMessage(state, Date.now())
    startTicker()
  })

  pi.on("message_update", (event) => {
    const ev = event.assistantMessageEvent
    let kind: DeltaKind
    switch (ev.type) {
      case "text_delta": kind = "text"; break
      case "thinking_delta": kind = "thinking"; break
      case "toolcall_delta": kind = "toolcall"; break
      default: return
    }
    // The first text/thinking token shows TTFT at once instead of on the next tick.
    if (recordDelta(state, Date.now(), ev.delta, kind)) render()
  })

  pi.on("message_end", (event, ctx) => {
    const message = event.message
    if (message.role !== "assistant") return
    bind(ctx)
    if (message.stopReason === "error" || message.stopReason === "aborted") abandonMessage(state)
    else completeMessage(state, message.usage?.output ?? 0)
    stopTicker()
    render()
  })

  // The summary (AVG, TTFT) outlives the stream and stays as it is through tool runs and the
  // wait for the next response. turn_end only re-asserts it; it never clears it.
  pi.on("turn_end", (_event, ctx) => {
    bind(ctx)
    render()
  })

  pi.on("session_shutdown", () => {
    // pi resets extension UI itself when it reloads or replaces the runtime; the timer and the
    // reference to this session's UI are the only things left for us to drop.
    stopTicker()
    ui = undefined
  })

  pi.registerCommand("tps", {
    description: "TPS meter display: /tps cycles status → widget → off, /tps status|widget|off sets it",
    getArgumentCompletions: (prefix) => {
      // Only strict prefixes: pi's editor makes Enter apply an open argument completion instead
      // of submitting, so a fully typed mode must close the popup or `/tps off` needs two Enters.
      const typed = prefix.trim().toLowerCase()
      const items = DISPLAY_MODES.filter((m) => m.startsWith(typed) && m !== typed).map((m) => ({ value: m, label: m }))
      return items.length > 0 ? items : null
    },
    handler: async (args, ctx) => {
      bind(ctx)
      const arg = args.trim().toLowerCase()
      if (arg && !isDisplayMode(arg)) {
        ctx.ui.notify(`tps-meter: unknown mode "${arg}" (use status | widget | off)`, "error")
        return
      }
      const mode = isDisplayMode(arg) ? arg : nextMode(config.mode)
      config = { ...config, mode }
      const saved = saveMode(mode)
      render()
      startTicker()
      if (saved.ok) ctx.ui.notify(`tps-meter: ${mode}`, "info")
      else ctx.ui.notify(`tps-meter: ${mode} (not saved: ${saved.error})`, "warning")
    },
  })
}
