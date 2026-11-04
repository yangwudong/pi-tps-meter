// pi-tps-meter — live TPS / AVG / TTFT for the pi coding agent.
//
// Port of opencode-tps-meter: the measurement core (src/core.ts), the formatting (src/format.ts)
// and the thinking particle stream (src/spinner.ts) are the original's. This file is the replaced
// host layer: pi events in; the meter out on pi's footer line (by wrapping pi's own footer), a
// right-aligned line below the editor, a footer status, or a line above the editor.

import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent"
import { DISPLAY_MODES, isDisplayMode, loadConfig, nextMode, resolveConfig, saveMode, type DisplayMode, type MeterConfig } from "../src/config.ts"
import { abandonMessage, completeMessage, createMeterState, readMeter, recordDelta, startMessage, startTurn, type DeltaKind, type MeterState } from "../src/core.ts"
import { mergeFooterLine } from "../src/footer.ts"
import { alignRight, renderLine, withSpinner } from "../src/format.ts"
import { advanceSpinner, createSpinner, spinnerCells, type Rgb, type SpinnerState } from "../src/spinner.ts"

// One key for every surface: the footer status entry and the widget.
const KEY = "tps-meter"

// ~10Hz: smooth enough for a rolling number without re-rendering on every delta.
const REFRESH_MS = 100

// Older particles fade toward this neutral grey (the original faded toward the theme's muted text).
const SPINNER_MUTED: Rgb = { r: 128, g: 132, b: 142 }

type UI = ExtensionContext["ui"]
type Model = NonNullable<ExtensionContext["model"]>

// The part of pi's AgentSession that pi's FooterComponent reads, rebuilt from what an extension
// can see. pi does not hand extensions its session, but its footer only needs these members.
export type SessionView = {
  readonly sessionManager: ExtensionContext["sessionManager"]
  readonly model: ExtensionContext["model"]
  readonly state: { model: ExtensionContext["model"]; thinkingLevel: string }
  readonly routedModel: { model: Model; thinkingLevel?: string } | undefined
  readonly modelRuntime: { isUsingSubscription(provider: string): boolean }
  getContextUsage(): ReturnType<ExtensionContext["getContextUsage"]>
}

export type FooterLike = { render(width: number): string[]; invalidate(): void; dispose?(): void; setAutoCompactEnabled(enabled: boolean): void }

// pi runtime pieces the footer mode needs; loaded on demand (and injected in tests, which run on
// plain Node without pi).
export type FooterKit = {
  createFooter(session: SessionView, footerData: ReadonlyFooterDataProvider): FooterLike
  visibleWidth(text: string): number
  truncateToWidth(text: string, width: number, ellipsis?: string): string
}

export type Deps = { loadFooterKit?: () => Promise<FooterKit> }

