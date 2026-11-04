// Drives extensions/index.ts through a fake ExtensionAPI with mocked timers and clock, checking
// the host layer: which pi events feed the core, what reaches setStatus / setWidget, and when.

import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createTpsMeter, type FooterKit, type SessionView } from "../extensions/index.ts"
import { visibleWidth } from "../src/format.ts"

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown
type Command = { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
type Component = { render(width: number): string[] }
type Factory = (host: { requestRender(): void }, theme: unknown) => Component
type UiCall = { surface: "status" | "widget" | "footer"; value: string | string[] | undefined; placement?: string; at: number }

const IDLE = "TPS -- | AVG -- | TTFT --"
const BRAILLE = /[\u2800-\u28ff]/
const ANSI = /\x1b\[[0-9;]*m/g
const plain = (s: unknown) => String(s).replace(ANSI, "")

let agentDir: string
const configFile = () => join(agentDir, "pi-tps-meter", "config.json")
const writeConfig = (cfg: unknown) => {
  mkdirSync(join(agentDir, "pi-tps-meter"), { recursive: true })
  writeFileSync(configFile(), typeof cfg === "string" ? cfg : JSON.stringify(cfg))
}

// Stands in for pi's FooterComponent: three lines like pi's (directory, stats, statuses), built
// from the SessionView it is given, so tests can see what the wrapper passes through.
function fakeKit(over: { fail?: string; throwOnRender?: boolean } = {}) {
  const seen: { session?: SessionView; autoCompact?: boolean; disposed: number } = { disposed: 0 }
  const kit: FooterKit = {
    createFooter(session) {
      seen.session = session
      return {
        render(width: number) {
          if (over.throwOnRender) throw new Error("footer internals changed")
          const dir = `\x1b[2m${session.sessionManager.getCwd()} (main)\x1b[22m`
          const stats = `${session.state.thinkingLevel} ${seen.autoCompact ? "(auto)" : ""}`.padEnd(width).slice(0, width)
          return [dir, stats, "LSP Inactive"]
        },
        invalidate() {},
        dispose() { seen.disposed++ },
        setAutoCompactEnabled(enabled: boolean) { seen.autoCompact = enabled },
      }
    },
    visibleWidth: (t) => [...t.replace(/\x1b\[[0-9;]*m/g, "")].length,
    truncateToWidth: (t, w, e = "...") => {
      const p = [...t.replace(/\x1b\[[0-9;]*m/g, "")]
      return p.length <= w ? t : p.slice(0, Math.max(0, w - 3)).join("") + e
    },
  }
  return { seen, load: () => (over.fail ? Promise.reject(new Error(over.fail)) : Promise.resolve(kit)) }
}

// `display` writes config.json before session_start reads it; `ctxMode` is pi's run mode.
function setup(opts: { ctxMode?: "tui" | "rpc"; hasUI?: boolean; display?: string; config?: object; kit?: ReturnType<typeof fakeKit> } = {}) {
  if (opts.display || opts.config) writeConfig({ ...opts.config, ...(opts.display ? { mode: opts.display } : {}) })
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, Command>()
  const calls: UiCall[] = []
  const notes: { message: string; level?: string }[] = []
  const host = { renders: 0, requestRender() { host.renders++ } }
  const kit = opts.kit ?? fakeKit()
  let component: Component | undefined
  let footer: (Component & { dispose?(): void }) | undefined
  const ui = {
    // Same output shape as pi's theme.style() for an RGB colour (truecolor SGR + default-fg reset),
    // so width measurement sees exactly what it sees in pi.
    theme: { style: (text: string, o: { fg: { r: number; g: number; b: number } }) => `\x1b[38;2;${o.fg.r};${o.fg.g};${o.fg.b}m${text}\x1b[39m` },
    setStatus(key: string, text: string | undefined) {
      assert.equal(key, "tps-meter")
      calls.push({ surface: "status", value: text, at: Date.now() })
    },
    setWidget(key: string, content: string[] | Factory | undefined, options?: { placement?: string }) {
      assert.equal(key, "tps-meter")
      if (typeof content === "function") {
        component = content(host, ui.theme)
        calls.push({ surface: "widget", value: "<component>", placement: options?.placement, at: Date.now() })
        return
      }
      if (content === undefined) component = undefined
      calls.push({ surface: "widget", value: content, placement: options?.placement, at: Date.now() })
    },
    setFooter(factory: ((h: unknown, theme: unknown, data: unknown) => Component & { dispose?(): void }) | undefined) {
      footer?.dispose?.()
      footer = factory?.(host, { fg: (_c: string, t: string) => t }, { onBranchChange: () => () => {} })
      calls.push({ surface: "footer", value: factory ? "<footer>" : undefined, at: Date.now() })
    },
    notify(message: string, level?: string) {
      notes.push({ message, level })
    },
  }
  const ctx = {
    hasUI: opts.hasUI ?? true,
    mode: opts.ctxMode ?? "rpc",
    ui,
    model: { id: "glm", provider: "magpie", api: "openai-completions" },
    sessionManager: { getCwd: () => "~/workspaces/personal/troubleshooting", getBranch: () => [] },
    modelRegistry: { isUsingOAuth: () => false, getProvider: () => undefined, find: () => undefined },
    getContextUsage: () => undefined,
  }
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    },
    registerCommand(name: string, options: Command) {
      commands.set(name, options)
    },
    getThinkingLevel: () => "max",
    getSettings: () => ({ compaction: { enabled: true } }),
  }
  // SAFETY: the fake implements exactly the ExtensionAPI members the extension calls (on,
  // registerCommand, getThinkingLevel, getSettings); a missing one fails the test that needs it.
  const api = pi as unknown as ExtensionAPI
  createTpsMeter(api, { loadFooterKit: kit.load })

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, ...payload }, ctx)
  }
  const statusLines = () => calls.filter((c) => c.surface === "status").map((c) => c.value)
  return {
    handlers,
    commands,
    calls,
    notes,
    host,
    emit,
    kit,
    // What the mounted right-aligned component draws at `width` columns.
    rendered: (width = 80) => component?.render(width)[0],
    // What the wrapped footer draws at `width` columns (undefined when pi's own footer is up).
    footerLines: (width = 80) => footer?.render(width),
    tps: (args: string) => commands.get("tps")!.handler(args, ctx),
    statusLines,
    lastStatus: () => statusLines().at(-1),
    turnStart: () => emit("turn_start", { turnIndex: 0, timestamp: Date.now() }),
    messageStart: (role = "assistant") => emit("message_start", { message: { role } }),
    delta: (type: "text_delta" | "thinking_delta" | "toolcall_delta", delta: string) =>
      emit("message_update", { message: { role: "assistant" }, assistantMessageEvent: { type, delta } }),
    messageEnd: (output: number, stopReason = "stop", role = "assistant") =>
      emit("message_end", { message: { role, stopReason, usage: { output } } }),
  }
}

