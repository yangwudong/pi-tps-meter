import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { alignRight, formatTps, formatTtft, paint, renderLine, speedHue, speedTier, ttftHue, ttftTier, visibleWidth, withSpinner, type Tiers } from "../src/format.ts"
import type { Rgb } from "../src/spinner.ts"

const TIERS: Tiers = { tps: { slow: 20, normal: 50, fast: 100 }, ttft: { fast: 10_000, ok: 20_000 } }

// ---- ported from opencode-tps-meter/test/measure.test.ts ----------------------------------

describe("formatTps", () => {
  it("returns undefined for non-finite or non-positive values", () => {
    assert.equal(formatTps(0), undefined)
    assert.equal(formatTps(-1), undefined)
    assert.equal(formatTps(NaN), undefined)
    assert.equal(formatTps(Infinity), undefined)
  })

  it("formats values below 10 with two decimals", () => {
    assert.equal(formatTps(5.678), "5.68")
    assert.equal(formatTps(0.5), "0.50")
    assert.equal(formatTps(9.994), "9.99")
  })

  it("formats 10 up to 100 with one decimal", () => {
    assert.equal(formatTps(10), "10.0")
    assert.equal(formatTps(42.56), "42.6")
    assert.equal(formatTps(99.94), "99.9")
  })

  it("formats 100 and above as a rounded integer", () => {
    assert.equal(formatTps(100), "100")
    assert.equal(formatTps(127.8), "128")
  })
})

describe("formatTtft", () => {
  it("returns undefined for non-finite or negative values", () => {
    assert.equal(formatTtft(-1), undefined)
    assert.equal(formatTtft(NaN), undefined)
  })

  it("formats milliseconds as seconds with one decimal", () => {
    assert.equal(formatTtft(0), "0.0s")
    assert.equal(formatTtft(800), "0.8s")
    assert.equal(formatTtft(1_500), "1.5s")
    assert.equal(formatTtft(12_340), "12.3s")
  })
})

describe("speedTier boundaries (TPS / AVG)", () => {
  it("is slow below 20", () => {
    assert.equal(speedTier(0, TIERS.tps), "slow")
    assert.equal(speedTier(5, TIERS.tps), "slow")
    assert.equal(speedTier(19.9, TIERS.tps), "slow")
    assert.equal(speedTier(19.99, TIERS.tps), "slow")
  })

  it("is normal from 20 (inclusive) to below 50", () => {
    assert.equal(speedTier(20, TIERS.tps), "normal")
    assert.equal(speedTier(35, TIERS.tps), "normal")
    assert.equal(speedTier(49.9, TIERS.tps), "normal")
    assert.equal(speedTier(49.99, TIERS.tps), "normal")
  })

  it("is fast from 50 (inclusive) to below 100", () => {
    assert.equal(speedTier(50, TIERS.tps), "fast")
    assert.equal(speedTier(75, TIERS.tps), "fast")
    assert.equal(speedTier(99.9, TIERS.tps), "fast")
    assert.equal(speedTier(99.99, TIERS.tps), "fast")
  })

  it("is faster from 100 (inclusive)", () => {
    assert.equal(speedTier(100, TIERS.tps), "faster")
    assert.equal(speedTier(250, TIERS.tps), "faster")
  })

  it("honours overridden thresholds", () => {
    const tps = { slow: 5, normal: 10, fast: 15 }
    assert.equal(speedTier(4.9, tps), "slow")
    assert.equal(speedTier(5, tps), "normal")
    assert.equal(speedTier(10, tps), "fast")
    assert.equal(speedTier(15, tps), "faster")
  })

  it("maps slow/normal/fast/faster to red/yellow/green/cyan", () => {
    assert.deepEqual(
      (["slow", "normal", "fast", "faster"] as const).map(speedHue),
      ["red", "yellow", "green", "cyan"],
    )
  })
})

describe("ttftTier boundaries", () => {
  it("is fast below 10s, ok from 10s, slow from 20s", () => {
    assert.equal(ttftTier(0, TIERS.ttft), "fast")
    assert.equal(ttftTier(9_999, TIERS.ttft), "fast")
    assert.equal(ttftTier(10_000, TIERS.ttft), "ok")
    assert.equal(ttftTier(19_999, TIERS.ttft), "ok")
    assert.equal(ttftTier(20_000, TIERS.ttft), "slow")
  })

  it("honours overridden thresholds", () => {
    const ttft = { fast: 1_000, ok: 3_000 }
    assert.equal(ttftTier(999, ttft), "fast")
    assert.equal(ttftTier(1_000, ttft), "ok")
    assert.equal(ttftTier(3_000, ttft), "slow")
  })

  it("maps fast/ok/slow to green/yellow/red", () => {
    assert.deepEqual((["fast", "ok", "slow"] as const).map(ttftHue), ["green", "yellow", "red"])
  })
})

