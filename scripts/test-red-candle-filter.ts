// Compare 4 mode combinations of the PAB-Short strategy with / without an
// extra "entry candle must be red (close < open)" filter:
//
//   A · v1 wick + any candle      (current default)
//   B · v1 wick + red candle only
//   C · v2 channel-frac + any
//   D · v2 channel-frac + red candle only
//
// Range: 2026-05-20 00:00 → 2026-05-26 15:00 CASA, M5, BE@1R + EMA filter
// active in all modes.
//
// Run: npx tsx scripts/test-red-candle-filter.ts

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
  TOUCH_PCT,
  type ChannelMeta,
} from '../src/engine/trendlines'
import {
  runPriceActionBeta,
  PAB_INITIAL_STATE,
  type PABState,
  type SlMode,
} from '../src/engine/priceActionBeta'
import type { Signal } from '../src/engine/strategy'
import type { Candle } from '../src/types'

const RANGE_START_CASA = '2026-05-20 00:00'
const RANGE_END_CASA = '2026-05-26 15:00'
const TRENDLINE_LOOKBACK = 7
const LOT_SIZE = 0.01
const CONTRACT_SIZE_OZ = 100
const OANDA_MT5_TZ_OFFSET_SEC = -10800

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

interface ModeConfig {
  name: string
  slMode: SlMode
  redCandleOnly: boolean
}

interface TradeRow {
  label: string
  entryTime: number
  exitTime: number
  channelLabel: string
  reason: string
  rMultiple: number
  pnlUsd: number
}

interface ModeResult {
  config: ModeConfig
  trades: TradeRow[]
  totalR: number
  totalUsd: number
  wins: number
  losses: number
  scratches: number
  maxDD: number
}

function runMode(all: Candle[], fromSec: number, toSec: number, cfg: ModeConfig): ModeResult {
  const replay = all.filter((c) => {
    const t = c.time as number
    return t >= fromSec && t <= toSec
  })
  let pabState: PABState = PAB_INITIAL_STATE
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
      pabState = runPriceActionBeta(
        algoCandles, liveChannels, emaByTime, pabState, cfg.slMode, cfg.redCandleOnly,
      )
    }
  })

  // Pair signals into trades.
  const trades: TradeRow[] = []
  const entryByLabel = new Map<string, Signal>()
  for (const s of pabState.signals) {
    if (s.label === undefined) continue
    if (s.side === 'sell' && s.sl !== undefined && s.tp !== undefined) {
      entryByLabel.set(s.label, s)
      continue
    }
    if (s.side === 'buy') {
      const entry = entryByLabel.get(s.label)
      if (!entry || entry.sl === undefined) continue
      const rDist = Math.abs(entry.sl - entry.price)
      const rMult = rDist > 0 ? (entry.price - s.price) / rDist : 0
      const pnlUsd = (entry.price - s.price) * CONTRACT_SIZE_OZ * LOT_SIZE
      trades.push({
        label: s.label,
        entryTime: entry.time as number,
        exitTime: s.time as number,
        channelLabel: entry.channelLabel ?? '?',
        reason: s.reason ?? 'stop',
        rMultiple: rMult, pnlUsd,
      })
      entryByLabel.delete(s.label)
    }
  }

  let wins = 0, losses = 0, scratches = 0, totalR = 0, totalUsd = 0
  let peak = 0, running = 0, maxDD = 0
  for (const t of trades) {
    totalR += t.rMultiple
    totalUsd += t.pnlUsd
    if (t.rMultiple > 0.05) wins++
    else if (t.rMultiple < -0.05) losses++
    else scratches++
    running += t.pnlUsd
    if (running > peak) peak = running
    const dd = peak - running
    if (dd > maxDD) maxDD = dd
  }

  return { config: cfg, trades, totalR, totalUsd, wins, losses, scratches, maxDD }
}

function main() {
  const fromSec = parseCasaLocalToUtcSec(RANGE_START_CASA)!
  const toSec = parseCasaLocalToUtcSec(RANGE_END_CASA)!
  const all = loadCsv('public/data/xauusd_m5.csv')

  const modes: ModeConfig[] = [
    { name: 'A · v1 wick    + any',  slMode: 'wick',         redCandleOnly: false },
    { name: 'B · v1 wick    + RED',  slMode: 'wick',         redCandleOnly: true  },
    { name: 'C · v2 channel + any',  slMode: 'channel-frac', redCandleOnly: false },
    { name: 'D · v2 channel + RED',  slMode: 'channel-frac', redCandleOnly: true  },
  ]
  const results = modes.map((m) => runMode(all, fromSec, toSec, m))

  process.stdout.write(
    `Range: ${RANGE_START_CASA} → ${RANGE_END_CASA} CASA · M5 · BE@1R + EMA filter ON\n\n`,
  )

  // Per-mode trade lists (compact).
  for (const r of results) {
    process.stdout.write(
      `${r.config.name}  →  ${r.trades.length} trade${r.trades.length === 1 ? '' : 's'}\n`,
    )
    if (r.trades.length === 0) {
      process.stdout.write('  (no entries)\n\n')
      continue
    }
    for (const t of r.trades) {
      const rTxt = (t.rMultiple >= 0 ? '+' : '') + t.rMultiple.toFixed(1) + 'R'
      const $txt = (t.pnlUsd >= 0 ? '+$' : '−$') + Math.abs(t.pnlUsd).toFixed(2)
      process.stdout.write(
        `  ${t.label.padEnd(7)}  ${formatCrosshair(t.entryTime)}  ` +
        `${t.channelLabel.padEnd(4)}  ${t.reason.padEnd(7)}  ` +
        `${rTxt.padStart(6)}  ${$txt.padStart(8)}\n`,
      )
    }
    process.stdout.write('\n')
  }

  // Aggregate side-by-side.
  process.stdout.write('Aggregate:\n')
  process.stdout.write(
    'MODE'.padEnd(28) + '  ' +
    'Trades'.padStart(7) + '  ' +
    'W/L/S'.padStart(7) + '  ' +
    'WinRate'.padStart(8) + '  ' +
    'Tot R'.padStart(7) + '  ' +
    'Tot $'.padStart(9) + '  ' +
    'Max DD'.padStart(8) + '  ' +
    'Profit/DD'.padStart(9) + '\n',
  )
  process.stdout.write('─'.repeat(95) + '\n')
  for (const r of results) {
    const total = r.trades.length
    const winRate = total > 0 ? (r.wins / total) * 100 : 0
    const profitDD = r.maxDD > 0 ? r.totalUsd / r.maxDD : Infinity
    process.stdout.write(
      r.config.name.padEnd(28) + '  ' +
      total.toString().padStart(7) + '  ' +
      `${r.wins}/${r.losses}/${r.scratches}`.padStart(7) + '  ' +
      (winRate.toFixed(0) + '%').padStart(8) + '  ' +
      ((r.totalR >= 0 ? '+' : '') + r.totalR.toFixed(1) + 'R').padStart(7) + '  ' +
      ((r.totalUsd >= 0 ? '+' : '−') + '$' + Math.abs(r.totalUsd).toFixed(2)).padStart(9) + '  ' +
      ('−$' + r.maxDD.toFixed(2)).padStart(8) + '  ' +
      (Number.isFinite(profitDD) ? profitDD.toFixed(2) : '∞').padStart(9) + '\n',
    )
  }
}

main()
