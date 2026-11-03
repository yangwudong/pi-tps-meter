import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  MAX_CALIBRATION_RATIOS,
  MIN_DURATION_MS,
  STALE_MS,
  WINDOW_MS,
  abandonMessage,
  calculateLiveTps,
  calibrationFactor,
  completeMessage,
  createMeterState,
  estimateTokens,
  median,
  readMeter,
  recordDelta,
  startMessage,
  startTurn,
  type DeltaKind,
  type DeltaSample,
  type MeterState,
} from "../src/core.ts"

const close = (actual: number | undefined, expected: number, digits = 1) => {
  assert.ok(actual !== undefined, `expected ≈${expected}, got undefined`)
  assert.ok(Math.abs(actual - expected) < 10 ** -digits / 2, `expected ≈${expected}, got ${actual}`)
}

// Streams `chunks` one every `intervalMs` starting at `from`; returns the time of the last chunk.
function stream(state: MeterState, from: number, chunks: string[], intervalMs: number, kind: DeltaKind = "text"): number {
  let at = from
  chunks.forEach((chunk, i) => {
    at = from + i * intervalMs
    recordDelta(state, at, chunk, kind)
  })
  return at
}

// Splits text into chunks of 1–2 characters, like CJK streams usually arrive.
function cjkChunks(text: string): string[] {
  const chars = [...text]
  const out: string[] = []
  for (let i = 0; i < chars.length; ) {
    const size = i % 3 === 0 ? 2 : 1
    out.push(chars.slice(i, i + size).join(""))
    i += size
  }
  return out
}

// ---- ported from opencode-tps-meter/test/measure.test.ts ----------------------------------

describe("estimateTokens", () => {
  it("returns at least 1 for any input", () => {
    assert.equal(estimateTokens(""), 1)
    assert.equal(estimateTokens("a"), 1)
  })

  it("estimates from UTF-8 byte length / 4", () => {
    assert.equal(estimateTokens("hello"), 2) // 5 bytes
    assert.equal(estimateTokens("hello world"), 3) // 11 bytes
  })

  it("counts UTF-8 bytes, not characters, for multi-byte text", () => {
    assert.equal(estimateTokens("日本語"), 3) // 9 bytes
    assert.equal(estimateTokens("杭州西湖"), 3) // 12 bytes
    assert.equal(estimateTokens("湖"), 1) // 3 bytes
  })
})

describe("median", () => {
  it("returns the middle value for odd-length arrays", () => {
    assert.equal(median([1, 3, 5]), 3)
    assert.equal(median([5, 1, 3]), 3)
  })

  it("returns the average of the two middle values for even-length arrays", () => {
    assert.equal(median([1, 2, 3, 4]), 2.5)
  })

  it("returns 1.0 for an empty array and the value for a single element", () => {
    assert.equal(median([]), 1.0)
    assert.equal(median([42]), 42)
  })
})

describe("calibrationFactor", () => {
  it("is 1.0 without ratios", () => {
    assert.equal(calibrationFactor([]), 1.0)
  })

  it("is the median of the ratios", () => {
    assert.equal(calibrationFactor([1.1, 1.3, 1.5]), 1.3)
    assert.equal(calibrationFactor([1.0, 1.2, 1.4, 1.6]), 1.3)
  })

  it("ignores a single outlier that a mean would follow", () => {
    assert.equal(calibrationFactor([0.7, 0.72, 3.0]), 0.72)
  })
})