// Streams `count` deltas of 8 ASCII bytes (2 raw tokens) every `everyMs`.
function stream(h: ReturnType<typeof setup>, count: number, everyMs: number, type: "text_delta" | "thinking_delta" = "text_delta") {
  for (let i = 0; i < count; i++) {
    mock.timers.tick(everyMs)
    h.delta(type, "abcdefgh")
  }
}

beforeEach(() => {
  agentDir = mkdtempSync(join(tmpdir(), "pi-tps-meter-ext-"))
  process.env.PI_CODING_AGENT_DIR = agentDir
  mock.timers.enable({ apis: ["setInterval", "Date"], now: 0 })
})

afterEach(() => {
  mock.timers.reset()
  delete process.env.PI_CODING_AGENT_DIR
  rmSync(agentDir, { recursive: true, force: true })
})

// The persisted mode; a file that does not parse fails the test with its contents.
const savedMode = (): unknown => {
  const text = readFileSync(configFile(), "utf8")
  try {
    return (JSON.parse(text) as { mode?: unknown }).mode
  } catch (err) {
    assert.fail(`config.json is not valid JSON (${String(err)}): ${text}`)
  }
}

describe("wiring", () => {
  it("subscribes to the lifecycle events and registers /tps", () => {
    const h = setup()
    for (const event of ["session_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "session_shutdown"]) {
      assert.ok(h.handlers.has(event), `handles ${event}`)
    }
    assert.ok(h.commands.has("tps"))
  })

  it("offers the five modes as /tps completions, and none once a mode is fully typed", () => {
    const complete = setup().commands.get("tps")!.getArgumentCompletions!
    assert.deepEqual(complete("w"), [{ value: "widget", label: "widget" }])
    assert.deepEqual(complete("r"), [{ value: "right", label: "right" }])
    assert.deepEqual(complete("f"), [{ value: "footer", label: "footer" }])
    assert.equal((complete("") as unknown[]).length, 5)
    assert.equal(complete("x"), null)
    // an open completion would swallow Enter in pi's editor
    assert.equal(complete("right"), null)
    assert.equal(complete("off"), null)
  })

  it("does no UI work and starts no timer without a UI", () => {
    const h = setup({ hasUI: false })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 20, 50)
    h.messageEnd(40)
    mock.timers.tick(5_000)
    assert.deepEqual(h.calls, [])
  })
})

