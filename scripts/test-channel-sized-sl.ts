// Test: replace wick-based SL with channel-rail-based SL.
//   Current logic:  SL = entry_candle.high + buffer
//   Proposed:       SL = channel.upper_rail(entry_time) + buffer
// TP stays at 1:3 RR. Entries unchanged (same EMA + rejection rules).
//
// Compares three modes over the same entry set:
//   A · wick + BE@1R  (current production)
//   B · channel + no BE
//   C · channel + BE@1R
//
// Run: npx tsx scripts/test-channel-sized-sl.ts

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
  emaOutsideRailsFrac,
  EMA_OUTSIDE_MAX_FRAC,
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

const RANGE_START_CASA = '2026-05-20 00:00'
const RANGE_END_CASA = '2026-05-26 15:00'
const TRENDLINE_LOOKBACK = 7
const RR = 3
const STOP_BUFFER_PCT = 0.0002
const BE_TRIGGER_R = 1
const LOT_SIZE = 0.01
const CONTRACT_SIZE_OZ = 100
const MAX_HOLD_BARS = 96
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
  const orig = console.log; console.log = () => {}
  try { return fn() } finally { console.log = orig }
}

interface Entry {
  label: string
  entryIdx: number
  entryTime: number
  entryClose: number
  entryHigh: number
  midPriceAtEntry: number
  upperRailAtEntry: number
  lowerRailAtEntry: number
  channelLabel: string
}

function extractEntries(all: Candle[], fromSec: number, toSec: number): Entry[] {
  const replay = all.filter((c) => {
    const t = c.time as number
    return t >= fromSec && t <= toSec
  })
  let pabState: PABState = PAB_INITIAL_STATE
  const frozenIdentities = new Set<string>()
  const labelByIdentity = new Map<string, string>()
  let sLabelCounter = 0
  const captured: Entry[] = []

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
      const emaByTime = new Map<number, number>()
      for (const p of computeEma(algoCandles, 21)) emaByTime.set(p.time, p.value)
      const seen = new Set<string>()
      const liveChannels: ChannelMeta[] = []
      for (const ch of rawChannels) {
        const identity = `${ch.kind}|${ch.startTime}`
        if (seen.has(identity)) continue
        seen.add(identity)
        if (frozenIdentities.has(identity)) continue
        const outsideFrac = emaOutsideRailsFrac(ch, algoCandles, emaByTime)
        if (!Number.isNaN(outsideFrac) && outsideFrac > EMA_OUTSIDE_MAX_FRAC) continue
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

      const before = pabState.signals.length
      pabState = runPriceActionBeta(algoCandles, liveChannels, emaByTime, pabState)
      if (pabState.signals.length > before) {
        for (let i = before; i < pabState.signals.length; i++) {
          const s = pabState.signals[i]
          if (s.side !== 'sell' || !s.channelLabel) continue
          const ch = liveChannels.find((m) => m.label === s.channelLabel)
          if (!ch) continue
          const tsec = s.time as number
          const entryIdx = all.findIndex((c) => (c.time as number) === tsec)
          if (entryIdx < 0) continue
          const entryBar = all[entryIdx]
          const extended = extendChannelToTime(ch.channel, tsec)
          captured.push({
            label: `PAB-${captured.length + 1}`,
            entryIdx,
            entryTime: tsec,
            entryClose: entryBar.close,
            entryHigh: entryBar.high,
            midPriceAtEntry: mid,
            upperRailAtEntry: extended.upperEnd,
            lowerRailAtEntry: extended.lowerEnd,
            channelLabel: ch.label,
          })
        }
      }
    }
  })
  return captured
}

// ---------------------------------------------------------------------
//   Trade simulator with three modes
// ---------------------------------------------------------------------
type Mode = 'wick+BE' | 'channel-noBE' | 'channel+BE' | 'frac-noBE' | 'frac+BE'

interface SimOut {
  exitTime: number
  exitPrice: number
  reason: 'sl' | 'tp' | 'breakeven' | 'force-time'
  rMultiple: number
  pnlUsd: number
  durationMin: number
  beArmed: boolean
  initialR: number
  initialTP: number
  initialSL: number
}

