// Per-entry channel metadata dump. For each PAB-Short entry produced by
// the backtest, record the support channel that triggered it (touches,
// span, slope, anchor times, distance between rails). Lets us compare
// "good" vs "bad" channel signatures and propose quality filters.
//
// Run: npx tsx scripts/analyze-channels.ts

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
  extendChannelToTime,
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
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
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
  const orig = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = orig }
}

// Compute the R² of swing-low pivots vs the touch-anchored lower rail.
// Higher = pivots line up cleanly on the line; lower = noisy fit.
function pivotR2OnLowerRail(
  startTime: number, endTime: number,
  yStart: number, yEnd: number,
  pivots: ReadonlyArray<{ time: number; price: number }>,
  tolerance: number,
): { r2: number; n: number; meanError: number; maxError: number } {
  const dt = endTime - startTime
  if (dt <= 0 || pivots.length === 0) return { r2: 0, n: 0, meanError: 0, maxError: 0 }
  const slope = (yEnd - yStart) / dt
  const intercept = yStart - slope * startTime
  // Filter to pivots within the channel's span that are "touching" within tolerance × N
  // Allow generous tolerance to include all considered touches (3x the strict touch-pct).
  const touching = pivots.filter((p) => {
    if (p.time < startTime || p.time > endTime) return false
    const predicted = slope * p.time + intercept
    return Math.abs(p.price - predicted) <= tolerance * 3
  })
  if (touching.length < 2) return { r2: 0, n: touching.length, meanError: 0, maxError: 0 }
  let ssRes = 0, ssTot = 0, sumErr = 0, maxErr = 0
  const meanPrice = touching.reduce((a, p) => a + p.price, 0) / touching.length
  for (const p of touching) {
    const predicted = slope * p.time + intercept
    const err = Math.abs(p.price - predicted)
    ssRes += err * err
    ssTot += (p.price - meanPrice) * (p.price - meanPrice)
    sumErr += err
    if (err > maxErr) maxErr = err
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0
  return { r2, n: touching.length, meanError: sumErr / touching.length, maxError: maxErr }
}

interface EntryWithChannel {
  label: string
  entryTime: number
  entryPrice: number
  channelLabel: string
  channelKind: 'support'
  channelStartTime: number
  channelEndTime: number
  spanHours: number
  touches: number
  touchesPerHour: number
  slopePerHour: number
  upperStart: number
  upperEnd: number
  lowerStart: number
  lowerEnd: number
  widthAtEntry: number
  closeVsUpperRail: number
  r2Lower: number
  pivotsConsidered: number
  meanPivotErrorPct: number
  maxPivotErrorPct: number
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

  // Map of entry-time → channel meta captured at that moment.
  const channelByEntryTime = new Map<number, ChannelMeta>()
  const algoCandlesByEntryTime = new Map<number, Candle[]>()
  const swingsByEntryTime = new Map<number, ReadonlyArray<{ time: number; price: number }>>()

  silence(() => {
    let lastSignalCount = 0
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
      // If a new entry fired on this playhead, capture the channel it used.
      if (pabState.signals.length > before) {
        for (let i = before; i < pabState.signals.length; i++) {
          const s = pabState.signals[i]
          if (s.side === 'sell' && s.channelLabel) {
            const ch = liveChannels.find((m) => m.label === s.channelLabel)
            if (ch) {
              channelByEntryTime.set(s.time as number, ch)
              algoCandlesByEntryTime.set(s.time as number, algoCandles.slice())
              swingsByEntryTime.set(
                s.time as number,
                swingLows.map((sw) => ({ time: sw.time as number, price: sw.price })),
              )
            }
          }
        }
      }
      lastSignalCount = pabState.signals.length
    }
  })

  // Build per-entry rows.
  const rows: EntryWithChannel[] = []
  let pabLabelCounter = 0
  for (const s of pabState.signals) {
    if (s.side !== 'sell' || !s.channelLabel) continue
    pabLabelCounter += 1
    const tsec = s.time as number
    const meta = channelByEntryTime.get(tsec)
    if (!meta) continue
    const ch = meta.channel
    const spanSec = ch.endTime - ch.startTime
    const spanH = spanSec / 3600
    const slopePerHour = spanH > 0 ? ((ch.upperEnd - ch.upperStart) / spanH) : 0
    // Extend rails to entry time to get width-at-entry.
    const extended = extendChannelToTime(ch, tsec)
    const widthAtEntry = extended.upperEnd - extended.lowerEnd
    const closeVsUpperRail = s.price - extended.upperEnd

    // Compute fit quality on the touch-anchored rail (lower, for support).
    const swings = swingsByEntryTime.get(tsec) ?? []
    const algoCandles = algoCandlesByEntryTime.get(tsec) ?? []
    const mid = algoCandles[Math.floor(algoCandles.length / 2)]?.close ?? s.price
    const eps = mid * TOUCH_PCT
    const fit = pivotR2OnLowerRail(ch.startTime, ch.endTime, ch.lowerStart, ch.lowerEnd, swings, eps)

    rows.push({
      label: `PAB-${pabLabelCounter}`,
      entryTime: tsec,
      entryPrice: s.price,
      channelLabel: meta.label,
      channelKind: 'support',
      channelStartTime: ch.startTime,
      channelEndTime: ch.endTime,
      spanHours: spanH,
      touches: ch.touches,
      touchesPerHour: spanH > 0 ? ch.touches / spanH : 0,
      slopePerHour,
      upperStart: ch.upperStart,
      upperEnd: ch.upperEnd,
      lowerStart: ch.lowerStart,
      lowerEnd: ch.lowerEnd,
      widthAtEntry,
      closeVsUpperRail,
      r2Lower: fit.r2,
      pivotsConsidered: fit.n,
      meanPivotErrorPct: (fit.meanError / mid) * 100,
      maxPivotErrorPct: (fit.maxError / mid) * 100,
    })
  }

  // Report.
  process.stdout.write(
    `Range: ${RANGE_START_CASA} → ${RANGE_END_CASA} CASA · entries: ${rows.length}\n`,
  )
  process.stdout.write('\n')

  // Group by channel label.
  const byChannel = new Map<string, EntryWithChannel[]>()
  for (const r of rows) {
    if (!byChannel.has(r.channelLabel)) byChannel.set(r.channelLabel, [])
    byChannel.get(r.channelLabel)!.push(r)
  }

  // Per-channel summary.
  for (const [label, entries] of byChannel) {
    const first = entries[0]
    const sep = '─'.repeat(78)
    process.stdout.write(sep + '\n')
    process.stdout.write(
      `Channel ${label} (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}) — ${entries.map((e) => e.label).join(', ')}\n`,
    )
    process.stdout.write(sep + '\n')
    process.stdout.write(
      `  Span:        ${formatCrosshair(first.channelStartTime)} → ${formatCrosshair(first.channelEndTime)} CASA  (${first.spanHours.toFixed(2)}h)\n`,
    )
    process.stdout.write(
      `  Touches:     ${first.touches}  ·  density ${first.touchesPerHour.toFixed(2)}/h\n`,
    )
    process.stdout.write(
      `  Slope/h:     ${(first.slopePerHour >= 0 ? '+' : '') + first.slopePerHour.toFixed(2)} $/h  ` +
        `(${first.slopePerHour >= 0 ? 'rising' : 'falling'})\n`,
    )
    process.stdout.write(
      `  Width:       lo-rail ${first.lowerStart.toFixed(2)}→${first.lowerEnd.toFixed(2)}  ` +
        `hi-rail ${first.upperStart.toFixed(2)}→${first.upperEnd.toFixed(2)}  ` +
        `(width@entry ${first.widthAtEntry.toFixed(2)})\n`,
    )
    process.stdout.write(
      `  Pivot fit:   R²=${first.r2Lower.toFixed(3)}  n=${first.pivotsConsidered}  ` +
        `mean err=${first.meanPivotErrorPct.toFixed(3)}%  max err=${first.maxPivotErrorPct.toFixed(3)}%  (on touch-anchored rail)\n`,
    )
    for (const e of entries) {
      process.stdout.write(
        `  ${e.label}  entry ${formatCrosshair(e.entryTime)}  close ${e.entryPrice.toFixed(2)}  ` +
          `close−upperRail ${(e.closeVsUpperRail >= 0 ? '+' : '') + e.closeVsUpperRail.toFixed(2)}\n`,
      )
    }
    process.stdout.write('\n')
  }

  // Compact comparison table.
  process.stdout.write('Compact comparison:\n')
  process.stdout.write(
    'CH    ENTRIES  SPAN(h)  TOUCH  TPH    SLOPE/h  WIDTH    R²      MAX_ERR%\n',
  )
  process.stdout.write('─'.repeat(78) + '\n')
  for (const [label, entries] of byChannel) {
    const c = entries[0]
    process.stdout.write(
      label.padEnd(5) + '  ' +
      entries.length.toString().padStart(7) + '  ' +
      c.spanHours.toFixed(2).padStart(7) + '  ' +
      c.touches.toString().padStart(5) + '  ' +
      c.touchesPerHour.toFixed(2).padStart(5) + '  ' +
      ((c.slopePerHour >= 0 ? '+' : '') + c.slopePerHour.toFixed(2)).padStart(7) + '  ' +
      c.widthAtEntry.toFixed(2).padStart(7) + '  ' +
      c.r2Lower.toFixed(3).padStart(6) + '  ' +
      c.maxPivotErrorPct.toFixed(3).padStart(8) + '\n',
    )
  }
}

main()
