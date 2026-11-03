import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DISPLAY_MODES, agentDir, configPath, isDisplayMode, loadConfig, nextMode, resolveConfig, saveMode } from "../src/config.ts"

describe("resolveConfig", () => {
  it("defaults to status mode and the original's thresholds", () => {
    assert.deepEqual(resolveConfig(undefined), {
      mode: "status",
      tiers: { tps: { slow: 20, normal: 50, fast: 100 }, ttft: { fast: 10_000, ok: 20_000 } },
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
    assert.equal(c.mode, "status")
    assert.deepEqual(c.tiers, resolveConfig(undefined).tiers)
    assert.deepEqual(resolveConfig([1, 2]), resolveConfig(undefined))
    assert.deepEqual(resolveConfig("status"), resolveConfig(undefined))
  })
})

describe("display modes", () => {
  it("cycles status → widget → off → status", () => {
    assert.deepEqual(DISPLAY_MODES, ["status", "widget", "off"])
    assert.equal(nextMode("status"), "widget")
    assert.equal(nextMode("widget"), "off")
    assert.equal(nextMode("off"), "status")
  })

  it("recognises only the three modes", () => {
    assert.ok(isDisplayMode("status") && isDisplayMode("widget") && isDisplayMode("off"))
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
