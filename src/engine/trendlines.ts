import type { Candle } from '../types'
import type { SwingPoint } from './swings'

export type ChannelKind = 'resistance' | 'support'

export interface Channel {
  startTime: number     // earliest touching pivot's time
  endTime: number       // latest touching pivot's time
  upperStart: number    // upper rail y at startTime
  upperEnd: number      // upper rail y at endTime
  lowerStart: number    // lower rail y at startTime
  lowerEnd: number      // lower rail y at endTime
  touches: number       // pivots touching the touch-scored rail
  kind: ChannelKind     // which rail was touch-scored
}

const TOUCH_PCT = 0.0006 // 0.06% of mid-window price ≈ $2.70 on $4500 gold
const MIN_TOUCHES = 3

/**
 * Touch-scored channel detection.
 *  - kind='resistance': swings should be swing highs; line is anchored to
 *    them (upper rail); parallel lower rail derived from lowest low between.
 *  - kind='support': swings should be swing lows; line is anchored to them
 *    (lower rail); parallel upper rail derived from highest high between.
 */
export function pickChannels(
  swings: ReadonlyArray<SwingPoint>,
  candles: ReadonlyArray<Candle>,
  kind: ChannelKind,
): Channel[] {
  if (swings.length < 2 || candles.length === 0) return []
  const midPrice = candles[Math.floor(candles.length / 2)].close
  const eps = midPrice * TOUCH_PCT

  interface Scored {
    firstIdx: number
    lastIdx: number
    aSwing: SwingPoint
    slope: number
    touches: number
  }
  const candidates: Scored[] = []
  for (let i = 0; i < swings.length - 1; i++) {
    for (let j = i + 1; j < swings.length; j++) {
      const a = swings[i]
      const b = swings[j]
      const aT = a.time as number
      const bT = b.time as number
      const slope = (b.price - a.price) / (bT - aT)
      let touches = 0
      let first = i
      let last = j
      for (let k = 0; k < swings.length; k++) {
        const lineY = a.price + slope * ((swings[k].time as number) - aT)
        if (Math.abs(swings[k].price - lineY) <= eps) {
          touches++
          if (k < first) first = k
          if (k > last) last = k
        }
      }
      if (touches >= MIN_TOUCHES) {
        candidates.push({ firstIdx: first, lastIdx: last, aSwing: a, slope, touches })
      }
    }
  }

  candidates.sort((x, y) => y.touches - x.touches)

  const accepted: Channel[] = []
  const ranges: Array<[number, number]> = []
  for (const c of candidates) {
    const startTime = swings[c.firstIdx].time as number
    const endTime = swings[c.lastIdx].time as number
    const overlaps = ranges.some(([s, e]) => !(endTime < s || startTime > e))
    if (overlaps) continue

    const firstCandleIdx = swings[c.firstIdx].index
    const lastCandleIdx = swings[c.lastIdx].index

    // Touch-scored rail's y at start/end
    const aT = c.aSwing.time as number
    const touchedStart = c.aSwing.price + c.slope * (startTime - aT)
    const touchedEnd = c.aSwing.price + c.slope * (endTime - aT)

    // Derived parallel rail: through the extreme price in the opposite
    // direction between firstCandleIdx and lastCandleIdx.
    let extIdx = firstCandleIdx
    if (kind === 'resistance') {
      for (let k = firstCandleIdx; k <= lastCandleIdx; k++) {
        if (candles[k].low < candles[extIdx].low) extIdx = k
      }
    } else {
      for (let k = firstCandleIdx; k <= lastCandleIdx; k++) {
        if (candles[k].high > candles[extIdx].high) extIdx = k
      }
    }
    const extTime = candles[extIdx].time as number
    const extPrice = kind === 'resistance' ? candles[extIdx].low : candles[extIdx].high
    const derivedStart = extPrice + c.slope * (startTime - extTime)
    const derivedEnd = extPrice + c.slope * (endTime - extTime)

    const upperStart = kind === 'resistance' ? touchedStart : derivedStart
    const upperEnd = kind === 'resistance' ? touchedEnd : derivedEnd
    const lowerStart = kind === 'resistance' ? derivedStart : touchedStart
    const lowerEnd = kind === 'resistance' ? derivedEnd : touchedEnd

    accepted.push({
      startTime,
      endTime,
      upperStart,
      upperEnd,
      lowerStart,
      lowerEnd,
      touches: c.touches,
      kind,
    })
    ranges.push([startTime, endTime])
  }

  return accepted
}
