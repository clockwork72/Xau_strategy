// Compare trailing-stop variants on the 11 PAB-Short trades from
// 2026-05-21 → 2026-05-26 15:20. Each variant walks the bars after each
// entry independently and produces its own exit. Aggregates: total $,
// avg R, win/loss/scratch counts, realized max DD.
//
// Run: npx tsx scripts/test-trailing-stops.ts

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
const RANGE_END_CASA = '2026-05-26 15:20'
const TRENDLINE_LOOKBACK = 7
const LOT_SIZE = 0.01
const CONTRACT_SIZE_OZ = 100
const MAX_HOLD_BARS = 96 // 8h on M5 — anything not resolved by then = force-exit
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
  time: string
  open: string
  high: string
  low: string
  close: string
  tick_volume?: string
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
    out.push({
      time: t as UTCTimestamp,
      open, high, low, close,
      tickVolume: r.tick_volume ? +r.tick_volume : 0,
    })
  }
  return out
}

function silence<T>(fn: () => T): T {
  const orig = console.log
  console.log = () => {}
  try {
    return fn()
  } finally {
    console.log = orig
  }
}

interface Entry {
  label: string
  entryIdx: number  // index in `all` for the entry bar
  entryTime: number
  entryPrice: number
  sl: number
  tp: number
  r: number
  channelLabel: string
}

function extractEntries(all: Candle[], fromSec: number, toSec: number): Entry[] {
  const replay = all.filter((c) => {
    const t = c.time as number
    return t >= fromSec && t <= toSec
  })
  let pabState: PABState = PAB_INITIAL_STATE
  // Permanent-freeze rule: once a channel identity has frozen, refinement
  // passes cannot un-freeze it. Mirrors the sandbox's tracking model and
  // prevents "ghost" trades on channels the live app considers dead.
  const frozenIdentities = new Set<string>()
  const labelByIdentity = new Map<string, string>()
  let sLabelCounter = 0
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
      pabState = runPriceActionBeta(algoCandles, liveChannels, emaByTime, pabState)
    }
  })

  // Build entry list from sell-side signals.
  const entries: Entry[] = []
  for (const s of pabState.signals) {
    if (s.side !== 'sell' || s.sl === undefined || s.tp === undefined || s.label === undefined) continue
    const tsec = s.time as number
    const entryIdx = all.findIndex((c) => (c.time as number) === tsec)
    if (entryIdx < 0) continue
    entries.push({
      label: s.label,
      entryIdx,
      entryTime: tsec,
      entryPrice: s.price,
      sl: s.sl,
      tp: s.tp,
      r: Math.abs(s.sl - s.price),
      channelLabel: s.channelLabel ?? '?',
    })
  }
  return entries
}

// ---------------------------------------------------------------------
//   Trailing-stop variants
// ---------------------------------------------------------------------
// Each variant returns a list of (priceClose, fraction) booking events
// across the bars after entry. The final realized R-multiple is the sum
// of (price - exitPrice) / r × fraction over all bookings, weighted by
// the original 1.0 lot. (price = entryPrice for shorts.)

interface BookingEvent {
  time: number
  price: number
  fraction: number
  reason: 'sl' | 'tp' | 'partial-tp' | 'force-time' | 'breakeven'
}

interface SimResult {
  events: BookingEvent[]
  rMultiple: number
  pnlUsd: number
  exitTime: number
  durationMin: number
  finalReason: string
}

interface Variant {
  name: string
  description: string
  simulate: (entry: Entry, futureBars: Candle[]) => SimResult
}

function finalizeR(entry: Entry, events: BookingEvent[]): number {
  // For shorts: R per unit = (entryPrice - exitPrice) / r
  let totalR = 0
  for (const ev of events) {
    const rUnits = (entry.entryPrice - ev.price) / entry.r
    totalR += rUnits * ev.fraction
  }
  return totalR
}

function finalize(entry: Entry, events: BookingEvent[]): Omit<SimResult, 'events'> {
  const rMultiple = finalizeR(entry, events)
  let exitTime = entry.entryTime
  for (const ev of events) if (ev.time > exitTime) exitTime = ev.time
  const finalReason = events.length > 0 ? events[events.length - 1].reason : 'no-exit'
  const pnlUsd = rMultiple * entry.r * CONTRACT_SIZE_OZ * LOT_SIZE
  return {
    rMultiple,
    pnlUsd,
    exitTime,
    durationMin: Math.round((exitTime - entry.entryTime) / 60),
    finalReason,
  }
}

