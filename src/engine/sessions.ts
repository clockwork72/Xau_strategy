// Session definitions match the user's Pine script — times are UTC, DST-agnostic.
// The 1-hour gap between NY close (21:00 UTC) and Asia open (22:00 UTC) is INTENTIONAL:
// it's the broker's daily settlement / market-closed window.
// Casablanca local view (UTC+1 most of the year):
//   Asia:    22:00 → 08:00 UTC  =  23:00 → 09:00 CASA
//   London:  07:00 → 16:00 UTC  =  08:00 → 17:00 CASA
//   NY:      12:00 → 21:00 UTC  =  13:00 → 22:00 CASA
//   Closed:  21:00 → 22:00 UTC  =  22:00 → 23:00 CASA  (no session, broker settlement)
//   Overlap: 12:00 → 16:00 UTC  =  13:00 → 17:00 CASA

import type { Candle } from '../types'
import type { UTCTimestamp } from 'lightweight-charts'

export type SessionId = 'asia' | 'london' | 'ny' | 'overlap'

export interface SessionDef {
  id: SessionId
  name: string
  startHourUtc: number
  endHourUtc: number
  bg: string
  border: string
  text: string
}

export const SESSION_DEFS: Record<SessionId, SessionDef> = {
  asia: {
    id: 'asia',
    name: 'ASIA',
    startHourUtc: 22,
    endHourUtc: 8,
    bg: 'rgba(38, 166, 154, 0.08)',
    border: 'rgba(38, 166, 154, 0.32)',
    text: 'rgba(38, 166, 154, 0.85)',
  },
  london: {
    id: 'london',
    name: 'LONDON',
    startHourUtc: 7,
    endHourUtc: 16,
    bg: 'rgba(66, 165, 245, 0.07)',
    border: 'rgba(66, 165, 245, 0.32)',
    text: 'rgba(66, 165, 245, 0.85)',
  },
  ny: {
    id: 'ny',
    name: 'NEW YORK',
    startHourUtc: 12,
    endHourUtc: 21,
    bg: 'rgba(171, 71, 188, 0.06)',
    border: 'rgba(171, 71, 188, 0.30)',
    text: 'rgba(171, 71, 188, 0.85)',
  },
  overlap: {
    id: 'overlap',
    name: 'LON / NY',
    startHourUtc: 12,
    endHourUtc: 16,
    bg: 'rgba(255, 179, 0, 0.07)',
    border: 'rgba(255, 179, 0, 0.35)',
    text: 'rgba(255, 179, 0, 0.85)',
  },
}

export interface SessionToggles {
  asia: boolean
  london: boolean
  ny: boolean
  overlap: boolean
}

export const DEFAULT_SESSION_TOGGLES: SessionToggles = {
  asia: true,
  london: true,
  ny: true,
  overlap: false,
}

export interface SessionRun {
  sessionId: SessionId
  startTime: UTCTimestamp
  endTime: UTCTimestamp
  startIndex: number
  endIndex: number
  high: number
  low: number
}

function isInSession(epochSec: number, sess: SessionDef): boolean {
  const hour = new Date(epochSec * 1000).getUTCHours()
  if (sess.startHourUtc < sess.endHourUtc) {
    return hour >= sess.startHourUtc && hour < sess.endHourUtc
  }
  // Cross-midnight (e.g. Asia 22→8): in session if hour is ≥start OR <end.
  return hour >= sess.startHourUtc || hour < sess.endHourUtc
}

/** Returns runs for enabled sessions only. */
export function computeSessionRuns(
  candles: Candle[],
  toggles: SessionToggles,
): SessionRun[] {
  const enabledIds: SessionId[] = []
  ;(['asia', 'london', 'ny', 'overlap'] as const).forEach((id) => {
    if (toggles[id]) enabledIds.push(id)
  })

  const runs: SessionRun[] = []
  for (const id of enabledIds) {
    const def = SESSION_DEFS[id]
    let inRun = false
    let startIdx = -1
    let runHi = -Infinity
    let runLo = Infinity

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i]
      const inside = isInSession(c.time as number, def)
      if (inside) {
        if (!inRun) {
          startIdx = i
          runHi = c.high
          runLo = c.low
          inRun = true
        } else {
          if (c.high > runHi) runHi = c.high
          if (c.low < runLo) runLo = c.low
        }
      } else if (inRun) {
        runs.push({
          sessionId: id,
          startTime: candles[startIdx].time,
          endTime: candles[i - 1].time,
          startIndex: startIdx,
          endIndex: i - 1,
          high: runHi,
          low: runLo,
        })
        inRun = false
      }
    }
    if (inRun) {
      runs.push({
        sessionId: id,
        startTime: candles[startIdx].time,
        endTime: candles[candles.length - 1].time,
        startIndex: startIdx,
        endIndex: candles.length - 1,
        high: runHi,
        low: runLo,
      })
    }
  }
  return runs
}
