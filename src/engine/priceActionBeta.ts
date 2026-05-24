import type { Candle } from '../types'
import type { Signal } from './strategy'
import { TOUCH_PCT, extendChannelToTime, type ChannelMeta } from './trendlines'

const STOP_BUFFER_PCT = 0.0002
const RR = 3

interface OpenShort {
  entryIdx: number
  entryPrice: number
  sl: number
  tp: number
  label: string
  channelLabel: string
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
// stop pinned to the entry candle's high. One open position at a time; the
// exit scan is intrabar-pessimistic (stop wins on same-bar SL+TP collision).
//
// Output is paired sell+buy Signals — portfolio.ts pairs them unchanged.
export function runPriceActionBeta(
  candles: ReadonlyArray<Candle>,
  liveSupportChannels: ReadonlyArray<ChannelMeta>,
  ema21ByTime: Map<number, number>,
): Signal[] {
  if (candles.length === 0) return []

  const midPrice = candles[Math.floor(candles.length / 2)].close
  const eps = midPrice * TOUCH_PCT
  const stopBuffer = midPrice * STOP_BUFFER_PCT

  const signals: Signal[] = []
  let open: OpenShort | null = null
  let tradeCount = 0

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    const t = bar.time as number

    if (open) {
      if (i > open.entryIdx) {
        if (bar.high >= open.sl) {
          signals.push({ time: bar.time, side: 'buy', price: open.sl, label: open.label })
          console.log(
            `[strategy] exit label=${open.label} reason=stop price=${open.sl.toFixed(2)} bars=${i - open.entryIdx}`,
          )
          open = null
          continue
        }
        if (bar.low <= open.tp) {
          signals.push({ time: bar.time, side: 'buy', price: open.tp, label: open.label })
          console.log(
            `[strategy] exit label=${open.label} reason=target price=${open.tp.toFixed(2)} bars=${i - open.entryIdx}`,
          )
          open = null
          continue
        }
      }
      if (open) {
        const ema = ema21ByTime.get(t)
        if (ema !== undefined && bar.close > ema && isUpperWickRejection(bar)) {
          for (const meta of liveSupportChannels) {
            if (t < meta.channel.startTime) continue
            const rail = upperRailAt(meta, t)
            if (Math.abs(bar.close - rail) <= eps) {
              console.log(
                `[strategy] skip-armed ch=${meta.label} close=${bar.close.toFixed(2)} rail=${rail.toFixed(2)} reason=already-short`,
              )
            }
          }
        }
        continue
      }
    }

    const ema = ema21ByTime.get(t)
    if (ema === undefined) continue
    if (bar.close <= ema) continue
    if (!isUpperWickRejection(bar)) continue

    for (const meta of liveSupportChannels) {
      if (t < meta.channel.startTime) continue
      const rail = upperRailAt(meta, t)
      if (Math.abs(bar.close - rail) > eps) continue

      tradeCount += 1
      const label = `PAB-${tradeCount}`
      const sl = bar.high + stopBuffer
      const r = sl - bar.close
      const tp = bar.close - RR * r

      signals.push({ time: bar.time, side: 'sell', price: bar.close, label })
      console.log(
        `[strategy] entry label=${label} ch=${meta.label} close=${bar.close.toFixed(2)} rail=${rail.toFixed(2)} ema=${ema.toFixed(2)} SL=${sl.toFixed(2)} TP=${tp.toFixed(2)} R=${r.toFixed(2)}`,
      )

      open = { entryIdx: i, entryPrice: bar.close, sl, tp, label, channelLabel: meta.label }
      break
    }
  }

  return signals
}
