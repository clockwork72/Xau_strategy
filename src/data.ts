import Papa from 'papaparse'
import type { Candle, CvdCandle, DatasetBundle } from './types'
import type { UTCTimestamp } from 'lightweight-charts'

interface CsvRow {
  time: string
  open: string
  high: string
  low: string
  close: string
  tick_volume?: string
}

export async function loadCsv(url: string): Promise<CsvRow[]> {
  const text = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`fetch ${url}: ${r.status}`)
    return r.text()
  })
  return new Promise((resolve, reject) => {
    Papa.parse<CsvRow>(text, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => resolve(res.data),
      error: (e: Error) => reject(e),
    })
  })
}

// OANDA's MT5 server reports bar times in UTC+3 (EEST summer broker time).
// Verified by visual cross-check with TradingView's OANDA spot feed:
//   our display @ 21:55 Casa ≡ TradingView @ 17:55 Casa → 4-hour visible delta
//   means data is 3h ahead of real UTC (Casa adds the 4th hour at display time).
// We subtract 3h (10800s) when parsing CSV rows so all downstream logic
// (sessions, CVD reset, broker-closed filter, chart axis, hover labels)
// operates in real UTC.
//
// Note: assumes fixed UTC+3 year-round on the broker server. If Feb data
// (winter EET, UTC+2) reads 1h off vs TradingView, switch to a DST-aware
// offset via `Europe/Athens` IANA zone.
const OANDA_MT5_TZ_OFFSET_SEC = -10800

function parseTimeSec(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  return Math.floor(new Date(iso).getTime() / 1000) + OANDA_MT5_TZ_OFFSET_SEC
}

// CVD anchor matches TradingView's default "1D" reset for OANDA:XAUUSD:
// the daily session bar opens at 17:00 NY (DST-aware). Bars at-or-after 17:00 NY
// belong to the NEXT trading-day bucket; bars before belong to the current NY date.
const NY_DATE_HOUR_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
})
const UTC_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function anchorBucket(timeSec: number): string {
  const parts = NY_DATE_HOUR_FMT.formatToParts(new Date(timeSec * 1000))
  const y = parts.find((p) => p.type === 'year')!.value
  const m = parts.find((p) => p.type === 'month')!.value
  const d = parts.find((p) => p.type === 'day')!.value
  const h = parseInt(parts.find((p) => p.type === 'hour')!.value)
  if (h < 17) return `${y}-${m}-${d}`
  return UTC_DATE_FMT.format(new Date(Date.UTC(+y, +m - 1, +d + 1)))
}

// OANDA's gold market is closed during these windows — drop those bars so the
// chart matches TradingView's OANDA spot feed and session overlays only span
// real trading hours. All anchored to NY local time so US DST is automatic.
//
//   Daily close (Mon–Thu): 17:00–18:00 NY  (1-hour settlement window)
//   Weekend close:         Fri 17:00 NY  →  Sun 18:00 NY  (≈49 hours)
//
// Outside these windows, FX/metals trade continuously.
const NY_DOW_HOUR_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  hour12: false,
})

function isBrokerClosed(timeSec: number): boolean {
  const parts = NY_DOW_HOUR_FMT.formatToParts(new Date(timeSec * 1000))
  const dow = parts.find((p) => p.type === 'weekday')?.value ?? ''
  // Some Intl implementations (e.g. Node 20) return "24" for midnight under
  // en-US + hour12:false; Chromium returns "00". Mod 24 normalizes both so
  // bars at NY 00:00 (= midnight) aren't accidentally classified as "Fri
  // after 17" and dropped. Affects Casa 05:00-05:55 May 22, which contains
  // the S4 channel-break confirmation.
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24
  if (hour === 17) return true
  if (dow === 'Fri' && hour > 17) return true
  if (dow === 'Sat') return true
  if (dow === 'Sun' && hour < 17) return true
  return false
}

// TradingView's ta.requestVolumeDelta classifies each lower-TF bar as a single
// direction: close > open → all volume buys, close < open → all volume sells.
// Doji (open == close) → split evenly so the cumulative line doesn't get sticky.
function classify(open: number, close: number, tv: number): { buy: number; sell: number } {
  if (close > open) return { buy: tv, sell: 0 }
  if (close < open) return { buy: 0, sell: tv }
  return { buy: tv / 2, sell: tv / 2 }
}

interface ParsedRow {
  t: number
  open: number
  high: number
  low: number
  close: number
  tv: number
}

