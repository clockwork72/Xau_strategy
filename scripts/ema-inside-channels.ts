// For each support channel that fired entries in the range, sample EMA21
// at every bar from channel.startTime → channel.endTime and report where
// EMA21 sits relative to the rails (upper, lower, midline). Helps assess
// channel quality from EMA-alignment / mean-reversion angle.
//
// Run: npx tsx scripts/ema-inside-channels.ts

import { readFileSync } from 'fs'
import Papa from 'papaparse'
import type { UTCTimestamp } from 'lightweight-charts'

import {
  parseCasaLocalToUtcSec,
  casaSessionStartAtOrBefore,
  formatCrosshair,
} from '../src/util/time'
import { computeEma } from '../src/engine/indicators'
import { findSwingLows } from '../src/engine/swings'
import {
  pickChannels,
  findChannelBreak,
  channelSignature,
  TOUCH_PCT,
  type ChannelMeta,
} from '../src/engine/trendlines'
import {
  runPriceActionBeta,
  PAB_INITIAL_STATE,
  type PABState,
} from '../src/engine/priceActionBeta'
import type { Candle } from '../src/types'

const RANGE_START_CASA = '2026-05-21 00:00'
const RANGE_END_CASA = '2026-05-26 15:00'
const TRENDLINE_LOOKBACK = 7
const OANDA_MT5_TZ_OFFSET_SEC = -10800

const NY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  hour12: false,
})

function isBrokerClosed(timeSec: number): boolean {
  const parts = NY_FMT.formatToParts(new Date(timeSec * 1000))
  const dow = parts.find((p) => p.type === 'weekday')?.value ?? ''
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0')
  if (hour === 17) return true
  if (dow === 'Fri' && hour > 17) return true
  if (dow === 'Sat') return true
  if (dow === 'Sun' && hour < 17) return true
  return false
}

interface CsvRow {
  time: string; open: string; high: string; low: string; close: string; tick_volume?: string
}

function loadCsv(path: string): Candle[] {
  const text = readFileSync(path, 'utf-8')
  const res = Papa.parse<CsvRow>(text, { header: true, skipEmptyLines: true })
  const out: Candle[] = []
  for (const r of res.data) {
    const open = +r.open, high = +r.high, low = +r.low, close = +r.close
    if (!Number.isFinite(open + high + low + close)) continue
    const iso = r.time.includes('T') ? r.time : r.time.replace(' ', 'T')
    const t = Math.floor(new Date(iso).getTime() / 1000) + OANDA_MT5_TZ_OFFSET_SEC
    if (isBrokerClosed(t)) continue
    out.push({ time: t as UTCTimestamp, open, high, low, close, tickVolume: r.tick_volume ? +r.tick_volume : 0 })
  }
  return out
}

function silence<T>(fn: () => T): T {
  const orig = console.log; console.log = () => {}
  try { return fn() } finally { console.log = orig }
}

