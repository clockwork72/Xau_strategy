import type { Candle } from '../types'
import type { Signal } from './strategy'
import { TOUCH_PCT, extendChannelToTime, type ChannelMeta } from './trendlines'

const STOP_BUFFER_PCT = 0.0002
const RR = 3
// Minimum body share of the candle's total range. Excludes dojis and
// spinning-tops where `upper_wick > body` is satisfied trivially because
// the body itself is tiny (e.g. the M5 10:25 / 16:50 candles user flagged).
// A classic shooting-star rejection still passes — its body sits ~20-40%
// of the range with the upper wick taking the rest.
const MIN_BODY_TO_RANGE = 0.15
// Move SL to entry (breakeven) once MFE crosses this R-multiple. Saves
// the "worked then unworked" reversal — picked from the 2026-05-21→26
// trailing-stop sweep where +1R was the cutoff that salvaged PAB-4 and
// PAB-5 without choking any winners (full +3R runs never retraced past
// entry first on the sample). Set to 0 to disable.
const BE_TRIGGER_R = 1

interface OpenShort {
  entryTime: number
  entryPrice: number
  sl: number
  tp: number
  label: string
  channelLabel: string
}

// Single source of truth: `signals`. `open` and `tradeCount` are derived
// fresh from signals on every call — so pruning signals on backward scrub
// automatically cleans up both. No more ID inflation across replay sessions,
// no more phantom trades from dangling entry signals.
export interface PABState {
  signals: Signal[]
  lastProcessedTime: number // -1 = never processed
}

export const PAB_INITIAL_STATE: PABState = {
  signals: [],
  lastProcessedTime: -1,
}

function isUpperWickRejection(c: Candle): boolean {
  const range = c.high - c.low
  if (range <= 0) return false
  const body = Math.abs(c.close - c.open)
  if (body / range < MIN_BODY_TO_RANGE) return false // doji-ish, skip
  const upperWick = c.high - Math.max(c.open, c.close)
  return upperWick > body
}

function upperRailAt(meta: ChannelMeta, t: number): number {
  return extendChannelToTime(meta.channel, t).upperEnd
}

// The trailing unmatched sell (with full PAB metadata) is the open short.
// A buy signal closes any previous open. Any sell whose metadata is missing
// is treated as a no-op for open-tracking (defensive — shouldn't happen).
function deriveOpenFromSignals(signals: ReadonlyArray<Signal>): OpenShort | null {
  let open: OpenShort | null = null
  for (const s of signals) {
    if (s.side === 'sell') {
      if (s.sl === undefined || s.tp === undefined || s.label === undefined) {
        open = null
        continue
      }
      open = {
        entryTime: s.time as number,
        entryPrice: s.price,
        sl: s.sl,
        tp: s.tp,
        label: s.label,
        channelLabel: s.channelLabel ?? '?',
      }
    } else {
      open = null
    }
  }
  return open
}

function countTradesFromSignals(signals: ReadonlyArray<Signal>): number {
  let n = 0
  for (const s of signals) if (s.side === 'sell') n += 1
  return n
}