// A: Baseline — fixed SL/TP.
function simBaseline(entry: Entry, future: Candle[]): SimResult {
  const events: BookingEvent[] = []
  for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
    const bar = future[i]
    if (bar.high >= entry.sl) {
      events.push({ time: bar.time as number, price: entry.sl, fraction: 1, reason: 'sl' })
      break
    }
    if (bar.low <= entry.tp) {
      events.push({ time: bar.time as number, price: entry.tp, fraction: 1, reason: 'tp' })
      break
    }
  }
  if (events.length === 0) {
    const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
    events.push({ time: last.time as number, price: last.close, fraction: 1, reason: 'force-time' })
  }
  return { events, ...finalize(entry, events) }
}

// B / C: Move SL to entry (breakeven) once MFE crosses `trigR × r`.
function simBE(trigR: number) {
  return function (entry: Entry, future: Candle[]): SimResult {
    const events: BookingEvent[] = []
    let sl = entry.sl
    const beTrig = entry.entryPrice - trigR * entry.r // for short: low must reach this
    let beActive = false
    for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
      const bar = future[i]
      if (bar.high >= sl) {
        events.push({ time: bar.time as number, price: sl, fraction: 1, reason: beActive ? 'breakeven' : 'sl' })
        break
      }
      if (bar.low <= entry.tp) {
        events.push({ time: bar.time as number, price: entry.tp, fraction: 1, reason: 'tp' })
        break
      }
      if (!beActive && bar.low <= beTrig) {
        beActive = true
        sl = entry.entryPrice
      }
    }
    if (events.length === 0) {
      const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
      events.push({ time: last.time as number, price: last.close, fraction: 1, reason: 'force-time' })
    }
    return { events, ...finalize(entry, events) }
  }
}

// D: Lock +lockR profit once MFE crosses trigR.
function simLock(trigR: number, lockR: number) {
  return function (entry: Entry, future: Candle[]): SimResult {
    const events: BookingEvent[] = []
    let sl = entry.sl
    const lockTrigPrice = entry.entryPrice - trigR * entry.r
    const lockSL = entry.entryPrice - lockR * entry.r
    let locked = false
    for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
      const bar = future[i]
      if (bar.high >= sl) {
        events.push({ time: bar.time as number, price: sl, fraction: 1, reason: locked ? 'breakeven' : 'sl' })
        break
      }
      if (bar.low <= entry.tp) {
        events.push({ time: bar.time as number, price: entry.tp, fraction: 1, reason: 'tp' })
        break
      }
      if (!locked && bar.low <= lockTrigPrice) {
        locked = true
        sl = lockSL
      }
    }
    if (events.length === 0) {
      const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
      events.push({ time: last.time as number, price: last.close, fraction: 1, reason: 'force-time' })
    }
    return { events, ...finalize(entry, events) }
  }
}

// E: Partial close 50% at +partialR, breakeven on remainder.
// Same-bar order: SL → partial (partial price is closer to entry than TP) → TP.
function simPartialBE(partialR: number, partialFrac: number) {
  return function (entry: Entry, future: Candle[]): SimResult {
    const events: BookingEvent[] = []
    let sl = entry.sl
    let remainingFrac = 1
    const partialTrigPrice = entry.entryPrice - partialR * entry.r
    let partialed = false
    for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
      const bar = future[i]
      if (bar.high >= sl) {
        events.push({ time: bar.time as number, price: sl, fraction: remainingFrac, reason: partialed ? 'breakeven' : 'sl' })
        remainingFrac = 0
        break
      }
      if (!partialed && bar.low <= partialTrigPrice) {
        events.push({ time: bar.time as number, price: partialTrigPrice, fraction: partialFrac, reason: 'partial-tp' })
        remainingFrac -= partialFrac
        partialed = true
        sl = entry.entryPrice
      }
      if (bar.low <= entry.tp) {
        events.push({ time: bar.time as number, price: entry.tp, fraction: remainingFrac, reason: 'tp' })
        remainingFrac = 0
        break
      }
    }
    if (remainingFrac > 0) {
      const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
      events.push({ time: last.time as number, price: last.close, fraction: remainingFrac, reason: 'force-time' })
    }
    return { events, ...finalize(entry, events) }
  }
}