function parseRows(rows: CsvRow[]): ParsedRow[] {
  const out: ParsedRow[] = []
  for (const r of rows) {
    const open = +r.open
    const high = +r.high
    const low = +r.low
    const close = +r.close
    if (!Number.isFinite(open + high + low + close)) continue
    const t = parseTimeSec(r.time)
    if (isBrokerClosed(t)) continue
    const tv = r.tick_volume ? +r.tick_volume : 0
    out.push({ t, open, high, low, close, tv })
  }
  return out
}

function toCandle(r: ParsedRow): Candle {
  return {
    time: r.t as UTCTimestamp,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    tickVolume: r.tv,
  }
}

// One CVD candle per input row, sign-classified. Each candle's wick is trivial
// because there's only one sub-bar contributing — high/low collapse onto open/close.
// Used for the M1 bundle (M1 is already the lowest TF available here).
function buildSimpleCvd(rows: ParsedRow[]): CvdCandle[] {
  const out: CvdCandle[] = []
  let cum = 0
  let prevBucket: string | null = null
  for (const r of rows) {
    const bucket = anchorBucket(r.t)
    if (prevBucket !== null && bucket !== prevBucket) cum = 0
    prevBucket = bucket
    const { buy, sell } = classify(r.open, r.close, r.tv)
    const open = cum
    const close = cum + buy - sell
    out.push({
      time: r.t as UTCTimestamp,
      open: +open.toFixed(0),
      high: +Math.max(open, close).toFixed(0),
      low: +Math.min(open, close).toFixed(0),
      close: +close.toFixed(0),
    })
    cum = close
  }
  return out
}

// HTF (M5) CVD candles assembled by drilling into LTF (M1) rows — mirrors
// TradingView's ta.requestVolumeDelta lower-timeframe scan.
//   open  = cumulative at the start of the HTF window
//   close = cumulative after consuming all LTF rows in [start, start+step)
//   high  = max running cumulative during the window
//   low   = min running cumulative during the window
function buildAggregatedCvd(
  htfRows: ParsedRow[],
  ltfRows: ParsedRow[],
  htfStepSec: number,
): CvdCandle[] {
  const out: CvdCandle[] = []
  let cum = 0
  let prevBucket: string | null = null
  let ltfIdx = 0
  for (const h of htfRows) {
    const start = h.t
    const end = start + htfStepSec
    while (ltfIdx < ltfRows.length && ltfRows[ltfIdx].t < start) ltfIdx++
    const bucket = anchorBucket(start)
    if (prevBucket !== null && bucket !== prevBucket) cum = 0
    prevBucket = bucket
    const open = cum
    let high = cum
    let low = cum
    while (ltfIdx < ltfRows.length && ltfRows[ltfIdx].t < end) {
      const r = ltfRows[ltfIdx]
      const { buy, sell } = classify(r.open, r.close, r.tv)
      cum = cum + buy - sell
      if (cum > high) high = cum
      if (cum < low) low = cum
      ltfIdx++
    }
    out.push({
      time: start as UTCTimestamp,
      open: +open.toFixed(0),
      high: +high.toFixed(0),
      low: +low.toFixed(0),
      close: +cum.toFixed(0),
    })
  }
  return out
}

export function buildM1Bundle(m1Rows: CsvRow[]): DatasetBundle {
  const parsed = parseRows(m1Rows)
  return { candles: parsed.map(toCandle), cvd: buildSimpleCvd(parsed) }
}

export function buildM5Bundle(m5Rows: CsvRow[], m1Rows: CsvRow[]): DatasetBundle {
  const m5Parsed = parseRows(m5Rows)
  const m1Parsed = parseRows(m1Rows)
  return {
    candles: m5Parsed.map(toCandle),
    cvd: buildAggregatedCvd(m5Parsed, m1Parsed, 300),
  }
}

function buildMockSeries(stepSec: number, count: number): DatasetBundle {
  const start = Math.floor(Date.now() / 1000) - stepSec * count
  let price = 2350
  const parsed: ParsedRow[] = []
  for (let i = 0; i < count; i++) {
    const t = start + i * stepSec
    const drift = Math.sin(i / 9) * 1.2 + (Math.random() - 0.5) * 0.8
    const open = price
    const close = +(price + drift).toFixed(2)
    const high = +(Math.max(open, close) + Math.random() * 0.6).toFixed(2)
    const low = +(Math.min(open, close) - Math.random() * 0.6).toFixed(2)
    const tv = 200 + Math.floor(Math.random() * 600)
    parsed.push({ t, open, high, low, close, tv })
    price = close
  }
  return { candles: parsed.map(toCandle), cvd: buildSimpleCvd(parsed) }
}

export const MOCK_M1: DatasetBundle = buildMockSeries(60, 240)
export const MOCK_M5: DatasetBundle = buildMockSeries(300, 240)
