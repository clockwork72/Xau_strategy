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

// CVD resets to 0 at the start of each session day. Asian session conventionally
// closes at 08:00 UTC (Tokyo → London handoff); bars from 08:00 UTC onward belong
// to the next session bucket.
export const SESSION_RESET_HOUR_UTC = 8

function sessionBucket(timeSec: number): number {
  const d = new Date(timeSec * 1000)
  const dayIdx = Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000,
  )
  return d.getUTCHours() < SESSION_RESET_HOUR_UTC ? dayIdx - 1 : dayIdx
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
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0')
  // Daily settlement window — 17:00 NY for one hour, every day.
  if (hour === 17) return true
  // Weekend tail: Friday after the daily close stays closed all the way to Sunday open.
  if (dow === 'Fri' && hour > 17) return true
  if (dow === 'Sat') return true
  if (dow === 'Sun' && hour < 17) return true
  return false
}

function deriveBuySell(high: number, low: number, close: number, tv: number) {
  const rng = high - low
  const buyShare = rng > 0 ? (close - low) / rng : 0.5
  return { buy: tv * buyShare, sell: tv * (1 - buyShare) }
}

function makeCvdCandle(
  time: UTCTimestamp,
  prevClose: number,
  buy: number,
  sell: number,
): CvdCandle {
  const open = prevClose
  const close = open + buy - sell
  return {
    time,
    open: +open.toFixed(0),
    high: +(open + buy).toFixed(0),
    low: +(open - sell).toFixed(0),
    close: +close.toFixed(0),
  }
}

export function rowsToBundle(rows: CsvRow[]): DatasetBundle {
  const candles: Candle[] = []
  const cvd: CvdCandle[] = []
  let cvdClose = 0
  let prevBucket: number | null = null
  for (const r of rows) {
    const open = +r.open
    const high = +r.high
    const low = +r.low
    const close = +r.close
    if (!Number.isFinite(open + high + low + close)) continue
    const t = parseTimeSec(r.time) as UTCTimestamp
    if (isBrokerClosed(t)) continue
    const tv = r.tick_volume ? +r.tick_volume : 0
    candles.push({ time: t, open, high, low, close, tickVolume: tv })
    const bucket = sessionBucket(t)
    if (prevBucket !== null && bucket !== prevBucket) cvdClose = 0
    prevBucket = bucket
    const { buy, sell } = deriveBuySell(high, low, close, tv)
    const cc = makeCvdCandle(t, cvdClose, buy, sell)
    cvd.push(cc)
    cvdClose = cc.close
  }
  return { candles, cvd }
}

export function buildMockSeries(stepSec: number, count: number): DatasetBundle {
  const start = Math.floor(Date.now() / 1000) - stepSec * count
  let price = 2350
  let cvdClose = 0
  let prevBucket: number | null = null
  const candles: Candle[] = []
  const cvd: CvdCandle[] = []
  for (let i = 0; i < count; i++) {
    const t = (start + i * stepSec) as UTCTimestamp
    const drift = Math.sin(i / 9) * 1.2 + (Math.random() - 0.5) * 0.8
    const open = price
    const close = +(price + drift).toFixed(2)
    const high = +(Math.max(open, close) + Math.random() * 0.6).toFixed(2)
    const low = +(Math.min(open, close) - Math.random() * 0.6).toFixed(2)
    const tv = 200 + Math.floor(Math.random() * 600)
    candles.push({ time: t, open, high, low, close, tickVolume: tv })
    const bucket = sessionBucket(t)
    if (prevBucket !== null && bucket !== prevBucket) cvdClose = 0
    prevBucket = bucket
    const { buy, sell } = deriveBuySell(high, low, close, tv)
    const cc = makeCvdCandle(t, cvdClose, buy, sell)
    cvd.push(cc)
    cvdClose = cc.close
    price = close
  }
  return { candles, cvd }
}

export const MOCK_M1: DatasetBundle = buildMockSeries(60, 240)
export const MOCK_M5: DatasetBundle = buildMockSeries(300, 240)
