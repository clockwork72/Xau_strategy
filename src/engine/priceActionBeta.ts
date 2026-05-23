import type { Candle } from '../types'
import type { Signal } from './strategy'

// Price Action Beta — "Second Entry" setup, driven by a state machine over
// swing highs. v0: empty stub. Logic will land in subsequent passes:
//   State 0: a new swing high forms
//   State 1: a bar fails to break the previous high (first correction)
//   State 2: a subsequent bar breaks the previous high → 2nd Entry trigger
//
// The EMA-cross placeholder in `strategy.ts` is preserved intact and can
// be swapped back into the sandbox if needed.
export function runPriceActionBeta(_candles: ReadonlyArray<Candle>): Signal[] {
  return []
}