async function loadPiFooterKit(): Promise<FooterKit> {
  const [core, tuiLib] = await Promise.all([import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-tui")])
  type Session = ConstructorParameters<typeof core.FooterComponent>[0]
  return {
    createFooter: (session, footerData) => {
      // SAFETY: FooterComponent is typed to take pi's whole AgentSession, which extensions never
      // get. In pi 1.5.0 (dist/modes/interactive/components/footer.js) it reads exactly the members
      // SessionView provides: sessionManager.{getCwd, getEntries, getEntryCount, getLeafId,
      // getSessionId, getSessionName}, model, state.{model, thinkingLevel}, routedModel,
      // modelRuntime.isUsingSubscription and getContextUsage(). If a later pi reads anything else,
      // render() throws, the wrapper catches it, and fallBack() restores pi's own footer.
      const agentSession = session as unknown as Session
      return new core.FooterComponent(agentSession, footerData)
    },
    visibleWidth: tuiLib.visibleWidth,
    truncateToWidth: tuiLib.truncateToWidth,
  }
}

export default function tpsMeter(pi: ExtensionAPI): void {
  createTpsMeter(pi)
}

export function createTpsMeter(pi: ExtensionAPI, deps: Deps = {}): void {
  const loadFooterKit = deps.loadFooterKit ?? loadPiFooterKit
  let state: MeterState = createMeterState()
  // Defaults until session_start reads the file: the factory may run in invocations that never
  // start a session, so it does no IO and starts no timers.
  let config: MeterConfig = resolveConfig(undefined)
  let ctxRef: ExtensionContext | undefined
  let ui: UI | undefined
  let tui = false
  let ticker: ReturnType<typeof setInterval> | undefined
  let spinner: SpinnerState | undefined
  // What is on screen right now, so unchanged readings cost no re-render.
  let shownMode: DisplayMode | undefined
  let shownLine: string | undefined
  // The mounted component's host (widget or footer), told to redraw when the line changes.
  let host: { requestRender(): void } | undefined
  // Bumped on every mode change, so a footer mount still loading for an older mode is dropped.
  let mountEpoch = 0

  // Handlers re-bind from their own ctx; the ticker only ever uses the latest binding.
  const bind = (ctx: ExtensionContext): void => {
    ctxRef = ctx
    ui = ctx.hasUI ? ctx.ui : undefined
    // The TUI renders ANSI and components; RPC clients get plain text lines.
    tui = ctx.mode === "tui"
  }

  // The particle stream exists only while reasoning streams, and only in the TUI (in RPC it would
  // just be noise at 10Hz). A fresh stream starts each time thinking starts. Next to a
  // right-aligned reading it goes on the left, so the reading itself never moves.
  const decorate = (target: UI, line: string, now: number): string => {
    if (!tui || !config.spinner.enabled || !state.thinking) {
      spinner = undefined
      return line
    }
    if (spinner === undefined) spinner = createSpinner(config.spinner.cells, now, Math.random)
    else advanceSpinner(spinner, config.spinner, now, Math.random)
    const paint = (text: string, c: Rgb) => target.theme.style(text, { fg: { kind: "rgb", r: c.r, g: c.g, b: c.b } })
    const side = config.mode === "right" || config.mode === "footer" ? "before" : "after"
    return withSpinner(line, spinnerCells(spinner, config.spinner, SPINNER_MUTED), paint, side)
  }

  // A component rather than a string widget: it right-aligns itself to the width of every render,
  // so it stays in the corner across terminal resizes, and an update is only a redraw request.
  const mountRight = (target: UI): void => {
    target.setWidget(KEY, (h) => {
      host = h
      return { render: (width: number) => [alignRight(shownLine ?? "", width)], invalidate() {} }
    }, { placement: "belowEditor" })
  }

  // pi's own footer, fed a SessionView, with the meter merged into its first (directory) line.
  // Everything else on the footer stays pi's rendering.
  const sessionView: SessionView = {
    // Only read inside a mounted footer, which exists only after bind(); a throw here is caught
    // by the footer's render() and ends in fallBack().
    get sessionManager() {
      if (!ctxRef) throw new Error("no session bound")
      return ctxRef.sessionManager
    },
    get model() { return ctxRef?.model },
    get state() { return { model: ctxRef?.model, thinkingLevel: pi.getThinkingLevel() } },
    // As pi's AgentSession.routedModel: under a virtual model, the physical model of the latest
    // successful response.
    get routedModel() {
      const model = ctxRef?.model
      if (!ctxRef || !model || model.api !== "pi-virtual") return undefined
      const branch = ctxRef.sessionManager.getBranch()
      for (let i = branch.length - 1; i >= 0; i--) {
        const entry = branch[i]
        if (entry.type !== "message" || entry.message.role !== "assistant") continue
        const m = entry.message
        if (m.stopReason === "error" || m.stopReason === "aborted") continue
        const physical = ctxRef.modelRegistry.find(m.provider, m.model)
        return physical ? { model: physical, thinkingLevel: m.thinkingLevel } : undefined
      }
      return undefined
    },
    // As pi's ModelRuntime.isUsingSubscription: OAuth credentials for a subscription provider.
    // The footer asks this about the current model's provider; ModelRegistry.isUsingOAuth takes
    // the model and reads its provider.
    modelRuntime: {
      isUsingSubscription: (provider) => {
        const registry = ctxRef?.modelRegistry
        const model = ctxRef?.model
        if (!registry || model?.provider !== provider || !registry.isUsingOAuth(model)) return false
        return registry.getProvider(provider)?.auth.oauth?.isSubscription === true
      },
    },
    getContextUsage: () => ctxRef?.getContextUsage(),
  }

  // If pi's footer cannot be wrapped (an older or newer pi changed it), never leave the user
  // without a footer: fall back to the line below the editor (leaving footer mode is what restores
  // pi's own footer, in render()) and say so once. A mount that is no longer current (the mode
  // changed, or the session was replaced, since it started) is ignored, so a stale UI is never used.
  const fallBack = (target: UI, epoch: number, reason: unknown): void => {
    if (epoch !== mountEpoch || ui !== target || config.mode !== "footer") return
    config = { ...config, mode: "right" }
    target.notify(`tps-meter: footer mode unavailable here (${reason instanceof Error ? reason.message : String(reason)}), using right`, "warning")
    render()
  }

  // pi feeds its own footer the auto-compaction flag whenever it changes; ours has to read the
  // setting. pi.getSettings() deep-copies all settings, and the footer renders on every frame, so
  // the flag is re-read at most once a second (a toggle in /settings shows up within that).
  let autoCompact = { value: true, readAt: Number.NEGATIVE_INFINITY }
  const autoCompactEnabled = (): boolean => {
    const now = Date.now()
    if (now - autoCompact.readAt >= 1_000) autoCompact = { value: pi.getSettings().compaction?.enabled ?? true, readAt: now }
    return autoCompact.value
  }

  const mountFooter = (target: UI, epoch: number): void => {
    loadFooterKit().then((kit) => {
      if (epoch !== mountEpoch || ui !== target) return
      target.setFooter((h, theme, footerData) => {
        host = h
        const inner = kit.createFooter(sessionView, footerData)
        const unsubscribe = footerData.onBranchChange(() => h.requestRender())
        const fns = { visibleWidth: kit.visibleWidth, truncate: (text: string, width: number) => kit.truncateToWidth(text, width, theme.fg("dim", "...")) }
        return {
          render(width: number): string[] {
            try {
              inner.setAutoCompactEnabled(autoCompactEnabled())
              const lines = inner.render(width)
              if (lines.length > 0 && shownLine) lines[0] = mergeFooterLine(lines[0], shownLine, width, fns)
              return lines
            } catch (err) {
              // Not from inside pi's render pass: swap the footer once this frame is done.
              queueMicrotask(() => fallBack(target, epoch, err))
              return []
            }
          },
          invalidate() { inner.invalidate() },
          dispose() {
            unsubscribe()
            inner.dispose?.()
          },
        }
      })
    }, (err: unknown) => fallBack(target, epoch, err))
  }

  const render = (): void => {
    if (!ui) return
    const mode = config.mode
    if (mode !== shownMode) {
      // Exactly one surface (or none) shows the meter: clear the one being left.
      if (shownMode === "status") ui.setStatus(KEY, undefined)
      if (shownMode === "widget" || shownMode === "right" || (shownMode === "footer" && !tui)) ui.setWidget(KEY, undefined)
      if (shownMode === "footer" && tui) ui.setFooter(undefined)
      host = undefined
      mountEpoch++
      shownMode = mode
      shownLine = undefined
      if (mode === "right" && tui) mountRight(ui)
      if (mode === "footer" && tui) mountFooter(ui, mountEpoch)
    }
    if (mode === "off") return
    const now = Date.now()
    const line = decorate(ui, renderLine(readMeter(state, now), config.tiers, tui), now)
    if (line === shownLine) return
    shownLine = line
    if (mode === "status") ui.setStatus(KEY, line)
    else if (mode === "widget") ui.setWidget(KEY, [line])
    // RPC has no custom footers or component widgets; there the line goes out as plain text
    // below the editor.
    else if (tui) host?.requestRender()
    else ui.setWidget(KEY, [line], { placement: "belowEditor" })
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
    // pi resets extension UI itself when it reloads or replaces the runtime (including a custom
    // footer); the timer and the references to this session are the only things left to drop.
    stopTicker()
    mountEpoch++
    ui = undefined
    ctxRef = undefined
    host = undefined
    spinner = undefined
  })

  pi.registerCommand("tps", {
    description: "TPS meter display: /tps cycles footer → right → status → widget → off, /tps footer|right|status|widget|off sets it",
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
        ctx.ui.notify(`tps-meter: unknown mode "${arg}" (use footer | right | status | widget | off)`, "error")
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