// Price Action Beta — short setups from rejections off the top rail of live,
// rising support channels while price is still above EMA(21). 1:3 RR with the
// stop pinned to the entry candle's high.
//
// Real-time / no-look-ahead: entries fire ONLY on the playhead bar. Exits scan
// forward from the open trade's entry up to the playhead using only price data
// (no channel knowledge → no bias when crossing skipped bars).
//
// Idempotent: same playhead twice → same state. Backward scrub: signals past
// the playhead are pruned; `open` and `tradeCount` are derived fresh from the
// pruned signals, so they self-correct.
export function runPriceActionBeta(
  candles: ReadonlyArray<Candle>,
  liveSupportChannels: ReadonlyArray<ChannelMeta>,
  ema21ByTime: Map<number, number>,
  prevState: PABState,
): PABState {
  if (candles.length === 0) return PAB_INITIAL_STATE

  const playheadBar = candles[candles.length - 1]
  const playheadTime = playheadBar.time as number

  // Idempotency: caller (e.g. StrictMode double-invoke) → no work.
  if (prevState.lastProcessedTime === playheadTime) return prevState

  // Backward-scrub: prune signals past the new playhead.
  let signals = prevState.signals
  if (prevState.lastProcessedTime > playheadTime) {
    signals = signals.filter((s) => (s.time as number) <= playheadTime)
  }

  // Derive open + tradeCount fresh — signals are the single source of truth.
  let open = deriveOpenFromSignals(signals)
  let tradeCount = countTradesFromSignals(signals)

  const midPrice = candles[Math.floor(candles.length / 2)].close
  const eps = midPrice * TOUCH_PCT
  const stopBuffer = midPrice * STOP_BUFFER_PCT

  const newSignals: Signal[] = []

  // Exit scan with breakeven management. We rescan from open.entryTime
  // each tick (cheap — a few dozen bars max) so the BE state is derived
  // statelessly from the bars themselves, mirroring how `open` is
  // derived from signals. Only NEW bars (t > lastProcessedTime) emit
  // signals/logs — past bars are walked silently to reconstruct state.
  //
  // Same-bar order matches real execution:
  //   1. high ≥ effectiveSL → exit at SL (current effective level)
  //   2. low ≤ TP → exit at TP
  //   3. low ≤ entry−1R AND BE not yet armed → move SL to entry
  // Step 3 applies to FUTURE bars only — a bar that triggers BE doesn't
  // also retroactively benefit from the moved SL on its own high.
  if (open) {
    const r = Math.abs(open.sl - open.entryPrice)
    const beTriggerPrice = open.entryPrice - BE_TRIGGER_R * r
    let effectiveSL = open.sl
    let beActive = false
    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]
      const t = bar.time as number
      if (t <= open.entryTime) continue
      if (t > playheadTime) break
      const isNew = t > prevState.lastProcessedTime
      if (bar.high >= effectiveSL) {
        if (isNew) {
          newSignals.push({
            time: bar.time,
            side: 'buy',
            price: effectiveSL,
            label: open.label,
            reason: 'stop',
          })
          console.log(
            `[strategy] exit label=${open.label} reason=stop${beActive ? '(BE)' : ''} price=${effectiveSL.toFixed(2)} at=${t}`,
          )
        }
        open = null
        break
      }
      if (bar.low <= open.tp) {
        if (isNew) {
          newSignals.push({
            time: bar.time,
            side: 'buy',
            price: open.tp,
            label: open.label,
            reason: 'target',
          })
          console.log(
            `[strategy] exit label=${open.label} reason=target price=${open.tp.toFixed(2)} at=${t}`,
          )
        }
        open = null
        break
      }
      if (BE_TRIGGER_R > 0 && !beActive && bar.low <= beTriggerPrice) {
        beActive = true
        effectiveSL = open.entryPrice
        if (isNew) {
          console.log(
            `[strategy] breakeven label=${open.label} sl→${effectiveSL.toFixed(2)} at=${t}`,
          )
        }
      }
    }
  }

  // Entry evaluation — ONLY on the playhead bar.
  if (!open) {
    const bar = playheadBar
    const t = playheadTime
    const ema = ema21ByTime.get(t)
    if (ema !== undefined && bar.close > ema && isUpperWickRejection(bar)) {
      for (const meta of liveSupportChannels) {
        if (t < meta.channel.startTime) continue
        const rail = upperRailAt(meta, t)
        if (Math.abs(bar.close - rail) > eps) continue

        tradeCount += 1
        const label = `PAB-${tradeCount}`
        const sl = bar.high + stopBuffer
        const r = sl - bar.close
        const tp = bar.close - RR * r

        newSignals.push({
          time: bar.time,
          side: 'sell',
          price: bar.close,
          label,
          sl,
          tp,
          channelLabel: meta.label,
        })
        console.log(
          `[strategy] entry label=${label} ch=${meta.label} close=${bar.close.toFixed(2)} rail=${rail.toFixed(2)} ema=${ema.toFixed(2)} SL=${sl.toFixed(2)} TP=${tp.toFixed(2)} R=${r.toFixed(2)}`,
        )

        open = { entryTime: t, entryPrice: bar.close, sl, tp, label, channelLabel: meta.label }
        break
      }
    }
  } else {
    // Informational skip-armed log — would-be setup while a trade is open.
    const ema = ema21ByTime.get(playheadTime)
    if (ema !== undefined && playheadBar.close > ema && isUpperWickRejection(playheadBar)) {
      for (const meta of liveSupportChannels) {
        if (playheadTime < meta.channel.startTime) continue
        const rail = upperRailAt(meta, playheadTime)
        if (Math.abs(playheadBar.close - rail) <= eps) {
          console.log(
            `[strategy] skip-armed ch=${meta.label} close=${playheadBar.close.toFixed(2)} rail=${rail.toFixed(2)} reason=already-short`,
          )
        }
      }
    }
  }

  const mergedSignals =
    newSignals.length === 0 && signals === prevState.signals
      ? prevState.signals
      : [...signals, ...newSignals]

  return {
    signals: mergedSignals,
    lastProcessedTime: playheadTime,
  }
}