// F: Trail SL to (max high of last N closed bars + buffer) once MFE ≥ 1R.
function simBarTrail(activateR: number, lookback: number, bufferPct: number) {
  return function (entry: Entry, future: Candle[]): SimResult {
    const events: BookingEvent[] = []
    let sl = entry.sl
    let active = false
    const trigPrice = entry.entryPrice - activateR * entry.r
    const buffer = entry.entryPrice * bufferPct
    const closedHighs: number[] = []
    for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
      const bar = future[i]
      if (bar.high >= sl) {
        events.push({ time: bar.time as number, price: sl, fraction: 1, reason: active ? 'breakeven' : 'sl' })
        break
      }
      if (bar.low <= entry.tp) {
        events.push({ time: bar.time as number, price: entry.tp, fraction: 1, reason: 'tp' })
        break
      }
      // Activation
      if (!active && bar.low <= trigPrice) {
        active = true
        sl = entry.entryPrice // step 1: snap to BE
      }
      // After activation, ratchet using last N closed highs
      closedHighs.push(bar.high)
      if (closedHighs.length > lookback) closedHighs.shift()
      if (active && closedHighs.length === lookback) {
        const maxH = Math.max(...closedHighs)
        const candidate = maxH + buffer
        if (candidate < sl) sl = candidate
      }
    }
    if (events.length === 0) {
      const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
      events.push({ time: last.time as number, price: last.close, fraction: 1, reason: 'force-time' })
    }
    return { events, ...finalize(entry, events) }
  }
}

// G: Hybrid — partial 50% at 1.5R, lock +1R on remainder at 2.5R.
function simHybrid() {
  return function (entry: Entry, future: Candle[]): SimResult {
    const events: BookingEvent[] = []
    let sl = entry.sl
    let remainingFrac = 1
    const partialTrigPrice = entry.entryPrice - 1.5 * entry.r
    const lockTrigPrice = entry.entryPrice - 2.5 * entry.r
    const lockSL = entry.entryPrice - 1 * entry.r
    let partialed = false
    let locked = false
    for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
      const bar = future[i]
      if (bar.high >= sl) {
        const reason: BookingEvent['reason'] = partialed || locked ? 'breakeven' : 'sl'
        events.push({ time: bar.time as number, price: sl, fraction: remainingFrac, reason })
        remainingFrac = 0
        break
      }
      // Same-bar order: partial fills before TP (partial price is closer to
      // entry, so price crosses it first as it falls). Lock updates next.
      if (!partialed && bar.low <= partialTrigPrice) {
        events.push({ time: bar.time as number, price: partialTrigPrice, fraction: 0.5, reason: 'partial-tp' })
        remainingFrac -= 0.5
        partialed = true
        sl = entry.entryPrice
      }
      if (partialed && !locked && bar.low <= lockTrigPrice) {
        locked = true
        sl = lockSL
      }
      if (bar.low <= entry.tp) {
        events.push({ time: bar.time as number, price: entry.tp, fraction: remainingFrac, reason: 'tp' })
        remainingFrac = 0
        break
      }
    }
    if (remainingFrac > 0) {
      const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
      events.push({ time: last.time as number, price: last.close, fraction: remainingFrac, reason: 'force-time' })
    }
    return { events, ...finalize(entry, events) }
  }
}

const VARIANTS: Variant[] = [
  { name: 'A · Baseline', description: 'Fixed SL/TP (current behavior)', simulate: simBaseline },
  { name: 'B · BE @ 1R', description: 'Move SL to entry once MFE ≥ 1R', simulate: simBE(1) },
  { name: 'C · BE @ 1.5R', description: 'Move SL to entry once MFE ≥ 1.5R', simulate: simBE(1.5) },
  { name: 'D · Lock 1R @ 2R', description: 'At +2R MFE, lock SL = entry−1R', simulate: simLock(2, 1) },
  { name: 'E · Partial 50% @ 1.5R + BE', description: 'Close 50% at +1.5R, breakeven on rest', simulate: simPartialBE(1.5, 0.5) },
  { name: 'F · BarTrail3 from 1R', description: 'After 1R, SL = highHigh(3) + buffer; only ratchets', simulate: simBarTrail(1, 3, 0.0002) },
  { name: 'G · Hybrid (50%@1.5R + Lock 1R@2.5R)', description: '50% off at 1.5R; lock +1R on rest at 2.5R', simulate: simHybrid() },
]

