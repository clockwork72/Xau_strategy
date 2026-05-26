// One-off backtest runner. Loads the M5 CSV, simulates the sandbox's
// forward replay over a Casa-local range, and prints the trades PAB
// would generate. Uses the actual engine modules (no logic duplication).
//
// Run: npx tsx scripts/backtest-range.ts

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
import type { Candle } from '../src/types'
import type { Signal } from '../src/engine/strategy'

const RANGE_START_CASA = '2026-05-20 00:00'
const RANGE_END_CASA = '2026-05-26 15:00'
// Override with env XAU_SL_MODE=channel-frac to backtest v2 (else v1).
const SL_MODE: SlMode = process.env.XAU_SL_MODE === 'channel-frac' ? 'channel-frac' : 'wick'
// Override with env XAU_RED_ONLY=true to require red entry candles.
const RED_ONLY = process.env.XAU_RED_ONLY === 'true'
const TRENDLINE_LOOKBACK = 7
const LOT_SIZE = 0.01 // mirror app default; 1 oz exposure
const CONTRACT_SIZE_OZ = 100

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
  // Suppress the verbose [strategy] / [channels] logs from the engine modules
  // so our final report is the only output.
  const orig = console.log
  console.log = () => {}
  try {
    return fn()
  } finally {
    console.log = orig
  }
}

