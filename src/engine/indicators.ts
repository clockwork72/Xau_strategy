import type { Candle } from '../types'

export interface LinePoint {
  time: number
  value: number
}

/** Exponential moving average over close prices.
 *  Conventional behavior: starts plotting at bar (length-1), seeded by SMA of first `length` closes. */
export function computeEma(candles: ReadonlyArray<Candle>, length: number): LinePoint[] {
  if (length <= 0 || candles.length === 0) return []
  const k = 2 / (length + 1)
  const out: LinePoint[] = []

  if (candles.length < length) {
    let prev = candles[0].close
    out.push({ time: candles[0].time, value: prev })
    for (let i = 1; i < candles.length; i++) {
      prev = candles[i].close * k + prev * (1 - k)
      out.push({ time: candles[i].time, value: prev })
    }
    return out
  }

  let sum = 0
  for (let i = 0; i < length; i++) sum += candles[i].close
  let prev = sum / length
  out.push({ time: candles[length - 1].time, value: prev })
  for (let i = length; i < candles.length; i++) {
    prev = candles[i].close * k + prev * (1 - k)
    out.push({ time: candles[i].time, value: prev })
  }
  return out
}