function main() {
  const fromSec = parseCasaLocalToUtcSec(RANGE_START_CASA)!
  const toSec = parseCasaLocalToUtcSec(RANGE_END_CASA)!
  const all = loadCsv('public/data/xauusd_m5.csv')
  const entries = extractEntries(all, fromSec, toSec)

  process.stdout.write(`Entries: ${entries.length} (PAB-Short, M5, ${RANGE_START_CASA} → ${RANGE_END_CASA} CASA)\n`)
  process.stdout.write(`Sim horizon: ${MAX_HOLD_BARS} bars (${MAX_HOLD_BARS * 5} min) max per trade · lot=${LOT_SIZE}\n\n`)

  // Run each variant.
  interface VariantRow {
    name: string
    description: string
    perTrade: { label: string; r: number; usd: number; reason: string; durMin: number }[]
    totalR: number
    totalUsd: number
    wins: number
    losses: number
    scratches: number
    maxDD: number
    expectancyR: number
  }
  const rows: VariantRow[] = []
  for (const v of VARIANTS) {
    const perTrade: VariantRow['perTrade'] = []
    let totalR = 0
    let totalUsd = 0
    let wins = 0, losses = 0, scratches = 0
    let peak = 0, running = 0, maxDD = 0
    for (const entry of entries) {
      const future = all.slice(entry.entryIdx + 1)
      const res = v.simulate(entry, future)
      perTrade.push({ label: entry.label, r: res.rMultiple, usd: res.pnlUsd, reason: res.finalReason, durMin: res.durationMin })
      totalR += res.rMultiple
      totalUsd += res.pnlUsd
      if (res.rMultiple > 0.05) wins++
      else if (res.rMultiple < -0.05) losses++
      else scratches++
      running += res.pnlUsd
      if (running > peak) peak = running
      const dd = peak - running
      if (dd > maxDD) maxDD = dd
    }
    rows.push({
      name: v.name,
      description: v.description,
      perTrade,
      totalR,
      totalUsd,
      wins, losses, scratches,
      maxDD,
      expectancyR: totalR / entries.length,
    })
  }

  // ----- Per-trade comparison table -----
  process.stdout.write('Per-trade R-multiples by variant:\n')
  const trHeader = ['TRADE'.padEnd(8), ...VARIANTS.map((v) => v.name.split(' · ')[0].padStart(6))].join('  ')
  process.stdout.write(trHeader + '\n')
  process.stdout.write('-'.repeat(trHeader.length) + '\n')
  for (let i = 0; i < entries.length; i++) {
    const cells = [entries[i].label.padEnd(8)]
    for (const r of rows) {
      const pt = r.perTrade[i]
      const sign = pt.r >= 0 ? '+' : ''
      cells.push((sign + pt.r.toFixed(2)).padStart(6))
    }
    process.stdout.write(cells.join('  ') + '\n')
  }
  process.stdout.write('-'.repeat(trHeader.length) + '\n')
  const sumRow = ['SUM R'.padEnd(8), ...rows.map((r) => ((r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(2)).padStart(6))].join('  ')
  process.stdout.write(sumRow + '\n')
  const usdRow = ['SUM $'.padEnd(8), ...rows.map((r) => ((r.totalUsd >= 0 ? '+' : '−') + '$' + Math.abs(r.totalUsd).toFixed(2)).padStart(6))].join('  ')
  process.stdout.write(usdRow + '\n')
  process.stdout.write('\n')

  // ----- Aggregate metrics -----
  process.stdout.write('Aggregate metrics:\n')
  process.stdout.write(
    'VARIANT'.padEnd(36) + '  ' +
    'W/L/S'.padStart(8) + '  ' +
    'Exp/trade'.padStart(10) + '  ' +
    'Tot R'.padStart(7) + '  ' +
    'Tot $'.padStart(9) + '  ' +
    'Max DD'.padStart(8) + '  ' +
    'Profit / DD'.padStart(11) + '\n'
  )
  process.stdout.write('-'.repeat(102) + '\n')
  for (const r of rows) {
    const wls = `${r.wins}/${r.losses}/${r.scratches}`
    const profDD = r.maxDD > 0 ? (r.totalUsd / r.maxDD).toFixed(2) : '∞'
    process.stdout.write(
      r.name.padEnd(36) + '  ' +
      wls.padStart(8) + '  ' +
      ((r.expectancyR >= 0 ? '+' : '') + r.expectancyR.toFixed(2) + 'R').padStart(10) + '  ' +
      ((r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1) + 'R').padStart(7) + '  ' +
      ((r.totalUsd >= 0 ? '+' : '−') + '$' + Math.abs(r.totalUsd).toFixed(2)).padStart(9) + '  ' +
      ('−$' + r.maxDD.toFixed(2)).padStart(8) + '  ' +
      profDD.padStart(11) + '\n'
    )
  }
  process.stdout.write('\n')

  // ----- Descriptions -----
  for (const v of VARIANTS) {
    process.stdout.write(`  ${v.name}  ·  ${v.description}\n`)
  }
}

main()