function simulate(entry: Entry, future: Candle[], mode: Mode): SimOut {
  const buffer = entry.midPriceAtEntry * STOP_BUFFER_PCT
  const channelHeight = entry.upperRailAtEntry - entry.lowerRailAtEntry
  let sl0: number
  let tp: number
  if (mode === 'wick+BE') {
    sl0 = entry.entryHigh + buffer
    tp = entry.entryClose - RR * (sl0 - entry.entryClose)
  } else if (mode === 'channel-noBE' || mode === 'channel+BE') {
    sl0 = entry.upperRailAtEntry + buffer
    tp = entry.entryClose - RR * (sl0 - entry.entryClose)
  } else {
    // Fraction-of-height: R = H/4, TP_dist = 3H/4 (1:3 RR baked in).
    sl0 = entry.entryClose + channelHeight / 4
    tp = entry.entryClose - (3 * channelHeight) / 4
  }
  const initialR = sl0 - entry.entryClose
  const useBE = mode === 'wick+BE' || mode === 'channel+BE' || mode === 'frac+BE'
  let sl = sl0
  let beArmed = false
  const beTrigPrice = entry.entryClose - BE_TRIGGER_R * initialR
  for (let i = 0; i < future.length && i < MAX_HOLD_BARS; i++) {
    const bar = future[i]
    if (bar.high >= sl) {
      const reason: SimOut['reason'] = beArmed ? 'breakeven' : 'sl'
      const rMult = (entry.entryClose - sl) / initialR
      const pnl = (entry.entryClose - sl) * CONTRACT_SIZE_OZ * LOT_SIZE
      return {
        exitTime: bar.time as number, exitPrice: sl, reason, rMultiple: rMult, pnlUsd: pnl,
        durationMin: Math.round(((bar.time as number) - entry.entryTime) / 60),
        beArmed, initialR, initialTP: tp, initialSL: sl0,
      }
    }
    if (bar.low <= tp) {
      const rMult = (entry.entryClose - tp) / initialR
      const pnl = (entry.entryClose - tp) * CONTRACT_SIZE_OZ * LOT_SIZE
      return {
        exitTime: bar.time as number, exitPrice: tp, reason: 'tp', rMultiple: rMult, pnlUsd: pnl,
        durationMin: Math.round(((bar.time as number) - entry.entryTime) / 60),
        beArmed, initialR, initialTP: tp, initialSL: sl0,
      }
    }
    if (useBE && !beArmed && bar.low <= beTrigPrice) {
      beArmed = true
      sl = entry.entryClose
    }
  }
  // Force-time exit at MAX_HOLD_BARS.
  const last = future[Math.min(future.length - 1, MAX_HOLD_BARS - 1)]
  return {
    exitTime: last.time as number, exitPrice: last.close, reason: 'force-time',
    rMultiple: (entry.entryClose - last.close) / initialR,
    pnlUsd: (entry.entryClose - last.close) * CONTRACT_SIZE_OZ * LOT_SIZE,
    durationMin: Math.round(((last.time as number) - entry.entryTime) / 60),
    beArmed, initialR, initialTP: tp, initialSL: sl0,
  }
}

