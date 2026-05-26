// Detailed analyzer for individual trades. Reproduces the algorithmic
// state at the entry bar (algoCandles, EMA21, live support channels) and
// walks bar-by-bar from entry to exit so we can see what killed the trade.
//
// Run: npx tsx scripts/analyze-trades.ts

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
  extendChannelToTime,
  TOUCH_PCT,
} from '../src/engine/trendlines'
import type { Candle } from '../src/types'

const TRENDLINE_LOOKBACK = 7
const STOP_BUFFER_PCT = 0.0002
const OANDA_MT5_TZ_OFFSET_SEC = -10800

interface TradeSpec {
  label: string
  entryCasa: string
  exitCasa: string
  expEntry: number
  expSL: number
}

const TRADES: TradeSpec[] = [
  // Range 2026-05-20 00:00 → 2026-05-26 15:00 CASA, M5, BE@1R + EMA filter active
  { label: 'PAB-4 (winner, +3R)', entryCasa: '2026-05-25 05:55', exitCasa: '2026-05-25 06:20', expEntry: 4564.88, expSL: 4566.66 },
  { label: 'PAB-5 (BE-scratch)',  entryCasa: '2026-05-25 08:10', exitCasa: '2026-05-25 08:30', expEntry: 4560.79, expSL: 4565.43 },
]

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