describe("on pi's footer line (default)", () => {
  // The footer mounts once the pi pieces are loaded (a dynamic import in pi): a microtask.
  const ready = () => Promise.resolve()

  it("wraps pi's footer and puts the meter at the right end of the directory line", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await ready()
    assert.deepEqual(h.calls.map((c) => c.surface), ["footer"], "no widget line, no status: just the footer")
    const [dir, stats, statuses] = h.footerLines(100)!
    assert.match(plain(dir), /^~\/workspaces\/personal\/troubleshooting \(main\) +TPS -- \| AVG -- \| TTFT --$/)
    assert.equal(visibleWidth(dir), 100)
    assert.equal(statuses, "LSP Inactive", "pi's other lines pass through untouched")
    assert.equal(stats.length, 100)
  })

  it("follows the terminal width on every render", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await ready()
    for (const width of [70, 120, 200]) {
      const dir = h.footerLines(width)![0]
      assert.equal(visibleWidth(dir), width)
      assert.ok(plain(dir).endsWith("TTFT --"))
    }
  })

  it("updates by redraw requests, never by re-mounting", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await ready()
    h.turnStart()
    mock.timers.tick(700)
    h.messageStart()
    stream(h, 30, 50)
    assert.equal(h.calls.length, 1, "the one footer mount")
    assert.ok(h.host.renders > 10, `${h.host.renders} redraw requests`)
    assert.match(plain(h.footerLines()![0]), /TPS \d.* \| TTFT 0\.8s$/)
  })

  it("puts the particle stream before the reading, so the reading never moves", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await ready()
    h.turnStart()
    h.messageStart()
    stream(h, 10, 50, "thinking_delta")
    const dir = plain(h.footerLines(100)![0])
    assert.match(dir, /[\u2800-\u28ff]{6} TPS \S+ \| AVG -- \| TTFT 0\.1s$/)
  })

  it("feeds pi's footer what pi's own session would: thinking level, (auto), subscription, routing", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await ready()
    h.footerLines(80)
    const view = h.kit.seen.session!
    assert.equal(view.state.thinkingLevel, "max")
    assert.equal(h.kit.seen.autoCompact, true, "compaction.enabled from pi.getSettings()")
    assert.equal(view.model?.id, "glm")
    assert.equal(view.routedModel, undefined, "not a virtual model")
    assert.equal(view.modelRuntime.isUsingSubscription("magpie"), false)
    assert.equal(view.sessionManager.getCwd(), "~/workspaces/personal/troubleshooting")
  })

  it("restores pi's own footer and falls back to the line below the editor when it cannot load", async () => {
    const h = setup({ ctxMode: "tui", kit: fakeKit({ fail: "no FooterComponent in this pi" }) })
    h.emit("session_start", { reason: "startup" })
    await ready()
    await ready()
    // pi's own footer was never replaced, so restoring it is the one setFooter(undefined) call
    assert.deepEqual(h.calls.map((c) => [c.surface, c.value, c.placement]), [["footer", undefined, undefined], ["widget", "<component>", "belowEditor"]])
    assert.match(h.notes.at(-1)!.message, /footer mode unavailable here \(no FooterComponent in this pi\), using right/)
    assert.equal(plain(h.rendered(60)).trimStart(), IDLE)
  })

  it("does the same when pi's footer throws while rendering, after the frame", async () => {
    const h = setup({ ctxMode: "tui", kit: fakeKit({ throwOnRender: true }) })
    h.emit("session_start", { reason: "startup" })
    await ready()
    assert.deepEqual(h.footerLines(80), [], "the failing frame draws nothing rather than crashing pi")
    await ready()
    assert.equal(h.calls.at(-1)!.surface, "widget")
    assert.equal(h.footerLines(80), undefined, "pi's own footer is back")
    assert.equal(h.notes.at(-1)!.level, "warning")
  })

  it("drops a footer mount that is still loading when the mode changes", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await h.tps("status") // before the footer kit resolved
    await ready()
    assert.ok(!h.calls.some((c) => c.surface === "footer" && c.value === "<footer>"), "no stale footer mount")
    assert.equal(plain(h.lastStatus()), IDLE)
  })

  it("restores pi's footer when switching away and disposes the wrapper", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await ready()
    h.footerLines(80)
    await h.tps("status")
    assert.deepEqual(h.calls.slice(-2).map((c) => [c.surface, c.value === undefined]), [["footer", true], ["status", false]])
    assert.equal(h.kit.seen.disposed, 1)
  })

  it("ignores a late footer failure from a session that has since shut down", async () => {
    const h = setup({ ctxMode: "tui", kit: fakeKit({ fail: "too late" }) })
    h.emit("session_start", { reason: "startup" })
    h.emit("session_shutdown", { reason: "new" })
    await ready()
    await ready()
    assert.deepEqual(h.calls, [], "nothing was touched after shutdown")
    assert.deepEqual(h.notes, [])
  })

  it("uses plain lines below the editor in RPC, which has no custom footers", () => {
    const h = setup({ ctxMode: "rpc" })
    h.emit("session_start", { reason: "startup" })
    assert.deepEqual(h.calls, [{ surface: "widget", value: [IDLE], placement: "belowEditor", at: 0 }])
  })
})

