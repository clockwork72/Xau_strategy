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

/**
 * A channel paired with display metadata. Labels (R1/R2/S1/S2…) are assigned
 * by enumeration order over the full detected list, so a hidden channel keeps
 * its label and the visible numbering can have gaps. Signature is a stable
 * key for hide-state persistence across recomputes — same anchor times = same
 * sig, so toggling Hide survives replay scrubs as long as the algo re-detects
 * the same anchored channel.
 */
export interface ChannelMeta {
  channel: Channel
  sig: string
  label: string
}

export function channelSignature(c: Pick<Channel, 'kind' | 'startTime' | 'endTime'>): string {
  return `${c.kind}|${c.startTime}|${c.endTime}`
}

export function withChannelMeta(channels: ReadonlyArray<Channel>): ChannelMeta[] {
  let resCount = 0
  let supCount = 0
  return channels.map((channel) => {
    const label = channel.kind === 'resistance' ? `R${++resCount}` : `S${++supCount}`
    return { channel, sig: channelSignature(channel), label }
  })
}

/**
 * Geometric fingerprint — kind + slope + y-position at a reference time.
 * Used for sticky per-channel hide: a re-anchored same-geometry channel
 * matches its fingerprint even though its sig changed (because anchor times
 * shifted as new pivots fit). Tolerances: 10% relative slope + 0.1% of price
 * for y at a common reference (~$4.5 on $4500 gold).
 */
export interface ChannelFingerprint {
  kind: ChannelKind
  slope: number    // upper rail slope (price units per second)
  refTime: number  // reference timestamp (we use startTime)
  refY: number     // upper rail y at refTime
}

const FP_SLOPE_TOL = 0.10
const FP_Y_TOL_PCT = 0.001

export function makeFingerprint(c: Channel): ChannelFingerprint {
  const dt = c.endTime - c.startTime || 1
  const slope = (c.upperEnd - c.upperStart) / dt
  return { kind: c.kind, slope, refTime: c.startTime, refY: c.upperStart }
}

export function channelMatchesFingerprint(c: Channel, fp: ChannelFingerprint): boolean {
  if (c.kind !== fp.kind) return false
  const dt = c.endTime - c.startTime || 1
  const slope = (c.upperEnd - c.upperStart) / dt
  const slopeRef = Math.max(Math.abs(slope), Math.abs(fp.slope), 1e-9)
  if (Math.abs(slope - fp.slope) / slopeRef > FP_SLOPE_TOL) return false
  const yFpAtCStart = fp.refY + fp.slope * (c.startTime - fp.refTime)
  const yDiff = Math.abs(c.upperStart - yFpAtCStart)
  const yEps = Math.max(Math.abs(c.upperStart), 1) * FP_Y_TOL_PCT
  return yDiff <= yEps
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