describe("calculateLiveTps (sliding window)", () => {
  const now = 10_000

  it("returns undefined for empty samples", () => {
    assert.equal(calculateLiveTps([], now, 1.0), undefined)
  })

  it("returns undefined when all samples are outside the window", () => {
    assert.equal(calculateLiveTps([{ at: now - 6_000, rawTokens: 10 }], now, 1.0), undefined)
  })

  it("returns undefined when the latest sample is stale (>1.5s old)", () => {
    assert.equal(calculateLiveTps([{ at: now - 2_000, rawTokens: 10 }], now, 1.0), undefined)
  })

  it("calculates TPS from wall-clock duration (now - oldest)", () => {
    const samples: DeltaSample[] = [
      { at: now - 2_000, rawTokens: 10 },
      { at: now - 1_000, rawTokens: 20 },
      { at: now, rawTokens: 20 },
    ]
    close(calculateLiveTps(samples, now, 1.0), 25) // 50 tokens / 2s
  })

  it("uses now - oldest, not last - oldest, when the latest sample is not at now", () => {
    const samples: DeltaSample[] = [
      { at: now - 3_000, rawTokens: 10 },
      { at: now - 1_000, rawTokens: 20 },
    ]
    close(calculateLiveTps(samples, now, 1.0), 10) // 30 tokens / 3s
  })

  it("applies the calibration factor to raw tokens", () => {
    const samples: DeltaSample[] = [
      { at: now - 2_000, rawTokens: 10 },
      { at: now - 1_000, rawTokens: 20 },
      { at: now, rawTokens: 20 },
    ]
    close(calculateLiveTps(samples, now, 2.0), 50)
  })

  it("floors the duration at 1000ms so a single sample cannot spike", () => {
    close(calculateLiveTps([{ at: now - 500, rawTokens: 10 }], now, 1.0), 10)
  })

  it("uses the actual elapsed time above the floor", () => {
    close(calculateLiveTps([{ at: now - 1_200, rawTokens: 5 }], now, 1.0), 4.17, 2)
  })

  it("only counts samples inside the 5-second window", () => {
    const samples: DeltaSample[] = [
      { at: now - 6_000, rawTokens: 100 },
      { at: now - 2_000, rawTokens: 10 },
      { at: now, rawTokens: 20 },
    ]
    close(calculateLiveTps(samples, now, 1.0), 15) // 30 tokens / 2s
  })
})

// ---- the pi state machine ---------------------------------------------------------------

describe("sliding window in the tracker", () => {
  it("prunes samples older than WINDOW_MS as new deltas arrive", () => {
    const s = createMeterState()
    startMessage(s, 0)
    const last = stream(s, 0, Array.from({ length: 80 }, () => "abcd"), 100) // 1 token each, 10/s
    assert.equal(last, 7_900)
    assert.ok(s.samples.every((x) => x.at >= last - WINDOW_MS))
    assert.equal(s.samples.length, 51) // 2.9s … 7.9s inclusive
    close(readMeter(s, last).tps, 51 / 5, 2) // full 5s window at a steady 10 tokens/s
  })

  it("reads a steady stream at its true rate once the window fills", () => {
    const s = createMeterState()
    startMessage(s, 0)
    const last = stream(s, 0, Array.from({ length: 300 }, () => "abcdefgh"), 50) // 2 tokens / 50ms
    close(readMeter(s, last).tps, 202 / 5, 2) // 101 samples inside the inclusive 5s window
  })

  it("never lets the previous message's samples dilute the next one across a tool run", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 0)
    const end1 = stream(s, 0, Array.from({ length: 40 }, () => "abcdefgh"), 50) // 40 TPS
    completeMessage(s, 80)
    // a 2s tool run, then the next turn; message 2 starts 3s after message 1 ended
    startTurn(s, end1 + 2_000)
    startMessage(s, end1 + 3_000)
    const end2 = stream(s, end1 + 3_000, Array.from({ length: 30 }, () => "abcdefgh"), 50)
    // only message 2's 1.45s of samples count: 60 raw tokens / 1.45s (calibration 80/80 = 1.0)
    close(readMeter(s, end2).tps, 60 / 1.45, 1)
  })
})

