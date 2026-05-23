import type { IChartApi, ISeriesApi, Time } from 'lightweight-charts'
import type { Candle } from '../types'
import type { SwingPoint } from './swings'

export type DrawTool = 'cursor' | 'trendline' | 'horizontal'

export interface DrawnLine {
  id: string
  tool: 'trendline' | 'horizontal'
  // Both anchors stored in real UTC seconds + price units. For horizontal
  // lines, p2 === p1 and t2 is a far-right anchor so the rendered line
  // extends well past the visible area.
  t1: number
  p1: number
  t2: number
  p2: number
}

export type PivotSource = 'swingHigh' | 'swingLow' | 'candleHigh' | 'candleLow'

export interface SnapResult {
  time: number
  price: number
  source: PivotSource | null
  deltaPx: number | null
}

const CANDLE_SCAN_RADIUS = 3

/**
 * Snap (time, price) to the nearest pivot — swing high/low first, then raw
 * candle high/low within a few bars of the cursor — provided it lies within
 * εpx pixels of the cursor in screen space. Returns the original coordinates
 * with source=null if nothing close enough.
 */
export function snapToNearestPivot(
  time: number,
  price: number,
  highs: ReadonlyArray<SwingPoint>,
  lows: ReadonlyArray<SwingPoint>,
  candles: ReadonlyArray<Candle>,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  εpx = 8,
): SnapResult {
  const cursorX = chart.timeScale().timeToCoordinate(time as Time)
  const cursorY = series.priceToCoordinate(price)
  if (cursorX === null || cursorY === null) {
    return { time, price, source: null, deltaPx: null }
  }

  let bestDist = Infinity
  let bestTime = time
  let bestPrice = price
  let bestSource: PivotSource | null = null

  const consider = (t: number, p: number, source: PivotSource) => {
    const x = chart.timeScale().timeToCoordinate(t as Time)
    const y = series.priceToCoordinate(p)
    if (x === null || y === null) return
    const d = Math.hypot(x - cursorX, y - cursorY)
    if (d <= εpx && d < bestDist) {
      bestDist = d
      bestTime = t
      bestPrice = p
      bestSource = source
    }
  }

  for (const s of highs) consider(s.time as number, s.price, 'swingHigh')
  for (const s of lows) consider(s.time as number, s.price, 'swingLow')

  const idx = nearestCandleIndex(candles, time)
  if (idx !== -1) {
    const lo = Math.max(0, idx - CANDLE_SCAN_RADIUS)
    const hi = Math.min(candles.length - 1, idx + CANDLE_SCAN_RADIUS)
    for (let i = lo; i <= hi; i++) {
      const c = candles[i]
      consider(c.time as number, c.high, 'candleHigh')
      consider(c.time as number, c.low, 'candleLow')
    }
  }

  if (bestSource === null) return { time, price, source: null, deltaPx: null }
  return { time: bestTime, price: bestPrice, source: bestSource, deltaPx: bestDist }
}

/**
 * Largest candle index i where candles[i].time <= t. -1 if empty.
 * (Duplicated from TradingResearchSandbox's findIndexForTime to keep drawing
 *  self-contained — both walk the same shape.)
 */
function nearestCandleIndex(candles: ReadonlyArray<Candle>, t: number): number {
  const n = candles.length
  if (n === 0) return -1
  if ((candles[0].time as number) > t) return 0
  if ((candles[n - 1].time as number) <= t) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((candles[mid].time as number) <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * True if (px, py) on the rendered chart is within εpx of the line's
 * projected segment. Horizontal lines collapse to a constant-y test so
 * they're easy to hit anywhere along their length.
 */
export function hitTestLine(
  px: number,
  py: number,
  line: DrawnLine,
  chart: IChartApi,
  series: ISeriesApi<'Candlestick'>,
  εpx = 6,
): boolean {
  if (line.tool === 'horizontal') {
    const y = series.priceToCoordinate(line.p1)
    if (y === null) return false
    return Math.abs(py - y) <= εpx
  }
  const x1 = chart.timeScale().timeToCoordinate(line.t1 as Time)
  const y1 = series.priceToCoordinate(line.p1)
  const x2 = chart.timeScale().timeToCoordinate(line.t2 as Time)
  const y2 = series.priceToCoordinate(line.p2)
  if (x1 === null || y1 === null || x2 === null || y2 === null) return false
  return pointSegmentDistance(px, py, x1, y1, x2, y2) <= εpx
}

function pointSegmentDistance(
  px: number, py: number,
  x1: number, y1: number,
  x2: number, y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  if (len2 === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / len2
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

let counter = 0
export function nextLineId(): string {
  counter = (counter + 1) >>> 0
  return `ln_${Date.now().toString(36)}_${counter.toString(36)}`
}

/**
 * Far-right anchor time for a horizontal line — well past any reasonable
 * visible range so the rendered line appears to extend forever, but still
 * a concrete UTC second so lightweight-charts can place it.
 */
export const HORIZONTAL_EXTEND_SEC = 60 * 60 * 24 * 30 // 30 days
