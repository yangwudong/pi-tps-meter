// Drives extensions/index.ts through a fake ExtensionAPI with mocked timers and clock, checking
// the host layer: which pi events feed the core, what reaches setStatus / setWidget, and when.

import { describe, it, beforeEach, afterEach, mock } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import tpsMeter from "../extensions/index.ts"

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown
type Command = { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (prefix: string) => unknown }
type UiCall = { surface: "status" | "widget"; value: string | string[] | undefined; at: number }

const IDLE = "TPS -- | AVG -- | TTFT --"

function setup(opts: { mode?: "tui" | "rpc"; hasUI?: boolean } = {}) {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, Command>()
  const calls: UiCall[] = []
  const notes: { message: string; level?: string }[] = []
  const ui = {
    setStatus(key: string, text: string | undefined) {
      assert.equal(key, "tps-meter")
      calls.push({ surface: "status", value: text, at: Date.now() })
    },
    setWidget(key: string, lines: string[] | undefined) {
      assert.equal(key, "tps-meter")
      calls.push({ surface: "widget", value: lines, at: Date.now() })
    },
    notify(message: string, level?: string) {
      notes.push({ message, level })
    },
  }
  const ctx = { hasUI: opts.hasUI ?? true, mode: opts.mode ?? "rpc", ui }
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      return () => {}
    },
    registerCommand(name: string, options: Command) {
      commands.set(name, options)
    },
  }
  tpsMeter(pi as unknown as ExtensionAPI)

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    for (const handler of handlers.get(type) ?? []) handler({ type, ...payload }, ctx)
  }
  const statusLines = () => calls.filter((c) => c.surface === "status").map((c) => c.value)
  return {
    handlers,
    commands,
    calls,
    notes,
    emit,
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

// Streams `count` text deltas of 8 ASCII bytes (2 raw tokens) every `everyMs`.
function streamText(h: ReturnType<typeof setup>, count: number, everyMs: number) {
  for (let i = 0; i < count; i++) {
    mock.timers.tick(everyMs)
    h.delta("text_delta", "abcdefgh")
  }
}

let agentDir: string

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

const configFile = () => join(agentDir, "pi-tps-meter", "config.json")

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

  it("offers the three modes as /tps completions, and none once a mode is fully typed", () => {
    const complete = setup().commands.get("tps")!.getArgumentCompletions!
    assert.deepEqual(complete("w"), [{ value: "widget", label: "widget" }])
    assert.equal((complete("") as unknown[]).length, 3)
    assert.equal(complete("x"), null)
    // an open completion would swallow Enter in pi's editor
    assert.equal(complete("widget"), null)
    assert.equal(complete("off"), null)
  })

  it("does no UI work and starts no timer without a UI", () => {
    const h = setup({ hasUI: false })
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    streamText(h, 20, 50)
    h.messageEnd(40)
    mock.timers.tick(5_000)
    assert.deepEqual(h.calls, [])
  })
})

describe("streaming", () => {
  it("shows the idle meter at session start", () => {
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    assert.deepEqual(h.statusLines(), [IDLE])
  })

  it("times TTFT from turn_start and shows it on the first token", () => {
    const h = setup()
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
    const h = setup()
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
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    const start = h.calls.length
    streamText(h, 150, 20) // a steady 100 TPS: "100" on every tick once the first second is over
    const lines = h.calls.slice(start).map((c) => c.value)
    assert.ok(lines.every((line, i) => i === 0 || line !== lines[i - 1]), "an unchanged line is never pushed again")
    assert.ok(lines.length < 20)
  })

  it("keeps the AVG/TTFT summary after the stream and stops ticking", () => {
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    mock.timers.tick(800)
    h.messageStart()
    h.delta("text_delta", "abcdefgh")
    streamText(h, 99, 20) // first delta → last delta: 1.98s
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
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    streamText(h, 20, 50)
    assert.ok(!String(h.lastStatus()).startsWith("TPS --"))
    mock.timers.tick(1_600)
    assert.ok(String(h.lastStatus()).startsWith("TPS --"), "stale after 1.5s")
    streamText(h, 3, 50)
    mock.timers.tick(100)
    assert.ok(!String(h.lastStatus()).startsWith("TPS --"), "resumed")
  })

  it("never ends the TTFT wait on toolcall deltas, but counts them as output", () => {
    const h = setup()
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
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    streamText(h, 20, 50)
    h.messageEnd(1, "aborted")
    assert.match(String(h.lastStatus()), /^TPS -- \| AVG -- \| TTFT 0\.1s$/)
  })

  it("stops ticking on session_shutdown", () => {
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    streamText(h, 10, 50)
    h.emit("session_shutdown", { reason: "quit" })
    const after = h.calls.length
    mock.timers.tick(5_000)
    assert.equal(h.calls.length, after)
  })
})