function main() {
  const fromSec = parseCasaLocalToUtcSec(RANGE_START_CASA)!
  const toSec = parseCasaLocalToUtcSec(RANGE_END_CASA)!
  const all = loadCsv('public/data/xauusd_m5.csv')
  const replay = all.filter((c) => {
    const t = c.time as number
    return t >= fromSec && t <= toSec
  })

  let pabState: PABState = PAB_INITIAL_STATE
  const frozenIdentities = new Set<string>()
  const labelByIdentity = new Map<string, string>()
  let sLabelCounter = 0

  // Capture each channel that was used by an entry signal.
  const channelByEntryTime = new Map<number, ChannelMeta>()

  silence(() => {
    for (const playheadBar of replay) {
      const playheadTime = playheadBar.time as number
      const lo = casaSessionStartAtOrBefore(playheadTime)
      const algoCandles: Candle[] = []
      for (const c of all) {
        const t = c.time as number
        if (t < lo) continue
        if (t > playheadTime) break
        algoCandles.push(c)
      }
      if (algoCandles.length === 0) continue
      const swingLows = findSwingLows(algoCandles, TRENDLINE_LOOKBACK)
      const rawChannels = pickChannels(swingLows, algoCandles, 'support')
      const mid = algoCandles[Math.floor(algoCandles.length / 2)].close
      const eps = mid * TOUCH_PCT
      const seen = new Set<string>()
      const liveChannels: ChannelMeta[] = []
      for (const ch of rawChannels) {
        const identity = `${ch.kind}|${ch.startTime}`
        if (seen.has(identity)) continue
        seen.add(identity)
        if (frozenIdentities.has(identity)) continue
        if (findChannelBreak(ch, algoCandles, eps) !== null) {
          frozenIdentities.add(identity)
          continue
        }
        let label = labelByIdentity.get(identity)
        if (!label) {
          sLabelCounter += 1
          label = `S${sLabelCounter}`
          labelByIdentity.set(identity, label)
        }
        liveChannels.push({ channel: ch, sig: channelSignature(ch), label, status: 'live' })
      }
      const emaByTime = new Map<number, number>()
      for (const p of computeEma(algoCandles, 21)) emaByTime.set(p.time, p.value)

      const before = pabState.signals.length
      pabState = runPriceActionBeta(algoCandles, liveChannels, emaByTime, pabState)
      if (pabState.signals.length > before) {
        for (let i = before; i < pabState.signals.length; i++) {
          const s = pabState.signals[i]
          if (s.side === 'sell' && s.channelLabel) {
            const ch = liveChannels.find((m) => m.label === s.channelLabel)
            if (ch) channelByEntryTime.set(s.time as number, ch)
          }
        }
      }
    }
  })

  // Dedupe channels (multiple entries on the same channel).
  const uniqueChannels = new Map<string, ChannelMeta>()
  for (const m of channelByEntryTime.values()) {
    if (!uniqueChannels.has(m.label)) uniqueChannels.set(m.label, m)
  }

  // For each unique channel, walk its lifespan and sample EMA21 / rails.
  type Row = {
    time: number; close: number; ema: number;
    upper: number; lower: number; mid: number;
    pos: number; // (ema-lower)/(upper-lower) — 0=at lower, 1=at upper
    inside: boolean;
  }
  for (const [label, meta] of uniqueChannels) {
    const ch = meta.channel
    const sessionStart = casaSessionStartAtOrBefore(ch.startTime)

    // Re-build algoCandles for THIS channel's session (full slice up to channel.endTime).
    // Note: in practice the strategy at runtime sees EMA up to the current playhead;
    // here we compute EMA across the full session so we can sample its value at every
    // bar within the channel's lifespan. The result at any bar T equals what the
    // strategy would have seen with playhead=T (EMA only depends on past bars).
    const sessionCandles: Candle[] = []
    for (const c of all) {
      const t = c.time as number
      if (t < sessionStart) continue
      if (t > ch.endTime + 5 * 60) break // a tad past for completeness
      sessionCandles.push(c)
    }
    const emaPoints = computeEma(sessionCandles, 21)
    const emaByT = new Map<number, number>()
    for (const p of emaPoints) emaByT.set(p.time, p.value)

    const dt = ch.endTime - ch.startTime
    const slopeUpper = (ch.upperEnd - ch.upperStart) / dt
    const slopeLower = (ch.lowerEnd - ch.lowerStart) / dt
    const railsAt = (t: number) => {
      const u = ch.upperStart + slopeUpper * (t - ch.startTime)
      const l = ch.lowerStart + slopeLower * (t - ch.startTime)
      return { upper: u, lower: l, mid: (u + l) / 2 }
    }

    // Sample bars within [channel.startTime, channel.endTime].
    const rows: Row[] = []
    for (const c of sessionCandles) {
      const t = c.time as number
      if (t < ch.startTime || t > ch.endTime) continue
      const ema = emaByT.get(t)
      if (ema === undefined) continue
      const r = railsAt(t)
      const width = r.upper - r.lower
      const pos = width > 0 ? (ema - r.lower) / width : 0.5
      const inside = pos >= 0 && pos <= 1
      rows.push({
        time: t, close: c.close, ema,
        upper: r.upper, lower: r.lower, mid: r.mid,
        pos, inside,
      })
    }
    if (rows.length === 0) continue

    // Aggregate stats.
    const insideCount = rows.filter((r) => r.inside).length
    const aboveCount = rows.filter((r) => r.pos > 1).length
    const belowCount = rows.filter((r) => r.pos < 0).length
    const meanPos = rows.reduce((a, r) => a + r.pos, 0) / rows.length
    // EMA slope over the channel's lifespan (best linear fit).
    const firstEma = rows[0].ema, lastEma = rows[rows.length - 1].ema
    const emaSlopePerH = ((lastEma - firstEma) / dt) * 3600
    const railSlopePerH = (slopeUpper) * 3600

    const sep = '─'.repeat(78)
    process.stdout.write(sep + '\n')
    process.stdout.write(`Channel ${label}\n`)
    process.stdout.write(sep + '\n')
    process.stdout.write(
      `  Span:           ${formatCrosshair(ch.startTime)} → ${formatCrosshair(ch.endTime)} CASA  (${(dt / 3600).toFixed(2)}h)\n`,
    )
    process.stdout.write(
      `  Rails:          upper ${ch.upperStart.toFixed(2)}→${ch.upperEnd.toFixed(2)}  ` +
        `lower ${ch.lowerStart.toFixed(2)}→${ch.lowerEnd.toFixed(2)}  ` +
        `(width ${(ch.upperEnd - ch.lowerEnd).toFixed(2)})\n`,
    )
    process.stdout.write(
      `  Rail slope/h:   ${railSlopePerH >= 0 ? '+' : ''}${railSlopePerH.toFixed(2)} $/h\n`,
    )
    process.stdout.write(
      `  EMA21 slope/h:  ${emaSlopePerH >= 0 ? '+' : ''}${emaSlopePerH.toFixed(2)} $/h  ` +
        `(${Math.sign(emaSlopePerH) === Math.sign(railSlopePerH) ? 'aligned' : 'DIVERGENT'})\n`,
    )
    process.stdout.write('\n')
    process.stdout.write(
      `  Bars sampled:   ${rows.length}  ·  inside: ${insideCount} (${((insideCount / rows.length) * 100).toFixed(0)}%)  ` +
        `above-upper: ${aboveCount} (${((aboveCount / rows.length) * 100).toFixed(0)}%)  ` +
        `below-lower: ${belowCount} (${((belowCount / rows.length) * 100).toFixed(0)}%)\n`,
    )
    process.stdout.write(
      `  Mean EMA pos:   ${(meanPos * 100).toFixed(0)}% of width  (0=lower rail, 100=upper rail)\n`,
    )

    // Show 6 evenly-spaced samples across the lifespan.
    process.stdout.write('\n  Samples across lifespan:\n')
    process.stdout.write(
      '  ' + 'TIME (CASA)'.padEnd(17) +
      '  ' + 'CLOSE'.padStart(8) +
      '  ' + 'EMA21'.padStart(8) +
      '  ' + 'LOWER'.padStart(8) +
      '  ' + 'UPPER'.padStart(8) +
      '  ' + 'POS%'.padStart(5) +
      '  status\n',
    )
    const sampleCount = Math.min(rows.length, 8)
    for (let i = 0; i < sampleCount; i++) {
      const r = rows[Math.floor((i * (rows.length - 1)) / Math.max(1, sampleCount - 1))]
      const status = r.inside ? 'inside' : r.pos > 1 ? 'ABOVE channel' : 'BELOW channel'
      process.stdout.write(
        '  ' + formatCrosshair(r.time).padEnd(17) +
        '  ' + r.close.toFixed(2).padStart(8) +
        '  ' + r.ema.toFixed(2).padStart(8) +
        '  ' + r.lower.toFixed(2).padStart(8) +
        '  ' + r.upper.toFixed(2).padStart(8) +
        '  ' + (r.pos * 100).toFixed(0).padStart(4) + '%' +
        '  ' + status + '\n',
      )
    }
    process.stdout.write('\n')
  }

  // Compact comparison.
  process.stdout.write('\nCompact comparison:\n')
  process.stdout.write(
    'CH    SPAN(h)  RAIL/h   EMA/h     ALIGN     INSIDE%  ABOVE%  BELOW%  MEAN_POS%\n',
  )
  process.stdout.write('─'.repeat(78) + '\n')
  // Recompute summary rows in label order.
  for (const [label, meta] of uniqueChannels) {
    const ch = meta.channel
    const sessionStart = casaSessionStartAtOrBefore(ch.startTime)
    const sessionCandles: Candle[] = []
    for (const c of all) {
      const t = c.time as number
      if (t < sessionStart) continue
      if (t > ch.endTime + 5 * 60) break
      sessionCandles.push(c)
    }
    const emaPoints = computeEma(sessionCandles, 21)
    const emaByT = new Map<number, number>()
    for (const p of emaPoints) emaByT.set(p.time, p.value)
    const dt = ch.endTime - ch.startTime
    const slopeUpper = (ch.upperEnd - ch.upperStart) / dt
    const slopeLower = (ch.lowerEnd - ch.lowerStart) / dt
    const railsAt = (t: number) => ({
      upper: ch.upperStart + slopeUpper * (t - ch.startTime),
      lower: ch.lowerStart + slopeLower * (t - ch.startTime),
    })
    const rows: { pos: number; inside: boolean; ema: number; t: number }[] = []
    for (const c of sessionCandles) {
      const t = c.time as number
      if (t < ch.startTime || t > ch.endTime) continue
      const ema = emaByT.get(t)
      if (ema === undefined) continue
      const r = railsAt(t)
      const width = r.upper - r.lower
      const pos = width > 0 ? (ema - r.lower) / width : 0.5
      rows.push({ pos, inside: pos >= 0 && pos <= 1, ema, t })
    }
    if (rows.length === 0) continue
    const insidePct = (rows.filter((r) => r.inside).length / rows.length) * 100
    const abovePct = (rows.filter((r) => r.pos > 1).length / rows.length) * 100
    const belowPct = (rows.filter((r) => r.pos < 0).length / rows.length) * 100
    const meanPos = (rows.reduce((a, r) => a + r.pos, 0) / rows.length) * 100
    const railH = (slopeUpper) * 3600
    const emaH = ((rows[rows.length - 1].ema - rows[0].ema) / (rows[rows.length - 1].t - rows[0].t)) * 3600
    const align = Math.sign(emaH) === Math.sign(railH) ? 'aligned' : 'DIVERGENT'
    process.stdout.write(
      label.padEnd(5) + '  ' +
      (dt / 3600).toFixed(2).padStart(7) + '  ' +
      ((railH >= 0 ? '+' : '') + railH.toFixed(2)).padStart(6) + '  ' +
      ((emaH >= 0 ? '+' : '') + emaH.toFixed(2)).padStart(7) + '  ' +
      align.padStart(9) + '  ' +
      insidePct.toFixed(0).padStart(6) + '%  ' +
      abovePct.toFixed(0).padStart(5) + '%  ' +
      belowPct.toFixed(0).padStart(5) + '%  ' +
      meanPos.toFixed(0).padStart(8) + '%\n',
    )
  }
}

main()
