import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DISPLAY_MODES, agentDir, configPath, isDisplayMode, loadConfig, nextMode, resolveConfig, saveMode } from "../src/config.ts"

describe("resolveConfig", () => {
  it("defaults to the right-aligned mode, the original's thresholds and the tech spinner", () => {
    assert.deepEqual(resolveConfig(undefined), {
      mode: "right",
      tiers: { tps: { slow: 20, normal: 50, fast: 100 }, ttft: { fast: 10_000, ok: 20_000 } },
      spinner: {
        enabled: true,
        colors: [{ r: 0, g: 229, b: 255 }, { r: 41, g: 121, b: 255 }, { r: 101, g: 31, b: 255 }],
        intervalMs: 100,
        cells: 6,
      },
    })
  })

  it("overrides tiers field by field, keeping the other defaults", () => {
    const c = resolveConfig({ mode: "widget", tiers: { tps: { fast: 80 }, ttft: { ok: 30_000 } } })
    assert.equal(c.mode, "widget")
    assert.deepEqual(c.tiers.tps, { slow: 20, normal: 50, fast: 80 })
    assert.deepEqual(c.tiers.ttft, { fast: 10_000, ok: 30_000 })
  })

  it("falls back on malformed values instead of mis-tiering", () => {
    const c = resolveConfig({ mode: "loud", tiers: { tps: { slow: "20", normal: null, fast: NaN }, ttft: [] } })
    assert.equal(c.mode, "right")
    assert.deepEqual(c.tiers, resolveConfig(undefined).tiers)
    assert.deepEqual(resolveConfig([1, 2]), resolveConfig(undefined))
    assert.deepEqual(resolveConfig("status"), resolveConfig(undefined))
  })

  it("resolves spinner options like the original", () => {
    const red = resolveConfig({ spinner: { theme: "red" } }).spinner
    assert.deepEqual(red.colors[0], { r: 255, g: 23, b: 68 })
    assert.equal(resolveConfig({ spinner: { theme: "none" } }).spinner.enabled, false)
    assert.equal(resolveConfig({ spinner: { enabled: false } }).spinner.enabled, false)
    assert.equal(resolveConfig({ spinner: { theme: "nope" } }).spinner.colors.length, 3, "unknown theme falls back to tech")
    const custom = resolveConfig({ spinner: { colors: ["#ffffff", "bad", 7, "#000"], intervalMs: 80, cells: 9.7 } }).spinner
    assert.deepEqual(custom.colors, [{ r: 255, g: 255, b: 255 }, { r: 0, g: 0, b: 0 }], "custom colours win; invalid entries are dropped")
    assert.equal(custom.intervalMs, 80)
    assert.equal(custom.cells, 9)
  })

  it("rejects spinner values the original rejected", () => {
    const s = resolveConfig({ spinner: { colors: ["bad"], intervalMs: 0, cells: 1 } }).spinner
    assert.equal(s.colors.length, 3, "no valid custom colour: preset")
    assert.equal(s.intervalMs, 100)
    assert.equal(s.cells, 6, "fewer than 2 cells: default")
  })
})

describe("display modes", () => {
  it("cycles right → status → widget → off → right", () => {
    assert.deepEqual(DISPLAY_MODES, ["right", "status", "widget", "off"])
    assert.equal(nextMode("right"), "status")
    assert.equal(nextMode("status"), "widget")
    assert.equal(nextMode("widget"), "off")
    assert.equal(nextMode("off"), "right")
  })

  it("recognises only the four modes", () => {
    assert.ok(isDisplayMode("right") && isDisplayMode("status") && isDisplayMode("widget") && isDisplayMode("off"))
    assert.ok(!isDisplayMode("live") && !isDisplayMode("") && !isDisplayMode(undefined))
  })
})

describe("config location", () => {
  it("lives under ~/.pi/agent by default", () => {
    assert.equal(configPath({}), join(homedir(), ".pi", "agent", "pi-tps-meter", "config.json"))
  })

  it("follows PI_CODING_AGENT_DIR like pi itself, with ~ expanded", () => {
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/srv/pi" }), "/srv/pi")
    assert.equal(agentDir({ PI_CODING_AGENT_DIR: "~/alt" }), join(homedir(), "alt"))
    assert.equal(configPath({ PI_CODING_AGENT_DIR: "/srv/pi" }), "/srv/pi/pi-tps-meter/config.json")
  })
})

describe("loadConfig / saveMode", () => {
  let dir: string
  let file: string

  // Reads back what saveMode wrote; a file that does not parse fails the test with its contents.
  const readBack = (): unknown => {
    const text = readFileSync(file, "utf8")
    try {
      return JSON.parse(text)
    } catch (err) {
      assert.fail(`${file} is not valid JSON (${String(err)}): ${text}`)
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-tps-meter-"))
    file = join(dir, "pi-tps-meter", "config.json")
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it("uses the defaults when the file does not exist", () => {
    assert.deepEqual(loadConfig(file), { config: resolveConfig(undefined) })
  })

  it("round-trips the mode and creates the directory", () => {
    assert.deepEqual(saveMode("widget", file), { ok: true })
    assert.equal(loadConfig(file).config.mode, "widget")
    assert.deepEqual(readBack(), { mode: "widget" })
  })

  it("keeps hand-edited tiers when the mode changes", () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ mode: "status", tiers: { tps: { slow: 10 } }, note: "mine" }))
    saveMode("off", file)
    assert.deepEqual(readBack(), { mode: "off", tiers: { tps: { slow: 10 } }, note: "mine" })
    assert.equal(loadConfig(file).config.tiers.tps.slow, 10)
  })

  it("warns and falls back to the defaults on a file that does not parse", () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{ mode: status")
    const loaded = loadConfig(file)
    assert.deepEqual(loaded.config, resolveConfig(undefined))
    assert.ok(loaded.warning?.includes(file))
  })

  it("never overwrites a file it cannot parse", () => {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, "{ broken")
    const saved = saveMode("widget", file)
    assert.equal(saved.ok, false)
    assert.equal(readFileSync(file, "utf8"), "{ broken")
    writeFileSync(file, "[1, 2]")
    assert.equal(saveMode("widget", file).ok, false)
    assert.equal(readFileSync(file, "utf8"), "[1, 2]")
  })
})
