import { readFileSync } from 'fs'
import Papa from 'papaparse'
import type { UTCTimestamp } from 'lightweight-charts'
import { parseCasaLocalToUtcSec, formatCrosshair } from '../src/util/time'
import type { Candle } from '../src/types'

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

interface CsvRow { time: string; open: string; high: string; low: string; close: string; tick_volume?: string }

const text = readFileSync('public/data/xauusd_m5.csv', 'utf-8')
const res = Papa.parse<CsvRow>(text, { header: true, skipEmptyLines: true })

const winStart = parseCasaLocalToUtcSec('2026-05-22 04:30')!
const winEnd = parseCasaLocalToUtcSec('2026-05-22 06:30')!

for (const r of res.data) {
  const iso = r.time.includes('T') ? r.time : r.time.replace(' ', 'T')
  const rawUtc = Math.floor(new Date(iso).getTime() / 1000)
  const t = rawUtc + OANDA_MT5_TZ_OFFSET_SEC
  if (t < winStart || t > winEnd) continue
  const closed = isBrokerClosed(t)
  const nyParts = NY_FMT.formatToParts(new Date(t * 1000))
  const dow = nyParts.find((p) => p.type === 'weekday')?.value
  const hr = nyParts.find((p) => p.type === 'hour')?.value
  console.log(
    `csv=${r.time}  utc=${rawUtc}→${t}  casa=${formatCrosshair(t)}  NY=${dow} ${hr}  closed=${closed}  OHLC=${r.open}/${r.high}/${r.low}/${r.close}`,
  )
}
