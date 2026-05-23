import { useEffect, useMemo, useState } from 'react'
import type { DatasetBundle, Timeframe } from '../types'
import { buildM1Bundle, buildM5Bundle, loadCsv, MOCK_M1, MOCK_M5 } from '../data'

export type LoadStatus = 'loading' | 'real' | 'mock' | 'error'

export interface DatasetsState {
  timeframe: Timeframe
  setTimeframe: (tf: Timeframe) => void
  active: DatasetBundle
  data1m: DatasetBundle
  data5m: DatasetBundle
  loadStatus: LoadStatus
}

/**
 * Fetches the M1 and M5 CSVs once on mount, derives the active dataset from
 * the current timeframe, and surfaces a coarse load status. Mock data is used
 * as the initial value and as a fallback if the fetch fails.
 */
export function useDatasets(): DatasetsState {
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [data1m, setData1m] = useState<DatasetBundle>(MOCK_M1)
  const [data5m, setData5m] = useState<DatasetBundle>(MOCK_M5)
  const [loadStatus, setLoadStatus] = useState<LoadStatus>('loading')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [m1Rows, m5Rows] = await Promise.all([
          loadCsv('./data/xauusd_m1.csv'),
          loadCsv('./data/xauusd_m5.csv'),
        ])
        if (cancelled) return
        setData1m(buildM1Bundle(m1Rows))
        setData5m(buildM5Bundle(m5Rows, m1Rows))
        setLoadStatus('real')
      } catch (e) {
        console.warn('CSV load failed, using mock data:', e)
        if (!cancelled) setLoadStatus('mock')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const active = useMemo(() => (timeframe === '1m' ? data1m : data5m), [timeframe, data1m, data5m])

  return { timeframe, setTimeframe, active, data1m, data5m, loadStatus }
}
