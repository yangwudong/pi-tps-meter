import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  THEME_PRESETS,
  advanceSpinner,
  createSpinner,
  gradientColor,
  lerpColor,
  parseHex,
  spinnerCells,
  type Random,
  type Rgb,
  type SpinnerConfig,
} from "../src/spinner.ts"

// Deterministic stand-in for Math.random: walks [0, 1) in fixed steps.
function seq(step = 0.37, start = 0.5): Random {
  let x = start
  return () => {
    x = (x + step) % 1
    return x
  }
}

const RED: Rgb = { r: 255, g: 0, b: 0 }
const BLUE: Rgb = { r: 0, g: 0, b: 255 }
const GREY: Rgb = { r: 128, g: 128, b: 128 }
const cfg = (over: Partial<SpinnerConfig> = {}): SpinnerConfig => ({ enabled: true, colors: [RED, BLUE], intervalMs: 100, cells: 6, ...over })
const BRAILLE = /^[\u2800-\u28ff ]$/

describe("colours", () => {
  it("parses #rrggbb and #rgb, rejects anything else", () => {
    assert.deepEqual(parseHex("#00e5ff"), { r: 0, g: 229, b: 255 })
    assert.deepEqual(parseHex("#2979FF"), { r: 41, g: 121, b: 255 })
    assert.deepEqual(parseHex("#f0a"), { r: 255, g: 0, b: 170 })
    assert.equal(parseHex("#12345"), undefined)
    assert.equal(parseHex("tech"), undefined)
    assert.equal(parseHex("bad"), undefined, "hex-looking words need the #")
    assert.equal(parseHex("2979ff"), undefined)
  })

  it("ships the original's presets", () => {
    assert.deepEqual(THEME_PRESETS.tech, ["#00e5ff", "#2979ff", "#651fff"])
    assert.deepEqual(THEME_PRESETS.red, ["#ff1744", "#ff5252", "#ff8a80"])
  })

  it("interpolates between two colours", () => {
    assert.deepEqual(lerpColor(RED, BLUE, 0), RED)
    assert.deepEqual(lerpColor(RED, BLUE, 1), BLUE)
    assert.deepEqual(lerpColor(RED, BLUE, 0.5), { r: 128, g: 0, b: 128 })
  })

  it("walks a multi-stop gradient and clamps t", () => {
    const stops = [RED, GREY, BLUE]
    assert.deepEqual(gradientColor(stops, 0), RED)
    assert.deepEqual(gradientColor(stops, 0.5), GREY)
    assert.deepEqual(gradientColor(stops, 1), BLUE)
    assert.deepEqual(gradientColor(stops, 7), BLUE)
    assert.deepEqual(gradientColor([GREY], 0.3), GREY)
  })
})

describe("particle stream", () => {
  it("starts with one braille dot or gap per cell", () => {
    const s = createSpinner(6, 0, seq())
    assert.equal(s.stream.length, 6)
    assert.ok(s.stream.every((g) => BRAILLE.test(g)))
    assert.equal(s.hueFrame, 0)
  })

  it("flows one cell per interval, newest first, keeping its length", () => {
    const random = seq()
    const s = createSpinner(6, 0, random)
    const before = [...s.stream]
    advanceSpinner(s, cfg(), 100, random)
    assert.deepEqual(s.stream.slice(1), before.slice(0, 5), "every particle moved one cell away from the meter")
    assert.equal(s.stream.length, 6)
    assert.equal(s.hueFrame, 1)
  })

  it("advances by elapsed time, not by how often it is rendered", () => {
    const random = seq()
    const s = createSpinner(6, 0, random)
    advanceSpinner(s, cfg(), 50, random)
    assert.equal(s.hueFrame, 0, "half an interval: no frame yet")
    advanceSpinner(s, cfg(), 350, random)
    assert.equal(s.hueFrame, 3)
    assert.equal(s.lastFrameAt, 300, "the remainder carries over")
  })

  it("bounds the work after a long pause", () => {
    const random = seq()
    const s = createSpinner(6, 0, random)
    advanceSpinner(s, cfg(), 60_000, random)
    assert.equal(s.stream.length, 6)
    assert.equal(s.hueFrame, 600, "the colour keeps its clock even when the cells are capped")
  })

  it("shows gaps as roughly a fifth of the cells", () => {
    const random = seq(0.618)
    const s = createSpinner(1_000, 0, random)
    const gaps = s.stream.filter((g) => g === " ").length
    assert.ok(gaps > 100 && gaps < 300, `${gaps} gaps in 1000 cells`)
  })
})

describe("spinnerCells", () => {
  it("fades from the gradient colour at the newest cell to muted at the oldest", () => {
    const s = { stream: ["⠁", "⠂", "⠄", "⠈"], hueFrame: 0, lastFrameAt: 0 }
    const cells = spinnerCells(s, cfg({ cells: 4 }), GREY)
    assert.deepEqual(cells[0].color, RED, "hue frame 0 is the first stop")
    assert.deepEqual(cells[3].color, GREY)
    assert.deepEqual(cells.map((c) => c.glyph), s.stream)
  })

  it("drifts the bright colour along the gradient over time", () => {
    const s = { stream: ["⠁", "⠂"], hueFrame: 30, lastFrameAt: 0 }
    assert.deepEqual(spinnerCells(s, cfg({ cells: 2 }), GREY)[0].color, { r: 128, g: 0, b: 128 }, "half way after 30 of 60 frames")
  })

  it("keeps gaps muted", () => {
    const s = { stream: [" ", "⠂", " "], hueFrame: 0, lastFrameAt: 0 }
    const cells = spinnerCells(s, cfg({ cells: 3 }), GREY)
    assert.deepEqual(cells[0].color, GREY)
    assert.deepEqual(cells[2].color, GREY)
  })
})