describe("STALE expiry", () => {
  it("hides TPS once no delta arrived for more than STALE_MS", () => {
    const s = createMeterState()
    startMessage(s, 0)
    const last = stream(s, 0, ["abcd", "abcd", "abcd"], 100)
    assert.ok(readMeter(s, last + STALE_MS).tps !== undefined)
    assert.equal(readMeter(s, last + STALE_MS + 1).tps, undefined)
  })

  it("brings TPS back as soon as the stream resumes", () => {
    const s = createMeterState()
    startMessage(s, 0)
    const last = stream(s, 0, ["abcd", "abcd"], 100)
    assert.equal(readMeter(s, last + 3_000).tps, undefined)
    recordDelta(s, last + 3_000, "abcd", "text")
    assert.ok(readMeter(s, last + 3_000).tps !== undefined)
  })

  it("blanks TPS immediately at message end", () => {
    const s = createMeterState()
    startMessage(s, 0)
    const last = stream(s, 0, ["abcd", "abcd"], 100)
    completeMessage(s, 2)
    assert.equal(readMeter(s, last).tps, undefined)
  })
})

describe("TTFT", () => {
  it("measures from turn_start, not message_start, to the first text delta", () => {
    const s = createMeterState()
    startTurn(s, 1_000)
    startMessage(s, 3_200) // pi opens the message only after the response headers
    assert.equal(recordDelta(s, 3_201, "你", "text"), true)
    assert.equal(readMeter(s, 3_201).ttftMs, 2_201)
  })

  it("is ended by the first thinking delta too", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 900)
    recordDelta(s, 950, "Let me think", "thinking")
    recordDelta(s, 2_000, "答", "text")
    assert.equal(s.ttftMs, 950)
  })

  it("is not ended by toolcall deltas, which still count as output", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 500)
    assert.equal(recordDelta(s, 600, '{"path":"src/a.ts"', "toolcall"), false)
    assert.equal(s.ttftMs, undefined)
    assert.equal(s.samples.length, 1)
    assert.ok(s.estimatedTokens > 0)
    assert.equal(recordDelta(s, 1_400, "Done", "text"), true)
    assert.equal(s.ttftMs, 1_400)
  })

  it("stays unset for a message that streams only a tool call", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 400)
    stream(s, 400, ['{"command":', '"ls -la"}'], 20, "toolcall")
    completeMessage(s, 12)
    assert.equal(readMeter(s, 1_000).ttftMs, undefined)
  })

  it("falls back to message_start when no turn_start was seen", () => {
    const s = createMeterState()
    startMessage(s, 500)
    recordDelta(s, 800, "hi", "text")
    assert.equal(s.ttftMs, 300)
  })

  it("is recorded once per message", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 100)
    assert.equal(recordDelta(s, 200, "a", "text"), true)
    assert.equal(recordDelta(s, 300, "b", "text"), false)
    assert.equal(s.ttftMs, 200)
  })

  it("persists after the message ends and through the next turn's wait", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 100)
    recordDelta(s, 800, "a", "text")
    completeMessage(s, 1)
    assert.equal(readMeter(s, 5_000).ttftMs, 800)
    startTurn(s, 6_000) // tool results go back to the model; still waiting
    assert.equal(readMeter(s, 8_000).ttftMs, 800)
  })

  it("resets at the next message_start and measures that turn from its own turn_start", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 100)
    recordDelta(s, 800, "a", "text")
    completeMessage(s, 1)
    startTurn(s, 6_000)
    startMessage(s, 9_000)
    assert.equal(s.ttftMs, undefined)
    recordDelta(s, 9_001, "b", "thinking")
    assert.equal(s.ttftMs, 3_001)
  })

  it("does not reuse a consumed turn_start", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 100)
    abandonMessage(s)
    startMessage(s, 5_000) // e.g. a host that emits a second message without a new turn_start
    recordDelta(s, 5_100, "x", "text")
    assert.equal(s.ttftMs, 100)
  })

  it("keeps a TTFT already shown when the message is aborted", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 100)
    recordDelta(s, 700, "a", "text")
    abandonMessage(s)
    assert.equal(readMeter(s, 1_000).ttftMs, 700)
  })
})