function main() {
  const fromSec = parseCasaLocalToUtcSec(RANGE_START_CASA)
  const toSec = parseCasaLocalToUtcSec(RANGE_END_CASA)
  if (fromSec === null || toSec === null) {
    throw new Error('Could not parse range')
  }

  const allCandles = loadCsv('public/data/xauusd_m5.csv')
  const replay = allCandles.filter((c) => {
    const t = c.time as number
    return t >= fromSec && t <= toSec
  })

  process.stdout.write(
    `Loaded ${allCandles.length} M5 bars total · replay window ${replay.length} bars\n`,
  )
  process.stdout.write(
    `Range: ${formatCrosshair(fromSec)} → ${formatCrosshair(toSec)} CASA · SL: ${SL_MODE === 'channel-frac' ? 'v2 (channel ¼H)' : 'v1 (wick)'} · entry: ${RED_ONLY ? 'red only' : 'any wick rejection'}\n\n`,
  )

  let pabState: PABState = PAB_INITIAL_STATE

  // Mirror the sandbox's permanent-freeze rule: once an identity
  // (kind, startTime) has frozen, refinement passes cannot un-freeze it
  // for the rest of the session. Without this the backtest will trade
  // "revived" channels the live app considers permanently dead.
  const frozenIdentities = new Set<string>()
  const labelByIdentity = new Map<string, string>()
  let sLabelCounter = 0

  silence(() => {
    for (const playheadBar of replay) {
      const playheadTime = playheadBar.time as number
      const lo = casaSessionStartAtOrBefore(playheadTime)
      const algoCandles: Candle[] = []
      for (const c of allCandles) {
        const t = c.time as number
        if (t < lo) continue
        if (t > playheadTime) break
        algoCandles.push(c)
      }
      if (algoCandles.length === 0) continue

      const swingLows = findSwingLows(algoCandles, TRENDLINE_LOOKBACK)
      const rawChannels = pickChannels(swingLows, algoCandles, 'support')
      const midPrice = algoCandles[Math.floor(algoCandles.length / 2)].close
      const eps = midPrice * TOUCH_PCT

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
        liveChannels.push({
          channel: ch,
          sig: channelSignature(ch),
          label,
          status: 'live',
        })
      }

      pabState = runPriceActionBeta(algoCandles, liveChannels, emaByTime, pabState, SL_MODE, RED_ONLY)
    }
  })

  // Pair signals into trades.
  interface Trade {
    label: string
    entryTime: number
    entryPrice: number
    sl: number
    tp: number
    channelLabel: string
    exitTime: number
    exitPrice: number
    reason: 'stop' | 'target'
    rMultiple: number
    pnlPerOz: number
    pnlUsd: number
    durMin: number
  }
  const trades: Trade[] = []
  const entryByLabel = new Map<string, Signal>()
  let openSig: Signal | null = null
  for (const s of pabState.signals) {
    if (s.label === undefined) continue
    if (s.side === 'sell' && s.sl !== undefined && s.tp !== undefined) {
      entryByLabel.set(s.label, s)
      continue
    }
    if (s.side === 'buy') {
      const entry = entryByLabel.get(s.label)
      if (!entry || entry.sl === undefined || entry.tp === undefined) continue
      const rDist = Math.abs(entry.sl - entry.price)
      const rMult = rDist > 0 ? (entry.price - s.price) / rDist : 0
      const pnlPerOz = entry.price - s.price
      const pnlUsd = pnlPerOz * CONTRACT_SIZE_OZ * LOT_SIZE
      trades.push({
        label: s.label,
        entryTime: entry.time as number,
        entryPrice: entry.price,
        sl: entry.sl,
        tp: entry.tp,
        channelLabel: entry.channelLabel ?? '?',
        exitTime: s.time as number,
        exitPrice: s.price,
        reason: s.reason ?? ('stop' as const),
        rMultiple: rMult,
        pnlPerOz,
        pnlUsd,
        durMin: Math.round(((s.time as number) - (entry.time as number)) / 60),
      })
      entryByLabel.delete(s.label)
    }
  }
  for (const e of entryByLabel.values()) openSig = e

  // Report.
  process.stdout.write(`Trades closed: ${trades.length}${openSig ? ' + 1 open' : ''}\n\n`)

  if (trades.length > 0) {
    const HEAD = [
      'LABEL'.padEnd(7),
      'ENTRY (CASA)'.padEnd(17),
      'EXIT  (CASA)'.padEnd(17),
      'CH'.padEnd(4),
      'RESN'.padEnd(7),
      'DUR'.padStart(5),
      'ENTRY'.padStart(8),
      'EXIT'.padStart(8),
      'R'.padStart(6),
      '$ PnL'.padStart(8),
    ].join('  ')
    process.stdout.write(HEAD + '\n')
    process.stdout.write('-'.repeat(HEAD.length) + '\n')

    let totalR = 0
    let totalUsd = 0
    let wins = 0
    let losses = 0
    let peak = 0
    let running = 0
    let maxDD = 0
    for (const t of trades) {
      totalR += t.rMultiple
      totalUsd += t.pnlUsd
      if (t.pnlUsd > 0) wins++
      else if (t.pnlUsd < 0) losses++
      running += t.pnlUsd
      if (running > peak) peak = running
      const dd = peak - running
      if (dd > maxDD) maxDD = dd
      const rTxt = (t.rMultiple >= 0 ? '+' : '') + t.rMultiple.toFixed(1) + 'R'
      const dollarTxt =
        (t.pnlUsd >= 0 ? '+$' : '−$') + Math.abs(t.pnlUsd).toFixed(2)
      process.stdout.write(
        [
          t.label.padEnd(7),
          formatCrosshair(t.entryTime).padEnd(17),
          formatCrosshair(t.exitTime).padEnd(17),
          t.channelLabel.padEnd(4),
          t.reason.padEnd(7),
          (t.durMin + 'm').padStart(5),
          t.entryPrice.toFixed(2).padStart(8),
          t.exitPrice.toFixed(2).padStart(8),
          rTxt.padStart(6),
          dollarTxt.padStart(8),
        ].join('  ') + '\n',
      )
    }

    process.stdout.write('\n')
    const winRate = trades.length > 0 ? (wins / trades.length) * 100 : 0
    process.stdout.write(
      `Summary: ${trades.length} closed · ${wins}W / ${losses}L · ${winRate.toFixed(0)}% win\n`,
    )
    process.stdout.write(
      `R sum: ${totalR >= 0 ? '+' : ''}${totalR.toFixed(1)}R · ` +
        `$ sum: ${totalUsd >= 0 ? '+' : '−'}$${Math.abs(totalUsd).toFixed(2)} ` +
        `(at lot=${LOT_SIZE}, ${LOT_SIZE * CONTRACT_SIZE_OZ}oz)\n`,
    )
    process.stdout.write(
      `Max DD: −$${maxDD.toFixed(2)} (on realized equity curve)\n`,
    )
  }

  if (openSig) {
    process.stdout.write('\nOPEN TRADE:\n')
    process.stdout.write(
      `  ${openSig.label}  entry ${openSig.price.toFixed(2)} @ ${formatCrosshair(openSig.time as number)}` +
        `  SL ${openSig.sl!.toFixed(2)}  TP ${openSig.tp!.toFixed(2)}  ch=${openSig.channelLabel ?? '?'}\n`,
    )
  }
}

main()