describe("renderLine", () => {
  it("renders the idle meter with placeholders", () => {
    assert.equal(renderLine({ tps: undefined, avg: undefined, ttftMs: undefined }, TIERS, false), "TPS -- | AVG -- | TTFT --")
  })

  it("renders all three readings in the original's format", () => {
    assert.equal(renderLine({ tps: 42.5, avg: 38.2, ttftMs: 800 }, TIERS, false), "TPS 42.5 | AVG 38.2 | TTFT 0.8s")
  })

  it("keeps the summary when only the live value is missing", () => {
    assert.equal(renderLine({ tps: undefined, avg: 127.4, ttftMs: 12_000 }, TIERS, false), "TPS -- | AVG 127 | TTFT 12.0s")
  })

  it("colours each value by its tier with foreground-only ANSI codes", () => {
    const line = renderLine({ tps: 19.9, avg: 100, ttftMs: 20_000 }, TIERS, true)
    assert.ok(line.includes("\x1b[31m19.9\x1b[39m"), "slow TPS is red")
    assert.ok(line.includes("\x1b[36m100\x1b[39m"), "faster AVG is cyan")
    assert.ok(line.includes("\x1b[31m20.0s\x1b[39m"), "slow TTFT is red")
    assert.ok(line.includes("\x1b[2mTPS \x1b[22m"), "labels are muted")
    assert.ok(!line.includes("\x1b[0m"), "never a full reset")
  })

  it("uses yellow and green for the middle tiers", () => {
    const line = renderLine({ tps: 20, avg: 50, ttftMs: 10_000 }, TIERS, true)
    assert.ok(line.includes("\x1b[33m20.0\x1b[39m"))
    assert.ok(line.includes("\x1b[32m50.0\x1b[39m"))
    assert.ok(line.includes("\x1b[33m10.0s\x1b[39m"))
  })

  it("paints placeholders muted", () => {
    const line = renderLine({ tps: undefined, avg: undefined, ttftMs: 500 }, TIERS, true)
    assert.ok(line.includes(paint("--", "muted")))
    assert.ok(line.includes("\x1b[32m0.5s\x1b[39m"))
  })

  it("strips to the plain line when colour is off", () => {
    const plain = renderLine({ tps: 61, avg: 12.25, ttftMs: 1_234 }, TIERS, false)
    assert.equal(plain, "TPS 61.0 | AVG 12.3 | TTFT 1.2s")
    assert.ok(!plain.includes("\x1b"))
  })
})

describe("particle stream layout", () => {
  const A: Rgb = { r: 1, g: 2, b: 3 }
  const B: Rgb = { r: 4, g: 5, b: 6 }
  const cells = [{ glyph: "⠁", color: A }, { glyph: " ", color: A }, { glyph: "⠂", color: B }]
  const paintRgb = (text: string, c: Rgb) => `<${c.r}>${text}`

  it("follows TTFT with the newest particle first, as the original", () => {
    assert.equal(withSpinner("TTFT 1.0s", cells, paintRgb, "after"), "TTFT 1.0s <1>⠁\u2800<4>⠂")
  })

  it("is mirrored before a right-aligned reading, newest particle next to TPS", () => {
    assert.equal(withSpinner("TPS 1.00", cells, paintRgb, "before"), "<4>⠂\u2800<1>⠁ TPS 1.00")
  })

  it("renders gaps as the empty braille cell, which pi's status sanitizer neither collapses nor trims", () => {
    const gaps = [{ glyph: " ", color: A }, { glyph: " ", color: A }]
    const out = withSpinner("x", gaps, paintRgb, "after")
    assert.equal(out, "x \u2800\u2800")
    assert.equal(out.replace(/ +/g, " ").trim(), out, "unchanged by pi's sanitizeStatusText")
    assert.notEqual("x \u00a0".trim(), "x \u00a0", "why not a no-break space: trim() strips it")
  })
})

describe("right alignment", () => {
  it("measures columns without ANSI codes", () => {
    assert.equal(visibleWidth("\x1b[33m42.5\x1b[39m"), 4)
    assert.equal(visibleWidth("⠁\u2800⠂ TPS"), 7)
  })

  it("pads a line so it ends in the last column", () => {
    const out = alignRight("\x1b[2mTPS\x1b[22m", 10)
    assert.equal(out, "       \x1b[2mTPS\x1b[22m")
    assert.equal(visibleWidth(out), 10)
  })

  it("cuts a line wider than the terminal from the left, so the particles go first", () => {
    assert.equal(alignRight("⠁⠂ TPS 42.5 | AVG 38.2", 8), "AVG 38.2")
    assert.equal(alignRight("\x1b[33mTPS 42.5\x1b[39m", 3), "2.5", "colours are dropped when cutting")
  })

  it("never cuts through an escape sequence of a theme-painted stream", () => {
    const painted = withSpinner("TPS 42.5", [{ glyph: "⠁", color: { r: 0, g: 229, b: 255 } }, { glyph: "⠂", color: { r: 41, g: 121, b: 255 } }],
      (t, c) => `\x1b[38;2;${c.r};${c.g};${c.b}m${t}\x1b[39m`, "before")
    for (let width = 1; width <= visibleWidth(painted); width++) {
      const out = alignRight(painted, width)
      assert.equal(visibleWidth(out), width)
      assert.ok(!/\x1b(?!\[[0-9;]*m)|\[[0-9;]*m/.test(out.replace(/\x1b\[[0-9;]*m/g, "")), `no escape fragments at width ${width}: ${JSON.stringify(out)}`)
    }
  })
})