describe("right-aligned below the editor", () => {
  it("mounts one component below the editor in the TUI", () => {
    const h = setup({ ctxMode: "tui", display: "right" })
    h.emit("session_start", { reason: "startup" })
    assert.deepEqual(h.calls.map((c) => [c.surface, c.value, c.placement]), [["widget", "<component>", "belowEditor"]])
    assert.equal(plain(h.rendered(40)).trimStart(), IDLE)
  })

  it("ends in the last column at every width, so it stays in the corner across resizes", () => {
    const h = setup({ ctxMode: "tui", display: "right" })
    h.emit("session_start", { reason: "startup" })
    for (const width of [40, 80, 140]) {
      const line = h.rendered(width)!
      assert.equal(visibleWidth(line), width)
      assert.ok(plain(line).endsWith("TTFT --"))
    }
  })

  it("updates by redraw requests, never by re-mounting", () => {
    const h = setup({ ctxMode: "tui", display: "right" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    mock.timers.tick(700)
    h.messageStart()
    stream(h, 30, 50)
    assert.equal(h.calls.length, 1, "still the one mount from session_start")
    assert.ok(h.host.renders > 10, `${h.host.renders} redraw requests`)
    // stream() ticks before each delta: the first token arrives 0.75s after turn_start
    assert.match(plain(h.rendered()), /TPS \d.* \| TTFT 0\.8s$/)
  })

  it("falls back to plain lines below the editor in RPC, which ignores components", () => {
    const h = setup({ ctxMode: "rpc", display: "right" })
    h.emit("session_start", { reason: "startup" })
    assert.deepEqual(h.calls.at(-1), { surface: "widget", value: [IDLE], placement: "belowEditor", at: 0 })
  })
})

describe("streaming", () => {
  it("shows the idle meter at session start", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    assert.deepEqual(h.statusLines(), [IDLE])
  })

  it("times TTFT from turn_start and shows it on the first token", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart("user") // the prompt itself: ignored
    mock.timers.tick(2_000)
    h.messageStart() // pi opens the assistant message only after the response headers
    const before = h.calls.length
    h.delta("thinking_delta", "Let me think")
    assert.equal(h.calls.length, before + 1, "rendered at once, not on the next tick")
    assert.match(String(h.lastStatus()), /TTFT 2\.0s$/)
  })

  it("refreshes TPS at ~10Hz while streaming, not on every delta", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    const start = h.calls.length
    // 150 deltas in 3s whose size keeps growing, so the reading changes on every tick
    for (let i = 0; i < 150; i++) {
      mock.timers.tick(20)
      h.delta("text_delta", "abcd".repeat(1 + Math.floor(i / 10)))
    }
    const updates = h.calls.slice(start)
    const ticks = updates.filter((c) => c.at % 100 === 0)
    assert.ok(ticks.length >= 28 && ticks.length <= 30, `${ticks.length} tick renders in 3s`)
    assert.equal(updates.length - ticks.length, 1, "the only off-tick render is the TTFT on the first token")
    assert.ok(updates.slice(1).every((c) => !String(c.value).startsWith("TPS --")), "TPS visible while tokens flow")
  })

  it("does not re-render a reading that has not changed", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    const start = h.calls.length
    stream(h, 150, 20) // a steady 100 TPS: "100" on every tick once the first second is over
    const lines = h.calls.slice(start).map((c) => c.value)
    assert.ok(lines.every((line, i) => i === 0 || line !== lines[i - 1]), "an unchanged line is never pushed again")
    assert.ok(lines.length < 20)
  })

  it("keeps the AVG/TTFT summary after the stream and stops ticking", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    mock.timers.tick(800)
    h.messageStart()
    h.delta("text_delta", "abcdefgh")
    stream(h, 99, 20) // first delta → last delta: 1.98s
    h.messageEnd(300)
    assert.equal(h.lastStatus(), "TPS -- | AVG 152 | TTFT 0.8s") // 300 tokens / 1.98s
    const settled = h.calls.length
    mock.timers.tick(30_000)
    h.emit("turn_end", { turnIndex: 0 })
    h.turnStart() // tool results sent back; the next response is pending
    mock.timers.tick(5_000)
    assert.equal(h.calls.length, settled, "nothing re-rendered or cleared in the gap")
    assert.ok(h.statusLines().every((line) => line !== undefined), "never cleared")
  })

  it("blanks TPS after STALE_MS without deltas, and brings it back", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 20, 50)
    assert.ok(!String(h.lastStatus()).startsWith("TPS --"))
    mock.timers.tick(1_600)
    assert.ok(String(h.lastStatus()).startsWith("TPS --"), "stale after 1.5s")
    stream(h, 3, 50)
    mock.timers.tick(100)
    assert.ok(!String(h.lastStatus()).startsWith("TPS --"), "resumed")
  })

  it("never ends the TTFT wait on toolcall deltas, but counts them as output", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    mock.timers.tick(1_000)
    h.messageStart()
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(50)
      h.delta("toolcall_delta", '{"path":"a.ts",')
    }
    assert.match(String(h.lastStatus()), /^TPS \d.* \| TTFT --$/)
    h.delta("text_delta", "Done")
    assert.match(String(h.lastStatus()), /TTFT 1\.5s$/)
  })

  it("leaves AVG and calibration alone for aborted messages", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 20, 50)
    h.messageEnd(1, "aborted")
    assert.match(String(h.lastStatus()), /^TPS -- \| AVG -- \| TTFT 0\.1s$/)
  })

  it("stops ticking on session_shutdown", () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 10, 50)
    h.emit("session_shutdown", { reason: "quit" })
    const after = h.calls.length
    mock.timers.tick(5_000)
    assert.equal(h.calls.length, after)
  })
})

