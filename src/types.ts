import type { CandlestickData, UTCTimestamp } from 'lightweight-charts'

export type Candle = CandlestickData<UTCTimestamp> & { tickVolume: number }
export type CvdCandle = CandlestickData<UTCTimestamp>
export type Timeframe = '1m' | '5m'

export interface DatasetBundle {
  candles: Candle[]
  cvd: CvdCandle[]
}
