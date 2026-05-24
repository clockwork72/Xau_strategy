// All chart/UI times render in Casablanca local. Internal data stays in UTC epoch seconds.
// IANA timezone handles Morocco's Ramadan UTC offset shift automatically.

export const DISPLAY_TZ = 'Africa/Casablanca'
export const DISPLAY_TZ_LABEL = 'CASA'

const axisTimeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const axisDateFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  day: '2-digit',
  month: 'short',
})

const axisMonthFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  month: 'short',
  year: 'numeric',
})

const crosshairFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const clockFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

const yearFmt = new Intl.DateTimeFormat('en-GB', { timeZone: DISPLAY_TZ, year: 'numeric' })

/** For chart axis tick labels. */
export function formatAxisTick(timestampSec: number, tickMarkType: number): string {
  const d = new Date(timestampSec * 1000)
  // lightweight-charts TickMarkType: 0=Year, 1=Month, 2=DayOfMonth, 3=Time, 4=TimeWithSeconds
  switch (tickMarkType) {
    case 0:
      return yearFmt.format(d)
    case 1:
      return axisMonthFmt.format(d)
    case 2:
      return axisDateFmt.format(d)
    default:
      return axisTimeFmt.format(d)
  }
}

/** For crosshair tooltip — fuller "YYYY-MM-DD HH:mm" form. */
export function formatCrosshair(timestampSec: number): string {
  // Intl returns "DD/MM/YYYY, HH:mm" with en-GB. Reformat to "YYYY-MM-DD HH:mm".
  const parts = crosshairFmt.formatToParts(new Date(timestampSec * 1000))
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`
}

/** For the status bar live clock. */
export function formatClock(d: Date): string {
  const parts = clockFmt.formatToParts(d)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`
}

const offsetProbeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: DISPLAY_TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function casaOffsetMinutesAt(utcMs: number): number {
  const parts = offsetProbeFmt.formatToParts(new Date(utcMs))
  const get = (t: string) => +(parts.find((p) => p.type === t)?.value ?? '0')
  const casaAsIfUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return Math.round((casaAsIfUtc - utcMs) / 60000)
}

// Trading-session anchor: 22:00 Casablanca local = NY 17:00 (close) /
// Asia open boundary on the FX day clock. The algorithm "session day" runs
// from one 22:00 Casa to the next, so channel/EMA/strategy state resets
// at this fixed Casa hour regardless of what range the user loaded.
const SESSION_ANCHOR_HOUR_CASA = 22

/** UTC epoch seconds of the most recent 22:00 Casablanca-local time at or
 *  before `tSec`. DST-safe via the same Casa-offset helper as
 *  parseCasaLocalToUtcSec. */
export function casaSessionStartAtOrBefore(tSec: number): number {
  const offMin = casaOffsetMinutesAt(tSec * 1000)
  // Seconds since midnight in Casa local for the given instant.
  const casaSecOfDay = (((tSec + offMin * 60) % 86400) + 86400) % 86400
  const anchorSec = SESSION_ANCHOR_HOUR_CASA * 3600
  const backoff = casaSecOfDay >= anchorSec
    ? casaSecOfDay - anchorSec
    : casaSecOfDay + (86400 - anchorSec)
  return tSec - backoff
}

/** Parse a Casablanca-local "YYYY-MM-DD HH:MM" (or "YYYY-MM-DDTHH:MM") string to UTC epoch seconds.
 *  Returns null on malformed input. DST-safe via two-pass offset reconciliation. */
export function parseCasaLocalToUtcSec(s: string): number | null {
  const m = s.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{1,2}):(\d{2})$/)
  if (!m) return null
  const [, ys, mos, ds, hs, mis] = m
  const y = +ys, mo = +mos, d = +ds, h = +hs, mi = +mis
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h < 0 || h > 23 || mi < 0 || mi > 59) return null
  const guess = Date.UTC(y, mo - 1, d, h, mi)
  const off1 = casaOffsetMinutesAt(guess)
  let utcMs = guess - off1 * 60000
  const off2 = casaOffsetMinutesAt(utcMs)
  if (off2 !== off1) utcMs = guess - off2 * 60000
  return Math.floor(utcMs / 1000)
}
