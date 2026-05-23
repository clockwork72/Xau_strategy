import type { UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../types'

export interface SwingPoint {
  time: UTCTimestamp
  price: number
  index: number
}

/**
 * Fractal pivot: bar at index `i` is a swing high if its high is strictly
 * greater than the highs of the `lookback` bars on each side. Confirmation
 * lag = `lookback` bars (the rightmost `lookback` bars can never qualify yet).
 */
export function findSwingHighs(
  candles: ReadonlyArray<Candle>,
  lookback = 3,
): SwingPoint[] {
  const out: SwingPoint[] = []
  const n = candles.length
  if (n < lookback * 2 + 1) return out
  for (let i = lookback; i < n - lookback; i++) {
    const h = candles[i].high
    let isHigh = true
    for (let k = 1; k <= lookback; k++) {
      if (candles[i - k].high >= h || candles[i + k].high >= h) {
        isHigh = false
        break
      }
    }
    if (isHigh) out.push({ time: candles[i].time, price: h, index: i })
  }
  return out
}

/** Mirror of findSwingHighs for lows. */
export function findSwingLows(
  candles: ReadonlyArray<Candle>,
  lookback = 3,
): SwingPoint[] {
  const out: SwingPoint[] = []
  const n = candles.length
  if (n < lookback * 2 + 1) return out
  for (let i = lookback; i < n - lookback; i++) {
    const l = candles[i].low
    let isLow = true
    for (let k = 1; k <= lookback; k++) {
      if (candles[i - k].low <= l || candles[i + k].low <= l) {
        isLow = false
        break
      }
    }
    if (isLow) out.push({ time: candles[i].time, price: l, index: i })
  }
  return out
}
