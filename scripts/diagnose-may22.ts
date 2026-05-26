// Diagnostic: at each playhead between 05:00 and 06:30 May 22 Casa,
// print whether the S4 channel (support, startTime=1779414000) is
// detected, what findChannelBreak returns, and whether it makes it
// into liveChannels. Helps explain why my backtest fires PAB-2/PAB-3
// on a channel that the production app freezes.

import { readFileSync } from 'fs'
import Papa from 'papaparse'
import type { UTCTimestamp } from 'lightweight-charts'

import { parseCasaLocalToUtcSec, casaSessionStartAtOrBefore, formatCrosshair } from '../src/util/time'
import { computeEma } from '../src/engine/indicators'
import { findSwingLows } from '../src/engine/swings'
import { pickChannels, findChannelBreak, emaOutsideRailsFrac, EMA_OUTSIDE_MAX_FRAC, TOUCH_PCT } from '../src/engine/trendlines'
import type { Candle } from '../src/types'

const RANGE_START_CASA = '2026-05-20 00:00'
const RANGE_END_CASA = '2026-05-26 15:00'
const TRENDLINE_LOOKBACK = 7
const OANDA_MT5_TZ_OFFSET_SEC = -10800
const S4_START = 1779414000 // support|1779414000 per production log

const NY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', hour12: false,
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

interface CsvRow { time: string; open: string; high: string; low: string; close: string; tick_volume?: string }

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

function main() {
  const fromSec = parseCasaLocalToUtcSec(RANGE_START_CASA)!
  const toSec = parseCasaLocalToUtcSec(RANGE_END_CASA)!
  const all = loadCsv('public/data/xauusd_m5.csv')

  // Walk through the replay window and track channels using SAME logic as backtest.
  const replay = all.filter((c) => {
    const t = c.time as number
    return t >= fromSec && t <= toSec
  })
  const frozenIdentities = new Set<string>()
  const traceWindowStart = parseCasaLocalToUtcSec('2026-05-22 04:30')!
  const traceWindowEnd = parseCasaLocalToUtcSec('2026-05-22 07:00')!
  let s4FrozenAt: number | null = null

  process.stdout.write(
    `Tracking S4 (identity=support|${S4_START}) across playheads 04:30 → 07:00 Casa May 22\n\n`,
  )
  process.stdout.write(
    'PLAYHEAD          IN_RAW  IN_FROZEN  BREAK_T          EMA_OUT%  STATUS\n',
  )
  process.stdout.write('─'.repeat(85) + '\n')

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

    const s4Identity = `support|${S4_START}`
    const inRaw = rawChannels.find((c) => c.startTime === S4_START && c.kind === 'support')
    const inFrozen = frozenIdentities.has(s4Identity)
    let breakT: number | null = null
    let emaOut: number = NaN
    let status = 'absent'
    if (inRaw) {
      breakT = findChannelBreak(inRaw, algoCandles, eps)
      emaOut = emaOutsideRailsFrac(inRaw, algoCandles, emaByTime)
      if (inFrozen) status = 'FROZEN (prev)'
      else if (!Number.isNaN(emaOut) && emaOut > EMA_OUTSIDE_MAX_FRAC) status = 'EMA-rejected'
      else if (breakT !== null) {
        status = 'NEWLY FROZEN'
        frozenIdentities.add(s4Identity)
        if (s4FrozenAt === null) s4FrozenAt = playheadTime
      } else status = 'LIVE'
    } else if (inFrozen) {
      status = 'FROZEN (prev, not in raw)'
    }

    // Process other raw channels too so frozenIdentities tracks them (parity with backtest).
    for (const ch of rawChannels) {
      const identity = `${ch.kind}|${ch.startTime}`
      if (identity === s4Identity) continue
      if (frozenIdentities.has(identity)) continue
      const out = emaOutsideRailsFrac(ch, algoCandles, emaByTime)
      if (!Number.isNaN(out) && out > EMA_OUTSIDE_MAX_FRAC) continue
      if (findChannelBreak(ch, algoCandles, eps) !== null) {
        frozenIdentities.add(identity)
      }
    }

    if (playheadTime >= traceWindowStart && playheadTime <= traceWindowEnd) {
      process.stdout.write(
        formatCrosshair(playheadTime).padEnd(17) + ' ' +
        (inRaw ? 'YES' : 'no').padStart(6) + '  ' +
        (inFrozen ? 'YES' : 'no').padStart(9) + '  ' +
        (breakT !== null ? formatCrosshair(breakT) : '—').padStart(15) + '  ' +
        (Number.isNaN(emaOut) ? '—' : (emaOut * 100).toFixed(0) + '%').padStart(8) + '  ' +
        status + '\n',
      )
    }
  }

  process.stdout.write(`\n`)
  if (s4FrozenAt !== null) {
    process.stdout.write(`S4 first frozen in backtest at playhead: ${formatCrosshair(s4FrozenAt)} Casa\n`)
  } else {
    process.stdout.write(`S4 NEVER frozen in backtest's walk!\n`)
  }
}

main()