describe("AVG", () => {
  it("is undefined until a message completes", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, ["abcd", "abcd"], 100)
    assert.equal(readMeter(s, 100).avg, undefined)
  })

  it("is the sum of authoritative tokens over the sum of generation spans", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, ["a", "b", "c"], 1_000) // span 0 → 2000
    completeMessage(s, 100)
    close(readMeter(s, 3_000).avg, 50)
    startMessage(s, 10_000)
    stream(s, 10_000, ["a", "b", "c", "d", "e"], 1_000) // span 10000 → 14000
    completeMessage(s, 300)
    close(readMeter(s, 20_000).avg, 400 / 6, 2) // (100 + 300) / (2s + 4s), not the mean of 50 and 75
  })

  it("excludes the wait before the first delta (TTFT) from the span", () => {
    const s = createMeterState()
    startTurn(s, 0)
    startMessage(s, 0)
    stream(s, 5_000, ["a", "b", "c"], 1_000) // first delta 5s after the turn started
    completeMessage(s, 100)
    close(readMeter(s, 8_000).avg, 50) // 100 tokens over 2s, not over 7s
  })

  it("floors a message's span at MIN_DURATION_MS", () => {
    const s = createMeterState()
    startMessage(s, 0)
    recordDelta(s, 10, "short answer", "text")
    completeMessage(s, 40)
    close(readMeter(s, 100).avg, 40 / (MIN_DURATION_MS / 1000))
  })

  it("skips messages without an authoritative count or without deltas", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, ["a", "b"], 1_000)
    completeMessage(s, 0)
    startMessage(s, 5_000)
    completeMessage(s, 500) // non-streaming message: nothing was timed
    assert.equal(readMeter(s, 6_000).avg, undefined)
    assert.deepEqual(s.stats.calibrationRatios, [])
  })

  it("skips aborted / errored messages, whose usage is partial", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, ["a", "b", "c"], 1_000)
    completeMessage(s, 100)
    startMessage(s, 10_000)
    stream(s, 10_000, ["a", "b", "c"], 100)
    abandonMessage(s)
    close(readMeter(s, 20_000).avg, 50)
    assert.equal(s.stats.calibrationRatios.length, 1)
  })

  it("includes tool-call streaming in the span, since usage.output counts those tokens", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, ["I'll edit it."], 0, "text")
    stream(s, 100, Array.from({ length: 20 }, () => '"x":1,'), 100, "toolcall") // until 2000
    completeMessage(s, 100)
    close(readMeter(s, 3_000).avg, 50) // 100 tokens over 0 → 2000ms
  })
})