function main() {
  const fromSec = parseCasaLocalToUtcSec(RANGE_START_CASA)!
  const toSec = parseCasaLocalToUtcSec(RANGE_END_CASA)!
  const all = loadCsv('public/data/xauusd_m5.csv')
  const entries = extractEntries(all, fromSec, toSec)
  process.stdout.write(
    `Entries: ${entries.length} (M5, ${RANGE_START_CASA} → ${RANGE_END_CASA} CASA, EMA filter ON)\n\n`,
  )

  // R + TP per entry across all three anchoring schemes.
  process.stdout.write('R + TP per entry (three anchoring schemes):\n')
  process.stdout.write(
    'TRADE'.padEnd(7) + '  ' +
    'CH'.padEnd(4) + '  ' +
    'ENTRY'.padStart(8) + '  ' +
    'HEIGHT'.padStart(7) + '  ' +
    'R(wick)'.padStart(8) + '  ' +
    'R(chan)'.padStart(8) + '  ' +
    'R(frac)'.padStart(8) + '  ' +
    'TP(wick)'.padStart(9) + '  ' +
    'TP(chan)'.padStart(9) + '  ' +
    'TP(frac)'.padStart(9) + '\n',
  )
  process.stdout.write('─'.repeat(106) + '\n')
  for (const e of entries) {
    const buffer = e.midPriceAtEntry * STOP_BUFFER_PCT
    const H = e.upperRailAtEntry - e.lowerRailAtEntry
    const rW = (e.entryHigh + buffer) - e.entryClose
    const rC = (e.upperRailAtEntry + buffer) - e.entryClose
    const rF = H / 4
    const tpW = e.entryClose - RR * rW
    const tpC = e.entryClose - RR * rC
    const tpF = e.entryClose - (3 * H) / 4
    process.stdout.write(
      e.label.padEnd(7) + '  ' +
      e.channelLabel.padEnd(4) + '  ' +
      e.entryClose.toFixed(2).padStart(8) + '  ' +
      H.toFixed(2).padStart(7) + '  ' +
      rW.toFixed(2).padStart(8) + '  ' +
      rC.toFixed(2).padStart(8) + '  ' +
      rF.toFixed(2).padStart(8) + '  ' +
      tpW.toFixed(2).padStart(9) + '  ' +
      tpC.toFixed(2).padStart(9) + '  ' +
      tpF.toFixed(2).padStart(9) + '\n',
    )
  }
  process.stdout.write('\n')

  // Per-trade outcomes by mode.
  const modes: Mode[] = ['wick+BE', 'channel-noBE', 'channel+BE', 'frac-noBE', 'frac+BE']
  const results = new Map<Mode, SimOut[]>()
  for (const m of modes) {
    results.set(m, entries.map((e) => simulate(e, all.slice(e.entryIdx + 1), m)))
  }

  process.stdout.write('Per-trade R-multiples:\n')
  process.stdout.write(
    'TRADE'.padEnd(7) + '  ' +
    'A wick+BE'.padStart(10) + '  ' +
    'B chan-noBE'.padStart(11) + '  ' +
    'C chan+BE'.padStart(10) + '  ' +
    'D frac-noBE'.padStart(11) + '  ' +
    'E frac+BE'.padStart(10) + '\n',
  )
  process.stdout.write('─'.repeat(70) + '\n')
  for (let i = 0; i < entries.length; i++) {
    const row = [entries[i].label.padEnd(7)]
    const widths: Record<Mode, number> = {
      'wick+BE': 10, 'channel-noBE': 11, 'channel+BE': 10, 'frac-noBE': 11, 'frac+BE': 10,
    }
    for (const m of modes) {
      const r = results.get(m)![i].rMultiple
      const sign = r >= 0 ? '+' : ''
      row.push((sign + r.toFixed(2) + 'R').padStart(widths[m]))
    }
    process.stdout.write(row.join('  ') + '\n')
  }
  process.stdout.write('\n')

  // Aggregate.
  process.stdout.write('Aggregate:\n')
  process.stdout.write(
    'MODE'.padEnd(15) + '  ' +
    'W/L/S'.padStart(7) + '  ' +
    'WinRate'.padStart(8) + '  ' +
    'Tot R'.padStart(8) + '  ' +
    'Tot $'.padStart(9) + '  ' +
    'Max DD'.padStart(8) + '  ' +
    'Profit/DD'.padStart(9) + '\n',
  )
  process.stdout.write('─'.repeat(75) + '\n')
  for (const m of modes) {
    const res = results.get(m)!
    let wins = 0, losses = 0, scratches = 0, totalR = 0, totalUsd = 0
    let peak = 0, running = 0, maxDD = 0
    for (const r of res) {
      totalR += r.rMultiple
      totalUsd += r.pnlUsd
      if (r.rMultiple > 0.05) wins++
      else if (r.rMultiple < -0.05) losses++
      else scratches++
      running += r.pnlUsd
      if (running > peak) peak = running
      const dd = peak - running
      if (dd > maxDD) maxDD = dd
    }
    const winRate = entries.length > 0 ? (wins / entries.length) * 100 : 0
    const profitDD = maxDD > 0 ? totalUsd / maxDD : Infinity
    process.stdout.write(
      m.padEnd(15) + '  ' +
      `${wins}/${losses}/${scratches}`.padStart(7) + '  ' +
      (winRate.toFixed(0) + '%').padStart(8) + '  ' +
      ((totalR >= 0 ? '+' : '') + totalR.toFixed(1) + 'R').padStart(8) + '  ' +
      ((totalUsd >= 0 ? '+' : '−') + '$' + Math.abs(totalUsd).toFixed(2)).padStart(9) + '  ' +
      ('−$' + maxDD.toFixed(2)).padStart(8) + '  ' +
      (Number.isFinite(profitDD) ? profitDD.toFixed(2) : '∞').padStart(9) + '\n',
    )
  }
}

main()