function analyze(t: TradeSpec, all: Candle[]) {
  const entrySec = parseCasaLocalToUtcSec(t.entryCasa)
  const exitSec = parseCasaLocalToUtcSec(t.exitCasa)
  if (entrySec === null || exitSec === null) throw new Error('bad time')

  const idx = all.findIndex((c) => (c.time as number) === entrySec)
  if (idx < 0) {
    console.log(`${t.label}: bar @ ${t.entryCasa} not found`)
    return
  }
  const entryBar = all[idx]

  // Reproduce algoCandles at the entry playhead.
  const sessionStart = casaSessionStartAtOrBefore(entrySec)
  const algoCandles: Candle[] = []
  for (const c of all) {
    const ts = c.time as number
    if (ts < sessionStart) continue
    if (ts > entrySec) break
    algoCandles.push(c)
  }

  // EMA21 at the entry bar.
  const emaMap = new Map<number, number>()
  for (const p of computeEma(algoCandles, 21)) emaMap.set(p.time, p.value)
  const ema21 = emaMap.get(entrySec)

  // Live support channels at entry — match the sandbox's logic (live = no
  // confirmed break).
  const swingLows = findSwingLows(algoCandles, TRENDLINE_LOOKBACK)
  const raw = pickChannels(swingLows, algoCandles, 'support')
  const mid = algoCandles[Math.floor(algoCandles.length / 2)].close
  const eps = mid * TOUCH_PCT

  type LiveCh = ReturnType<typeof extendChannelToTime>
  const live: { ch: LiveCh; touches: number; sig: string }[] = []
  for (const ch of raw) {
    if (findChannelBreak(ch, algoCandles, eps) !== null) continue
    if (entrySec < ch.startTime) continue
    const extended = extendChannelToTime(ch, entrySec)
    live.push({ ch: extended, touches: ch.touches, sig: `${ch.startTime}→${ch.endTime}` })
  }
  // The channel the strategy fires against is the one whose UPPER rail
  // (derived parallel for a support channel) is within eps of close.
  const triggered = live.find((m) => Math.abs(entryBar.close - m.ch.upperEnd) <= eps)

  // Header.
  const sep = '─'.repeat(78)
  console.log(sep)
  console.log(`${t.label}   entry ${formatCrosshair(entrySec)} CASA   exit ${formatCrosshair(exitSec)} CASA   (M5)`)
  console.log(sep)

  // Entry candle shape.
  const range = entryBar.high - entryBar.low
  const body = Math.abs(entryBar.close - entryBar.open)
  const upperWick = entryBar.high - Math.max(entryBar.open, entryBar.close)
  const lowerWick = Math.min(entryBar.open, entryBar.close) - entryBar.low
  console.log('Entry candle:')
  console.log(
    `  O=${entryBar.open.toFixed(3)}  H=${entryBar.high.toFixed(3)}  L=${entryBar.low.toFixed(3)}  C=${entryBar.close.toFixed(3)}`,
  )
  console.log(
    `  range=${range.toFixed(3)}  body=${body.toFixed(3)} (${((body / range) * 100).toFixed(0)}%)` +
      `  upperWick=${upperWick.toFixed(3)} (${((upperWick / range) * 100).toFixed(0)}%)` +
      `  lowerWick=${lowerWick.toFixed(3)} (${((lowerWick / range) * 100).toFixed(0)}%)`,
  )
  const minBodyOK = body / range >= 0.15
  const wickOK = upperWick > body
  console.log(
    `  body/range ≥ 0.15? ${minBodyOK ? 'YES' : 'no '}    upperWick > body? ${wickOK ? 'YES' : 'no '}`,
  )

  // Context vs EMA + channel.
  console.log('\nContext at entry:')
  if (ema21 !== undefined) {
    console.log(
      `  EMA21=${ema21.toFixed(3)}  ·  close − EMA21 = ${(entryBar.close - ema21 >= 0 ? '+' : '') + (entryBar.close - ema21).toFixed(3)} ` +
        `(close ${entryBar.close > ema21 ? 'ABOVE' : 'BELOW'} EMA21 ${entryBar.close > ema21 ? '✓' : '✗ — should reject'})`,
    )
  }
  if (triggered) {
    console.log(
      `  Channel touched: upper-rail=${triggered.ch.upperEnd.toFixed(3)}  lower-rail=${triggered.ch.lowerEnd.toFixed(3)}` +
        `  touches=${triggered.touches}  span=${triggered.sig}`,
    )
    console.log(
      `  close − upper-rail = ${(entryBar.close - triggered.ch.upperEnd >= 0 ? '+' : '') + (entryBar.close - triggered.ch.upperEnd).toFixed(3)} ` +
        `(eps=${eps.toFixed(3)})`,
    )
  } else {
    console.log(`  WARN: no matching live support channel at entry — anomaly`)
  }

  // Reconstruct strategy SL/TP.
  const stopBuffer = mid * STOP_BUFFER_PCT
  const sl = entryBar.high + stopBuffer
  const r = sl - entryBar.close
  const tp = entryBar.close - 3 * r
  console.log('\nStrategy levels:')
  console.log(
    `  Entry  ${entryBar.close.toFixed(3)}   SL ${sl.toFixed(3)} (Δ +${r.toFixed(3)})   TP ${tp.toFixed(3)} (Δ −${(3 * r).toFixed(3)})`,
  )

  // Bar-by-bar walk to the stop. Track max favorable + max adverse.
  console.log('\nPath entry → stop:')
  console.log(
    '  ' +
      'TIME (CASA)'.padEnd(17) +
      '  ' +
      'OPEN'.padStart(8) +
      '  ' +
      'HIGH'.padStart(8) +
      '  ' +
      'LOW'.padStart(8) +
      '  ' +
      'CLOSE'.padStart(8) +
      '  ' +
      'Δhigh−SL'.padStart(10) +
      '  ' +
      'Δlow−entry'.padStart(11) +
      '  note',
  )
  let maxFavorable = 0 // how far the trade got in our favor (entry - low)
  let maxAdverse = 0 // how far against (high - entry)
  let runningMin = entryBar.low
  let runningMax = entryBar.high
  for (let i = idx + 1; i < all.length; i++) {
    const bar = all[i]
    const ts = bar.time as number
    if (ts > exitSec) break
    if (bar.high > runningMax) runningMax = bar.high
    if (bar.low < runningMin) runningMin = bar.low
    const fav = entryBar.close - bar.low
    if (fav > maxFavorable) maxFavorable = fav
    const adv = bar.high - entryBar.close
    if (adv > maxAdverse) maxAdverse = adv
    const hitSL = bar.high >= sl
    const dHighSL = (bar.high - sl).toFixed(3)
    const dLowEntry = (bar.low - entryBar.close).toFixed(3)
    const note = hitSL ? '← STOP HIT' : ''
    console.log(
      '  ' +
        formatCrosshair(ts).padEnd(17) +
        '  ' +
        bar.open.toFixed(3).padStart(8) +
        '  ' +
        bar.high.toFixed(3).padStart(8) +
        '  ' +
        bar.low.toFixed(3).padStart(8) +
        '  ' +
        bar.close.toFixed(3).padStart(8) +
        '  ' +
        dHighSL.padStart(10) +
        '  ' +
        dLowEntry.padStart(11) +
        '  ' +
        note,
    )
    if (hitSL) break
  }

  console.log('')
  console.log(
    `Max favorable (entry − lowest low):   ${maxFavorable >= 0 ? '+' : ''}${maxFavorable.toFixed(3)}  ` +
      `(would have been ${(maxFavorable / r).toFixed(2)}R)`,
  )
  console.log(
    `Max adverse   (highest high − entry): ${maxAdverse >= 0 ? '+' : ''}${maxAdverse.toFixed(3)}  ` +
      `(SL distance r = ${r.toFixed(3)})`,
  )
  console.log('')
}

function main() {
  const all = loadCsv('public/data/xauusd_m5.csv')
  for (const t of TRADES) analyze(t, all)
}

main()