describe("/tps", () => {
  it("cycles status → widget → off → status, moving the meter and persisting the mode", async () => {
    const h = setup()
    h.emit("session_start", { reason: "startup" })

    await h.tps("")
    assert.deepEqual(h.calls.slice(-2).map((c) => [c.surface, c.value]), [["status", undefined], ["widget", [IDLE]]])
    assert.equal(savedMode(), "widget")

    await h.tps("")
    assert.deepEqual(h.calls.at(-1), { surface: "widget", value: undefined, at: Date.now() })
    assert.equal(savedMode(), "off")

    await h.tps("")
    assert.deepEqual(h.calls.at(-1), { surface: "status", value: IDLE, at: Date.now() })
    assert.deepEqual(h.notes.map((n) => n.message), ["tps-meter: widget", "tps-meter: off", "tps-meter: status"])
  })

  it("sets a mode directly and rejects unknown ones", async () => {
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    await h.tps("off")
    assert.equal(h.lastStatus(), undefined)
    await h.tps("loud")
    assert.deepEqual(h.notes.at(-1), { message: 'tps-meter: unknown mode "loud" (use status | widget | off)', level: "error" })
    assert.equal(savedMode(), "off")
  })

  it("hides the meter completely when off, even mid-stream, and resumes when turned back on", async () => {
    const h = setup()
    h.emit("session_start", { reason: "startup" })
    h.turnStart()
    h.messageStart()
    streamText(h, 10, 50)
    await h.tps("off")
    const hidden = h.calls.length
    streamText(h, 40, 50)
    h.messageEnd(80)
    h.emit("turn_end", { turnIndex: 0 })
    assert.equal(h.calls.length, hidden, "no UI calls while off")
    await h.tps("widget")
    assert.match(String(h.calls.at(-1)!.value), /AVG \d/)
  })

  it("starts in the persisted mode and applies tier overrides", () => {
    mkdirSync(join(agentDir, "pi-tps-meter"), { recursive: true })
    writeFileSync(configFile(), JSON.stringify({ mode: "widget", tiers: { tps: { slow: 1, normal: 2, fast: 3 } } }))
    const h = setup({ mode: "tui" })
    h.emit("session_start", { reason: "startup" })
    assert.equal(h.calls[0].surface, "widget")
    h.turnStart()
    h.messageStart()
    streamText(h, 20, 50)
    const line = String((h.calls.at(-1)!.value as string[])[0])
    assert.match(line, /\x1b\[36m\d+(\.\d+)?\x1b\[39m/, "40 TPS is 'faster' (cyan) with fast = 3")
  })

  it("reports an unparsable config file without overwriting it", async () => {
    mkdirSync(join(agentDir, "pi-tps-meter"), { recursive: true })
    writeFileSync(configFile(), "{ nope")
    const h = setup()
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
    const tui = setup({ mode: "tui" })
    tui.emit("session_start", { reason: "startup" })
    assert.ok(String(tui.lastStatus()).includes("\x1b[2mTPS \x1b[22m"))
    const rpc = setup({ mode: "rpc" })
    rpc.emit("session_start", { reason: "startup" })
    assert.equal(rpc.lastStatus(), IDLE)
  })
})
