import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { FOOTER_GAP, mergeFooterLine, type WidthFns } from "../src/footer.ts"

// Widths as a terminal counts them: ANSI takes none, CJK takes two.
const ANSI = /\x1b\[[0-9;]*m/g
const fns: WidthFns = {
  visibleWidth: (s) => [...s.replace(ANSI, "")].reduce((w, c) => w + (/[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1), 0),
  truncate: (s, width) => {
    let out = ""
    let w = 0
    for (const c of s.replace(ANSI, "")) {
      const cw = /[\u2e80-\u9fff\uff00-\uffef]/.test(c) ? 2 : 1
      if (w + cw > width - 3) return out + "..."
      out += c
      w += cw
    }
    return out
  },
}
const METER = "TPS -- | AVG 79.1 | TTFT 6.1s" // 29 columns

describe("mergeFooterLine", () => {
  it("puts the meter at the right end of the directory line", () => {
    const out = mergeFooterLine("~/workspaces/personal/troubleshooting", METER, 100, fns)
    assert.equal(fns.visibleWidth(out), 100)
    assert.ok(out.startsWith("~/workspaces/personal/troubleshooting "))
    assert.ok(out.endsWith(METER))
  })

  it("keeps pi's own styling on the directory part", () => {
    const left = "\x1b[38;5;244m~/code (main)\x1b[39m"
    const out = mergeFooterLine(left, METER, 80, fns)
    assert.ok(out.startsWith(left))
    assert.equal(fns.visibleWidth(out), 80)
  })

  it("shortens a long directory first, keeping the meter whole", () => {
    const left = "~/" + "a/".repeat(60)
    const out = mergeFooterLine(left, METER, 60, fns)
    assert.equal(fns.visibleWidth(out), 60)
    assert.ok(out.endsWith(METER))
    assert.ok(out.includes("..."), "truncated with an ellipsis")
    assert.ok(out.includes(" ".repeat(FOOTER_GAP) + METER), `at least ${FOOTER_GAP} columns between the two`)
  })

  it("measures CJK directory names as two columns", () => {
    const left = "~/工作/项目/西湖" // 2 + 4 + 1 + 4 + 1 + 4 = 16 columns
    const out = mergeFooterLine(left, METER, 50, fns)
    assert.equal(fns.visibleWidth(out), 50)
    assert.equal(out, left + " ".repeat(50 - 16 - 29) + METER)
  })

  it("leaves only the meter when the terminal fits nothing more", () => {
    const out = mergeFooterLine("~/long/path", METER, 30, fns)
    assert.equal(out.trimStart(), METER)
    assert.equal(fns.visibleWidth(out), 30)
  })

  it("leaves the line as pi rendered it when even the meter does not fit, or there is none", () => {
    assert.equal(mergeFooterLine("~/x", METER, 20, fns), "~/x")
    assert.equal(mergeFooterLine("~/x", "", 80, fns), "~/x")
  })
})