describe("calibration", () => {
  it("records actual / estimated for each completed message", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, Array.from({ length: 10 }, () => "abcdefgh"), 100) // estimate 20
    completeMessage(s, 30)
    assert.deepEqual(s.stats.calibrationRatios, [1.5])
  })

  it("clamps ratios to [0.3, 3.0]", () => {
    const s = createMeterState()
    startMessage(s, 0)
    stream(s, 0, ["abcd", "abcd"], 100) // estimate 2
    completeMessage(s, 100)
    startMessage(s, 1_000)
    stream(s, 1_000, ["a".repeat(400)], 0) // estimate 100
    completeMessage(s, 1)
    assert.deepEqual(s.stats.calibrationRatios, [3.0, 0.3])
  })

  it(`keeps only the last ${MAX_CALIBRATION_RATIOS} ratios`, () => {
    const s = createMeterState()
    for (let i = 1; i <= 12; i++) {
      startMessage(s, i * 10_000)
      stream(s, i * 10_000, Array.from({ length: 10 }, () => "abcd"), 100) // estimate 10
      completeMessage(s, i) // ratio i / 10
    }
    assert.equal(s.stats.calibrationRatios.length, MAX_CALIBRATION_RATIOS)
    close(s.stats.calibrationRatios[0], 0.3, 6)
    close(s.stats.calibrationRatios.at(-1), 1.2, 6)
  })

  it("is applied to the next message's live rate, not the one that produced it", () => {
    const s = createMeterState()
    startMessage(s, 0)
    const end = stream(s, 0, Array.from({ length: 40 }, () => "abcdefgh"), 50) // 80 raw tokens over 1.95s
    close(readMeter(s, end).tps, 80 / 1.95, 2) // uncalibrated
    completeMessage(s, 40) // ratio 0.5, applies from the next message on
    startMessage(s, 10_000)
    const end2 = stream(s, 10_000, Array.from({ length: 40 }, () => "abcdefgh"), 50)
    close(readMeter(s, end2).tps, (80 * 0.5) / 1.95, 2)
  })

  it("converges a CJK stream to within ±15% of the authoritative rate after one message", () => {
    // A CJK-efficient tokenizer: ~0.62 tokens per character. Streamed 1–2 characters per delta,
    // the byte heuristic counts ~1 token per character, i.e. ~60% too high before calibration.
    const tokensFor = (text: string) => Math.round([...text].length * 0.62)
    const first = "杭州西湖位于浙江省杭州市西面，是中国大陆首批国家重点风景名胜区和中国十大风景名胜之一。".repeat(6)
    const second = "西湖三面环山，面积约六点三九平方千米，东西宽约二点八千米，南北长约三点二千米，绕湖一周近十五千米。".repeat(6)

    const s = createMeterState()
    const check = (text: string, from: number) => {
      startTurn(s, from - 1_500)
      startMessage(s, from)
      const chunks = cjkChunks(text)
      const errors: number[] = []
      let at = from
      chunks.forEach((chunk, i) => {
        at = from + i * 40
        recordDelta(s, at, chunk, "text")
        if (at - from >= WINDOW_MS) errors.push(readMeter(s, at).tps!)
      })
      const truth = tokensFor(text) / ((at - from) / 1000)
      completeMessage(s, tokensFor(text))
      return errors.map((tps) => tps / truth - 1)
    }

    const uncalibrated = check(first, 10_000)
    assert.ok(uncalibrated.every((e) => e > 0.15), "the raw byte estimate is off by more than 15%")

    const calibrated = check(second, 60_000)
    assert.ok(calibrated.length > 20)
    for (const e of calibrated) assert.ok(Math.abs(e) <= 0.15, `calibrated error ${(e * 100).toFixed(1)}% exceeds ±15%`)
  })

  it("converges for mixed English thinking and Chinese text", () => {
    const s = createMeterState()
    const run = (from: number, ratioTruth: number) => {
      startMessage(s, from)
      let at = from
      for (let i = 0; i < 40; i++) recordDelta(s, (at = from + i * 30), "The user wants a short ", "thinking")
      for (let i = 0; i < 120; i++) recordDelta(s, (at = from + 1_200 + i * 30), "湖", "text")
      const estimated = s.estimatedTokens
      const truth = Math.round(estimated * ratioTruth)
      const live = readMeter(s, at).tps!
      const actualRate = (estimated * ratioTruth) / 5 // the full window holds 5s of a steady mix
      completeMessage(s, truth)
      return { live, actualRate }
    }
    run(0, 0.72)
    const { live, actualRate } = run(20_000, 0.72)
    assert.ok(Math.abs(live / actualRate - 1) <= 0.15, `live ${live.toFixed(1)} vs authoritative ${actualRate.toFixed(1)}`)
  })
})

describe("thinking flag (drives the particle stream)", () => {
  it("follows the latest delta: reasoning sets it, text and tool calls clear it", () => {
    const s = createMeterState()
    startMessage(s, 0)
    assert.equal(s.thinking, false)
    recordDelta(s, 10, "Let me think", "thinking")
    assert.equal(s.thinking, true)
    recordDelta(s, 20, "答案", "text")
    assert.equal(s.thinking, false)
    recordDelta(s, 30, "more thought", "thinking")
    assert.equal(s.thinking, true)
    recordDelta(s, 40, '{"path":"a.ts"', "toolcall")
    assert.equal(s.thinking, false, "the original cleared it on tool input start")
  })

  it("is off at every message boundary", () => {
    const s = createMeterState()
    startMessage(s, 0)
    recordDelta(s, 10, "hmm", "thinking")
    completeMessage(s, 5)
    assert.equal(s.thinking, false)
    startMessage(s, 100)
    recordDelta(s, 110, "hmm", "thinking")
    abandonMessage(s)
    assert.equal(s.thinking, false)
    s.thinking = true
    startMessage(s, 200)
    assert.equal(s.thinking, false)
  })
})
