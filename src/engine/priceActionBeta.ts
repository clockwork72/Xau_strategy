import type { Candle } from '../types'
import type { Signal } from './strategy'
import { TOUCH_PCT, extendChannelToTime, type ChannelMeta } from './trendlines'

const STOP_BUFFER_PCT = 0.0002
const RR = 3

interface OpenShort {
  entryTime: number
  entryPrice: number
  sl: number
  tp: number
  label: string
  channelLabel: string
}

export interface PABState {
  signals: Signal[]
  open: OpenShort | null
  tradeCount: number
  lastProcessedTime: number  // playhead time of the last evaluation; -1 = never
}

export const PAB_INITIAL_STATE: PABState = {
  signals: [],
  open: null,
  tradeCount: 0,
  lastProcessedTime: -1,
}

function isUpperWickRejection(c: Candle): boolean {
  const body = Math.abs(c.close - c.open)
  const upperWick = c.high - Math.max(c.open, c.close)
  return upperWick > body
}

function upperRailAt(meta: ChannelMeta, t: number): number {
  return extendChannelToTime(meta.channel, t).upperEnd
}

// Price Action Beta — short setups from rejections off the top rail of live,
// rising support channels while price is still above EMA(21). 1:3 RR with the
// stop pinned to the entry candle's high.
//
// Real-time / no-look-ahead: entries are evaluated ONLY on the playhead bar
// (the last bar of `candles`). Exits scan forward from the open trade's entry
// up to the playhead, using only price data (bar.high vs SL, bar.low vs TP) —
// no channel knowledge needed, so no bias. State persists across replay ticks
// via `prevState`; the caller (sandbox) holds it in a ref and resets it on
// TF/range/dataset/strategy-toggle changes.
//
// Idempotent: calling with the same playhead twice returns the same state.
// Backward-scrub: signals past the playhead are pruned; an open trade whose
// entry sits past the playhead is dropped.
export function runPriceActionBeta(
  candles: ReadonlyArray<Candle>,
  liveSupportChannels: ReadonlyArray<ChannelMeta>,
  ema21ByTime: Map<number, number>,
  prevState: PABState,
): PABState {
  if (candles.length === 0) return PAB_INITIAL_STATE

  const playheadBar = candles[candles.length - 1]
  const playheadTime = playheadBar.time as number

  // Backward-scrub guard: prune signals past playhead, drop stale open trade.
  let state = prevState
  if (prevState.lastProcessedTime > playheadTime) {
    const prunedSignals = prevState.signals.filter((s) => (s.time as number) <= playheadTime)
    const prunedOpen =
      prevState.open && prevState.open.entryTime <= playheadTime ? prevState.open : null
    state = {
      ...prevState,
      signals: prunedSignals,
      open: prunedOpen,
      lastProcessedTime: playheadTime,
    }
  }

  // Idempotency: if we already processed this playhead, no-op.
  if (state.lastProcessedTime === playheadTime) return state

  const midPrice = candles[Math.floor(candles.length / 2)].close
  const eps = midPrice * TOUCH_PCT
  const stopBuffer = midPrice * STOP_BUFFER_PCT

  // Exit scan: if a trade is open, walk every bar strictly after entryTime
  // up to and including the playhead. Stop at the first SL or TP hit.
  // Pure price data — no look-ahead.
  let open = state.open
  const newSignals: Signal[] = []
  let scanFromTime = Math.max(state.lastProcessedTime, open ? open.entryTime : -1)
  if (open) {
    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i]
      const t = bar.time as number
      if (t <= scanFromTime) continue
      if (t > playheadTime) break
      if (bar.high >= open.sl) {
        newSignals.push({ time: bar.time, side: 'buy', price: open.sl, label: open.label })
        console.log(
          `[strategy] exit label=${open.label} reason=stop price=${open.sl.toFixed(2)} at=${t}`,
        )
        open = null
        break
      }
      if (bar.low <= open.tp) {
        newSignals.push({ time: bar.time, side: 'buy', price: open.tp, label: open.label })
        console.log(
          `[strategy] exit label=${open.label} reason=target price=${open.tp.toFixed(2)} at=${t}`,
        )
        open = null
        break
      }
    }
  }

  // Entry evaluation: ONLY on the playhead bar. Never on historical bars.
  let tradeCount = state.tradeCount
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

        newSignals.push({ time: bar.time, side: 'sell', price: bar.close, label })
        console.log(
          `[strategy] entry label=${label} ch=${meta.label} close=${bar.close.toFixed(2)} rail=${rail.toFixed(2)} ema=${ema.toFixed(2)} SL=${sl.toFixed(2)} TP=${tp.toFixed(2)} R=${r.toFixed(2)}`,
        )

        open = { entryTime: t, entryPrice: bar.close, sl, tp, label, channelLabel: meta.label }
        break
      }
    }
  } else {
    // Trade still open at the playhead — informational skip-armed log if a
    // would-be setup is firing this bar. Throttle: one log per qualifying channel.
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

  return {
    signals: newSignals.length === 0 ? state.signals : [...state.signals, ...newSignals],
    open,
    tradeCount,
    lastProcessedTime: playheadTime,
  }
}
