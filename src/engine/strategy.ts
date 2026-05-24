import type { UTCTimestamp } from 'lightweight-charts'
import type { Candle } from '../types'
import { computeEma } from './indicators'

export type SignalSide = 'buy' | 'sell'

export interface Signal {
  time: UTCTimestamp
  side: SignalSide
  price: number
  label?: string
  // Optional PAB entry metadata (set on the opening signal):
  sl?: number
  tp?: number
  channelLabel?: string
  // Optional PAB exit metadata (set on the closing signal):
  reason?: 'stop' | 'target'
}

// Pure: same candles in → same signals out. Replace the body when iterating
// on a new idea; markers re-render automatically via Vite HMR.
//
// Placeholder logic: EMA(21) close cross. Buy on close crossing above EMA,
// sell on close crossing below.
export function runStrategy(candles: ReadonlyArray<Candle>): Signal[] {
  const length = 21
  if (candles.length < length + 1) return []

  const emaByTime = new Map<number, number>()
  for (const p of computeEma(candles, length)) emaByTime.set(p.time, p.value)

  const out: Signal[] = []
  let prevDiff: number | null = null
  for (const c of candles) {
    const e = emaByTime.get(c.time as number)
    if (e === undefined) {
      prevDiff = null
      continue
    }
    const diff = c.close - e
    if (prevDiff !== null) {
      if (prevDiff <= 0 && diff > 0) {
        out.push({ time: c.time, side: 'buy', price: c.close })
      } else if (prevDiff >= 0 && diff < 0) {
        out.push({ time: c.time, side: 'sell', price: c.close })
      }
    }
    prevDiff = diff
  }
  return out
}
