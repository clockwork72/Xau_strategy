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
  status: 'live' | 'broken'
}

export function channelSignature(c: Pick<Channel, 'kind' | 'startTime' | 'endTime'>): string {
  return `${c.kind}|${c.startTime}|${c.endTime}`
}

/** Confirmation window for a break: how many consecutive closes outside ± eps
 * are needed before we accept the break (and truncate the channel). Filters
 * single-bar wobbles that immediately rejoin the channel. */
export const CONFIRM_BREAK_BARS = 2

/**
 * Time of the FIRST candle in the earliest run of `CONFIRM_BREAK_BARS`
 * consecutive closes outside either rail by more than `eps`, scanning bars
 * strictly after `c.endTime`. Returns null if no such confirmed run exists.
 * The channel is truncated to this first-break time (not the confirmation bar).
 */
export function findChannelBreak(
  c: Channel,
  candles: ReadonlyArray<Candle>,
  eps: number,
): number | null {
  const dt = c.endTime - c.startTime
  if (dt <= 0) return null
  const slopeUpper = (c.upperEnd - c.upperStart) / dt
  const slopeLower = (c.lowerEnd - c.lowerStart) / dt
  let runStart: number | null = null
  let streak = 0
  for (let i = 0; i < candles.length; i++) {
    const t = candles[i].time as number
    if (t <= c.endTime) continue
    const upperY = c.upperEnd + slopeUpper * (t - c.endTime)
    const lowerY = c.lowerEnd + slopeLower * (t - c.endTime)
    const close = candles[i].close
    if (close > upperY + eps || close < lowerY - eps) {
      if (runStart === null) runStart = t
      streak++
      if (streak >= CONFIRM_BREAK_BARS) return runStart
    } else {
      runStart = null
      streak = 0
    }
  }
  return null
}

/**
 * Quantized geometric key for a channel. Two channels that resolve to the
 * same fingerprint are "the same line" detected with different pivot anchors —
 * use this for de-duping at the render boundary so ghost overlays from
 * pivot drift across replay ticks collapse into one rendered channel.
 *   slope bucket: ~0.5 $/hour
 *   y bucket:     eps (same tolerance as touch detection)
 */
export function channelFingerprint(c: Channel, eps: number): string {
  const dt = c.endTime - c.startTime
  if (dt <= 0 || eps <= 0) return `${c.kind}|deg`
  const slope = (c.upperEnd - c.upperStart) / dt
  const slopeBucket = Math.round(slope * 7200) // 1 unit = 0.5 $/hour
  const midT = (c.startTime + c.endTime) / 2
  const midY = c.upperStart + slope * (midT - c.startTime)
  const yBucket = Math.round(midY / eps)
  return `${c.kind}|${slopeBucket}|${yBucket}`
}

/**
 * Extrapolate both rails forward to `t` along the channel's existing slope.
 * No-op if `t` is at-or-before the channel's current end. Call this AFTER
 * `withChannelMeta` so the signature stays anchored to the detection endpoints
 * (otherwise sig would change every replay tick and break per-channel hide rows).
 */
export function extendChannelToTime(c: Channel, t: number): Channel {
  if (t <= c.endTime) return c
  const dt = c.endTime - c.startTime
  if (dt <= 0) return c
  const slope = (c.upperEnd - c.upperStart) / dt
  const ext = t - c.endTime
  return {
    ...c,
    endTime: t,
    upperEnd: c.upperEnd + slope * ext,
    lowerEnd: c.lowerEnd + slope * ext,
  }
}

export function withChannelMeta(channels: ReadonlyArray<Channel>): ChannelMeta[] {
  let resCount = 0
  let supCount = 0
  return channels.map((channel) => {
    const label = channel.kind === 'resistance' ? `R${++resCount}` : `S${++supCount}`
    return { channel, sig: channelSignature(channel), label, status: 'live' }
  })
}

export const TOUCH_PCT = 0.0006 // 0.06% of mid-window price ≈ $2.70 on $4500 gold
// 3 touches commits a channel as soon as a third swing-low pivot confirms — so
// developing channels appear during replay instead of only retroactively after
// the 4th pivot. The density filter below still rejects sparse 3-touch fits
// over wide spans (max span = 3/0.4 = 7.5h), so 3-touch acceptance stays tight.
const MIN_TOUCHES = 3
// Reject channels with too few touches per unit time — a 7-touch channel over
// 19 hours is sparse-stale and clutters the chart on wide windows.
const MIN_TOUCHES_PER_HOUR = 0.4
// Skip the top fraction of extreme bars when picking the derived parallel rail,
// so a single-bar spike doesn't yank the rail far from the price action.
const DERIVED_RAIL_PCT = 0.05

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

    // Density filter: sparse-stale channels (few touches over many hours) are
    // usually coincidence on wide windows. Drop them before drawing.
    const spanHours = (endTime - startTime) / 3600
    if (spanHours > 0 && c.touches / spanHours < MIN_TOUCHES_PER_HOUR) continue

    const firstCandleIdx = swings[c.firstIdx].index
    const lastCandleIdx = swings[c.lastIdx].index

    // Touch-scored rail's y at start/end
    const aT = c.aSwing.time as number
    const touchedStart = c.aSwing.price + c.slope * (startTime - aT)
    const touchedEnd = c.aSwing.price + c.slope * (endTime - aT)

    // Derived parallel rail: anchor at the DERIVED_RAIL_PCT-percentile extreme
    // (not the absolute extreme) so a single-bar spike inside a long channel
    // doesn't yank the rail far from the price action.
    const sliceLen = lastCandleIdx - firstCandleIdx + 1
    const skipCount = Math.min(Math.floor(sliceLen * DERIVED_RAIL_PCT), sliceLen - 1)
    const indices: number[] = []
    for (let k = firstCandleIdx; k <= lastCandleIdx; k++) indices.push(k)
    indices.sort((a, b) =>
      kind === 'resistance'
        ? candles[a].low - candles[b].low // ascending: lowest first
        : candles[b].high - candles[a].high, // descending: highest first
    )
    const extIdx = indices[skipCount]
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