describe("thinking particle stream", () => {
  it("flows before a right-aligned reading while reasoning streams, and stops when text starts", () => {
    const h = setup({ ctxMode: "tui", display: "right" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 10, 50, "thinking_delta")
    const thinking = h.rendered()!
    // The particles are everything between the padding and " TPS "; gap cells are U+2800, so
    // strip only real spaces (the right-alignment padding).
    const particles = plain(thinking).replace(/^ +/, "").split(" TPS ")[0]
    assert.ok(BRAILLE.test(particles), "particles before the reading")
    assert.equal([...particles].length, 6, "six cells, gaps included")
    assert.ok([...particles].every((c) => BRAILLE.test(c)), "gaps are U+2800, not spaces")
    assert.match(thinking, /\x1b\[38;2;\d+;\d+;\d+m/, "painted through the theme with RGB colours")
    assert.equal(visibleWidth(thinking), 80, "right-aligned to the full width")
    assert.ok(plain(thinking).endsWith("TTFT 0.1s"), "the reading stays put at the right edge")
    stream(h, 3, 50, "text_delta")
    mock.timers.tick(100)
    assert.ok(!BRAILLE.test(h.rendered()!), "gone once the answer streams")
  })

  it("keeps moving through a pause in the reasoning stream", () => {
    const h = setup({ ctxMode: "tui", display: "right" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 3, 50, "thinking_delta")
    const frames = new Set<string>()
    for (let i = 0; i < 10; i++) {
      mock.timers.tick(100)
      frames.add(h.rendered()!)
    }
    assert.ok(frames.size >= 8, `${frames.size} distinct frames in 1s without a delta`)
  })

  it("follows TTFT in status mode, as in the original", () => {
    const h = setup({ ctxMode: "tui", display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 5, 50, "thinking_delta")
    const line = plain(h.lastStatus())
    assert.match(line, /^TPS .* \| TTFT 0\.1s /)
    assert.ok(BRAILLE.test(line.split("TTFT 0.1s ")[1]))
  })

  it("is not shown when disabled, outside the TUI, or after the message ends", () => {
    const off = setup({ ctxMode: "tui", display: "status", config: { spinner: { theme: "none" } } })
    off.emit("session_start", { reason: "startup" })
    off.turnStart()
    off.messageStart()
    stream(off, 5, 50, "thinking_delta")
    assert.ok(!BRAILLE.test(String(off.lastStatus())), "theme none")

    const rpc = setup({ ctxMode: "rpc", display: "status" })
    rpc.emit("session_start", { reason: "startup" })
    rpc.turnStart()
    rpc.messageStart()
    stream(rpc, 5, 50, "thinking_delta")
    assert.ok(!BRAILLE.test(String(rpc.lastStatus())), "RPC")

    const tui = setup({ ctxMode: "tui", display: "status" })
    tui.emit("session_start", { reason: "startup" })
    tui.turnStart()
    tui.messageStart()
    stream(tui, 5, 50, "thinking_delta")
    tui.messageEnd(10, "aborted")
    assert.ok(!BRAILLE.test(String(tui.lastStatus())), "message ended mid-thought")
  })
})

describe("/tps", () => {
  it("cycles footer → right → status → widget → off → footer, moving the meter and persisting the mode", async () => {
    const h = setup({ ctxMode: "tui" })
    h.emit("session_start", { reason: "startup" })
    await Promise.resolve()
    assert.deepEqual(h.calls.map((c) => [c.surface, c.value]), [["footer", "<footer>"]])

    await h.tps("")
    assert.deepEqual(h.calls.slice(-2).map((c) => [c.surface, c.value, c.placement]), [["footer", undefined, undefined], ["widget", "<component>", "belowEditor"]])
    assert.equal(savedMode(), "right")

    await h.tps("")
    assert.deepEqual(h.calls.slice(-2).map((c) => [c.surface, plain(c.value)]), [["widget", "undefined"], ["status", IDLE]])
    assert.equal(savedMode(), "status")

    await h.tps("")
    assert.deepEqual(h.calls.slice(-2).map((c) => [c.surface, c.placement]), [["status", undefined], ["widget", undefined]])
    assert.equal(plain((h.calls.at(-1)!.value as string[])[0]), IDLE)
    assert.equal(savedMode(), "widget")

    await h.tps("")
    assert.deepEqual(h.calls.at(-1), { surface: "widget", value: undefined, placement: undefined, at: 0 })
    assert.equal(savedMode(), "off")

    await h.tps("")
    await Promise.resolve()
    assert.deepEqual(h.calls.at(-1), { surface: "footer", value: "<footer>", at: 0 })
    assert.deepEqual(h.notes.map((n) => n.message), ["tps-meter: right", "tps-meter: status", "tps-meter: widget", "tps-meter: off", "tps-meter: footer"])
  })

  it("sets a mode directly and rejects unknown ones", async () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    await h.tps("off")
    assert.equal(h.lastStatus(), undefined)
    await h.tps("loud")
    assert.deepEqual(h.notes.at(-1), { message: 'tps-meter: unknown mode "loud" (use footer | right | status | widget | off)', level: "error" })
    assert.equal(savedMode(), "off")
  })

  it("hides the meter completely when off, even mid-stream, and resumes when turned back on", async () => {
    const h = setup({ display: "status" })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    stream(h, 10, 50)
    await h.tps("off")
    const hidden = h.calls.length
    stream(h, 40, 50)
    h.messageEnd(80)
    h.emit("turn_end", { turnIndex: 0 })
    assert.equal(h.calls.length, hidden, "no UI calls while off")
    await h.tps("widget")
    assert.match(String(h.calls.at(-1)!.value), /AVG \d/)
  })

  it("switching from right unmounts the component", async () => {
    const h = setup({ ctxMode: "tui", display: "right" })
    h.emit("session_start", { reason: "startup" })
    await h.tps("status")
    assert.deepEqual(h.calls.slice(-2).map((c) => [c.surface, c.value]), [["widget", undefined], ["status", h.lastStatus()]])
    assert.equal(h.rendered(), undefined)
  })

  it("starts in the persisted mode and applies tier overrides", () => {
    const h = setup({ ctxMode: "tui", config: { mode: "widget", tiers: { tps: { slow: 1, normal: 2, fast: 3 } } } })
    h.emit("session_start", { reason: "startup" })
    assert.equal(h.calls[0].surface, "widget")
    h.turnStart()
    h.messageStart()
    stream(h, 20, 50)
    const line = String((h.calls.at(-1)!.value as string[])[0])
    assert.match(line, /\x1b\[36m\d+(\.\d+)?\x1b\[39m/, "40 TPS is 'faster' (cyan) with fast = 3")
  })

  it("reports an unparsable config file without overwriting it", async () => {
    writeConfig("{ nope")
    const h = setup({ ctxMode: "rpc" })
    h.emit("session_start", { reason: "startup" })
    assert.equal(h.notes[0].level, "warning")
    await h.tps("widget")
    assert.equal(h.notes.at(-1)!.level, "warning")
    assert.equal(readFileSync(configFile(), "utf8"), "{ nope")
    assert.equal(h.calls.at(-1)!.surface, "widget", "the mode still switches for this session")
  })
})

describe("colour", () => {
  it("emits ANSI only for the TUI", () => {
    const tui = setup({ ctxMode: "tui", display: "status" })
    tui.emit("session_start", { reason: "startup" })
    assert.ok(String(tui.lastStatus()).includes("\x1b[2mTPS \x1b[22m"))
    const rpc = setup({ ctxMode: "rpc", display: "status" })
    rpc.emit("session_start", { reason: "startup" })
    assert.equal(rpc.lastStatus(), IDLE)
  })
})
