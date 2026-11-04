// Puts the meter on the right end of the first line of pi's own footer (the working directory
// line), the way pi itself right-aligns the model name on the line below. Pure: the terminal
// width functions are injected (pi-tui's in pi, simple ones in tests), so this runs on plain Node.

export type WidthFns = {
  // Terminal columns of a string: ANSI codes take none, CJK characters take two.
  visibleWidth(text: string): number
  // Cut a string to at most `width` columns; the caller decides the ellipsis (pi uses a dim "...").
  truncate(text: string, width: number): string
}

// Columns kept free between the directory and the meter.
export const FOOTER_GAP = 2

// The meter is the point of this line, so on a narrow terminal the directory gives way first
// (truncated with an ellipsis, as pi itself does); the meter is only dropped when even it alone
// would not fit. Returns exactly `width` columns, padded between the two parts.
export function mergeFooterLine(left: string, meter: string, width: number, fns: WidthFns): string {
  const meterWidth = fns.visibleWidth(meter)
  if (meter === "" || meterWidth > width) return left
  const room = width - meterWidth - FOOTER_GAP
  let head = left
  if (room <= 0) head = ""
  else if (fns.visibleWidth(left) > room) head = fns.truncate(left, room)
  const pad = width - fns.visibleWidth(head) - meterWidth
  return head + " ".repeat(Math.max(0, pad)) + meter
}
