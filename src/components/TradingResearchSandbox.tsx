import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'

import { theme, fonts, sizes } from '../theme'
import type { Candle, CvdCandle, DatasetBundle, Timeframe } from '../types'
import { loadCsv, MOCK_M1, MOCK_M5, rowsToBundle } from '../data'
import { computeEma } from '../engine/indicators'
import { runPriceActionBeta } from '../engine/priceActionBeta'
import { computeStats } from '../engine/portfolio'
import { findSwingHighs, findSwingLows } from '../engine/swings'
import { pickChannels } from '../engine/trendlines'
import type { SessionToggles } from '../engine/sessions'
import { formatAxisTick, formatCrosshair, parseCasaLocalToUtcSec } from '../util/time'

const DEFAULT_RANGE_START_CASA = '2026-05-21 00:00'
const DEFAULT_RANGE_END_CASA = '2026-05-21 20:00'
const DEFAULT_RANGE = {
  from: parseCasaLocalToUtcSec(DEFAULT_RANGE_START_CASA)!,
  to: parseCasaLocalToUtcSec(DEFAULT_RANGE_END_CASA)!,
}

// Lookback for swing-high detection. Smaller → more pivots → more touch
// candidates for the scoring algorithm; trades responsiveness for noise.
const TRENDLINE_LOOKBACK = 7

/**
 * Largest index `i` such that `window[i].time <= t`.
 * - t === null → window.length - 1 (default: show everything)
 * - t before window start → 0
 * - t after window end → window.length - 1
 */
function findIndexForTime(window: ReadonlyArray<Candle>, t: number | null): number {
  const n = window.length
  if (n === 0) return 0
  if (t === null) return n - 1
  if ((window[0].time as number) > t) return 0
  if ((window[n - 1].time as number) <= t) return n - 1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if ((window[mid].time as number) <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

import TopBar from './TopBar'
import LeftNav from './LeftNav'
import RightPanels from './RightPanels'
import StatusBar from './StatusBar'
import SessionOverlay from './SessionOverlay'

// --------------------------------------------------------------------
//   Component
// --------------------------------------------------------------------
export default function TradingResearchSandbox() {
  // ---------- chart refs ----------
  const priceContainerRef = useRef<HTMLDivElement | null>(null)
  const cvdContainerRef = useRef<HTMLDivElement | null>(null)
  const priceChartRef = useRef<IChartApi | null>(null)
  const cvdChartRef = useRef<IChartApi | null>(null)
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const cvdSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  // Pool of LineSeries pairs (resistance + support) — grows on demand,
  // one pair per detected channel. History entries get a faded color.
  const channelsSeriesPoolRef = useRef<Array<{
    res: ISeriesApi<'Line'>
    sup: ISeriesApi<'Line'>
  }>>([])
  // Pool of LineSeries for user-drawn lines.
  const drawnSeriesPoolRef = useRef<ISeriesApi<'Line'>[]>([])
  // Working anchor (waiting for the second click).
  const drawWorkingRef = useRef<{ time: number; price: number } | null>(null)
  // Mirror of drawModeEnabled so the click handler sees the latest value
  // without re-subscribing on every toggle.
  const drawModeEnabledRef = useRef(false)

  // ---------- incremental-render bookkeeping ----------
  // Track last-rendered length + end time per series so we can call
  // series.update(newBar) on a +1 forward step (cheap) instead of setData
  // on the whole slice (expensive at 10×/60× playback).
  const lastCandleLenRef = useRef(0)
  const lastCandleEndRef = useRef<number | null>(null)
  const lastCvdLenRef = useRef(0)
  const lastCvdEndRef = useRef<number | null>(null)
  const lastEmaLenRef = useRef(0)
  const lastEmaEndRef = useRef<number | null>(null)
  const lastEmaSettingsRef = useRef<{ length: number; enabled: boolean }>({ length: 0, enabled: false })

  // ---------- data state ----------
  const [timeframe, setTimeframe] = useState<Timeframe>('1m')
  const [data1m, setData1m] = useState<DatasetBundle>(MOCK_M1)
  const [data5m, setData5m] = useState<DatasetBundle>(MOCK_M5)
  const [loadStatus, setLoadStatus] = useState<'loading' | 'real' | 'mock' | 'error'>('loading')

  const active = timeframe === '1m' ? data1m : data5m

  // ---------- ui state ----------
  const [hoveredTime, setHoveredTime] = useState<number | null>(null)
  const [sessionsEnabled, setSessionsEnabled] = useState(true)
  const sessionToggles = useMemo<SessionToggles>(
    () => ({ asia: sessionsEnabled, london: sessionsEnabled, ny: sessionsEnabled, overlap: false }),
    [sessionsEnabled],
  )
  const showSessionLabels = sessionsEnabled
  const [emaEnabled, setEmaEnabled] = useState(true)
  const [emaLength, setEmaLength] = useState(21)
  const [trendlineEnabled, setTrendlineEnabled] = useState(true)
  const [drawModeEnabled, setDrawModeEnabled] = useState(false)
  const [drawnLines, setDrawnLines] = useState<
    Array<{ t1: number; p1: number; t2: number; p2: number }>
  >([])
  const [strategyEnabled, setStrategyEnabled] = useState(true)
  const [lotSize, setLotSize] = useState(0.01)
  const [startingBalance, setStartingBalance] = useState(100)
  const [appliedRange, setAppliedRange] = useState<{ from: number; to: number } | null>(DEFAULT_RANGE)
  const [replayPlaying, setReplayPlaying] = useState(false)
  // Time anchor for replay playhead (UTC sec). null = "show everything"
  // default. Tracking time (not index) makes TF switches seamless: the
  // derived index recomputes against whichever TF's bar grid is active.
  const [replayPlayheadTime, setReplayPlayheadTime] = useState<number | null>(null)
  const [replaySpeed, setReplaySpeed] = useState(4) // bars per second
  // Force SessionOverlay to remount/re-read refs once charts exist.
  const [chartsReady, setChartsReady] = useState(false)

  // ---------- replay slicing ----------
  const replayWindow = useMemo<Candle[]>(() => {
    if (!appliedRange) return active.candles
    return active.candles.filter(
      (c) => (c.time as number) >= appliedRange.from && (c.time as number) <= appliedRange.to,
    )
  }, [active.candles, appliedRange])

  const replayCvdWindow = useMemo<CvdCandle[]>(() => {
    if (!appliedRange) return active.cvd
    return active.cvd.filter(
      (c) => (c.time as number) >= appliedRange.from && (c.time as number) <= appliedRange.to,
    )
  }, [active.cvd, appliedRange])

  // Derived index from the time anchor — TF switch reuses the same time and
  // gets a fresh index against the new bar grid.
  const replayPlayhead = useMemo(
    () => findIndexForTime(replayWindow, replayPlayheadTime),
    [replayWindow, replayPlayheadTime],
  )

  // appliedRange change → clear anchor (re-defaults to "show everything")
  // and pause. This is a fresh-start gesture; TF switch is NOT this.
  useEffect(() => {
    setReplayPlayheadTime(null)
    setReplayPlaying(false)
  }, [appliedRange])

  // On window change (TF switch or data load): if the anchor falls outside
  // the new window's time range, snap it to the last bar and pause. Anchor
  // *inside* the range is preserved, so TF switching is seamless.
  useEffect(() => {
    if (replayPlayheadTime === null) return
    if (replayWindow.length === 0) return
    const firstTime = replayWindow[0].time as number
    const lastTime = replayWindow[replayWindow.length - 1].time as number
    if (replayPlayheadTime < firstTime || replayPlayheadTime > lastTime) {
      setReplayPlayheadTime(lastTime)
      setReplayPlaying(false)
    }
  }, [replayWindow, replayPlayheadTime])

  const visibleCandles = useMemo<Candle[]>(() => {
    if (replayWindow.length === 0) return []
    const end = Math.min(replayPlayhead + 1, replayWindow.length)
    return replayWindow.slice(0, end)
  }, [replayWindow, replayPlayhead])

  const visibleCvd = useMemo<CvdCandle[]>(() => {
    if (visibleCandles.length === 0) return []
    const cutoff = visibleCandles[visibleCandles.length - 1].time as number
    return replayCvdWindow.filter((c) => (c.time as number) <= cutoff)
  }, [replayCvdWindow, visibleCandles])

  // Read latest playheadTime inside the interval without re-subscribing each
  // tick — keeping replayPlayheadTime out of the deps below.
  const playheadTimeRef = useRef<number | null>(replayPlayheadTime)
  playheadTimeRef.current = replayPlayheadTime

  // playback tick — advance the time anchor to the next bar in the window
  useEffect(() => {
    if (!replayPlaying) return
    if (replayWindow.length === 0) return
    const intervalMs = Math.max(16, Math.round(1000 / Math.max(1, replaySpeed)))
    const id = window.setInterval(() => {
      const currentIdx = findIndexForTime(replayWindow, playheadTimeRef.current)
      if (currentIdx >= replayWindow.length - 1) {
        setReplayPlaying(false)
        return
      }
      setReplayPlayheadTime(replayWindow[currentIdx + 1].time as number)
    }, intervalMs)
    return () => window.clearInterval(id)
  }, [replayPlaying, replaySpeed, replayWindow])

  // keyboard shortcuts: Space play/pause, ←/→ step (Shift = 10),
  // Home reset, End jump to window end. Skipped while typing in an input.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (replayWindow.length === 0) return
      const max = replayWindow.length - 1
      const stepTo = (delta: number) => {
        const idx = findIndexForTime(replayWindow, playheadTimeRef.current)
        const next = Math.max(0, Math.min(max, idx + delta))
        setReplayPlaying(false)
        setReplayPlayheadTime(replayWindow[next].time as number)
      }
      switch (e.key) {
        case ' ':
          e.preventDefault()
          setReplayPlaying((p) => !p)
          return
        case 'ArrowLeft':
          e.preventDefault()
          stepTo(e.shiftKey ? -10 : -1)
          return
        case 'ArrowRight':
          e.preventDefault()
          stepTo(e.shiftKey ? 10 : 1)
          return
        case 'Home':
          e.preventDefault()
          setReplayPlaying(false)
          setReplayPlayheadTime(replayWindow[0].time as number)
          return
        case 'End':
          e.preventDefault()
          setReplayPlaying(false)
          setReplayPlayheadTime(replayWindow[max].time as number)
          return
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [replayWindow])

  // ---------- logging for the session.log bridge ----------
  const prevPlayingRef = useRef(false)
  useEffect(() => {
    const t = playheadTimeRef.current
    const tStr = t !== null ? formatCrosshair(t) : 'unknown'
    if (replayPlaying && !prevPlayingRef.current) {
      // eslint-disable-next-line no-console
      console.log(`[replay] play from ${tStr}`)
    } else if (!replayPlaying && prevPlayingRef.current) {
      // eslint-disable-next-line no-console
      console.log(`[replay] pause at ${tStr}`)
    }
    prevPlayingRef.current = replayPlaying
  }, [replayPlaying])

  useEffect(() => {
    // eslint-disable-next-line no-console
    console.log(`[replay] speed ${replaySpeed}×`)
  }, [replaySpeed])

  useEffect(() => {
    if (!appliedRange) {
      // eslint-disable-next-line no-console
      console.log('[replay] range cleared')
    } else {
      // eslint-disable-next-line no-console
      console.log(`[replay] range ${formatCrosshair(appliedRange.from)} → ${formatCrosshair(appliedRange.to)}`)
    }
  }, [appliedRange])

  // ---------- lookup map for hover → candle ----------
  const candleByTime = useMemo(() => {
    const m = new Map<number, Candle>()
    for (const c of active.candles) m.set(c.time as number, c)
    return m
  }, [active])
  const hoveredCandle = hoveredTime === null ? null : candleByTime.get(hoveredTime) ?? null

  // ---------- load CSVs once ----------
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [m1Rows, m5Rows] = await Promise.all([
          loadCsv('./data/xauusd_m1.csv'),
          loadCsv('./data/xauusd_m5.csv'),
        ])
        if (cancelled) return
        setData1m(rowsToBundle(m1Rows))
        setData5m(rowsToBundle(m5Rows))
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

  // ---------- create charts (once) ----------
  useEffect(() => {
    if (!priceContainerRef.current || !cvdContainerRef.current) return

    const commonOpts = {
      layout: {
        background: { color: theme.panel },
        textColor: theme.text,
        fontSize: 11,
        fontFamily: fonts.sans,
      },
      grid: {
        vertLines: { color: theme.border, style: LineStyle.Dotted },
        horzLines: { color: theme.border, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: theme.border },
      localization: {
        timeFormatter: (t: Time) => formatCrosshair(t as number),
      },
      timeScale: {
        borderColor: theme.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, tickMarkType: number) =>
          formatAxisTick(time as number, tickMarkType),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: theme.borderStrong,
          width: 1 as const,
          style: LineStyle.Solid,
          labelBackgroundColor: theme.borderStrong,
        },
        horzLine: {
          color: theme.borderStrong,
          width: 1 as const,
          style: LineStyle.Solid,
          labelBackgroundColor: theme.borderStrong,
        },
      },
      handleScroll: true,
      handleScale: true,
    }

    const priceChart = createChart(priceContainerRef.current, {
      ...commonOpts,
      width: priceContainerRef.current.clientWidth,
      height: priceContainerRef.current.clientHeight,
    })
    const cvdChart = createChart(cvdContainerRef.current, {
      ...commonOpts,
      width: cvdContainerRef.current.clientWidth,
      height: cvdContainerRef.current.clientHeight,
    })

    priceChart.applyOptions({ timeScale: { visible: false } })

    const candle = priceChart.addCandlestickSeries({
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    })

    const ema = priceChart.addLineSeries({
      color: theme.warn,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    })

    const cvd = cvdChart.addCandlestickSeries({
      upColor: theme.up,
      downColor: theme.down,
      borderUpColor: theme.up,
      borderDownColor: theme.down,
      wickUpColor: theme.up,
      wickDownColor: theme.down,
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    })

    cvd.createPriceLine({
      price: 0,
      color: theme.textInactive,
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: false,
      title: '',
    })

    priceChartRef.current = priceChart
    cvdChartRef.current = cvdChart
    candleSeriesRef.current = candle
    cvdSeriesRef.current = cvd
    emaSeriesRef.current = ema
    setChartsReady(true)

    // ----- sync time scales -----
    let syncing = false
    const onPriceRange = (r: LogicalRange | null) => {
      if (syncing || !r) return
      syncing = true
      cvdChart.timeScale().setVisibleLogicalRange(r)
      syncing = false
    }
    const onCvdRange = (r: LogicalRange | null) => {
      if (syncing || !r) return
      syncing = true
      priceChart.timeScale().setVisibleLogicalRange(r)
      syncing = false
    }
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(onPriceRange)
    cvdChart.timeScale().subscribeVisibleLogicalRangeChange(onCvdRange)

    // ----- sync crosshair + push hovered time up to state -----
    // setCrosshairPosition throws "Value is null" when the target series has
    // no data (transient during setData([]) on timeframe switch), so we guard
    // on the source candle existing and try/catch as defense.
    const syncFromPrice = (param: MouseEventParams) => {
      const v =
        param.time !== undefined
          ? (param.seriesData.get(candle) as CandlestickData<UTCTimestamp> | undefined)
          : undefined
      if (!param.time || !v) {
        cvdChart.clearCrosshairPosition()
        setHoveredTime(null)
        return
      }
      setHoveredTime(param.time as number)
      const target = cvdSeriesRef.current
      if (!target) return
      try {
        cvdChart.setCrosshairPosition(v.close, param.time, target)
      } catch {
        /* target series may be empty mid-update — ignore */
      }
    }
    const syncFromCvd = (param: MouseEventParams) => {
      const v =
        param.time !== undefined
          ? (param.seriesData.get(cvd) as CandlestickData<UTCTimestamp> | undefined)
          : undefined
      if (!param.time || !v) {
        priceChart.clearCrosshairPosition()
        setHoveredTime(null)
        return
      }
      setHoveredTime(param.time as number)
      const target = candleSeriesRef.current
      if (!target) return
      try {
        priceChart.setCrosshairPosition(v.close, param.time, target)
      } catch {
        /* target series may be empty mid-update — ignore */
      }
    }
    priceChart.subscribeCrosshairMove(syncFromPrice)
    cvdChart.subscribeCrosshairMove(syncFromCvd)

    // ----- draw mode: 2 clicks → log + render a line on price chart -----
    const onPriceClick = (param: MouseEventParams) => {
      if (!drawModeEnabledRef.current) return
      const series = candleSeriesRef.current
      if (!series || !param.point) return
      // Time: from the bar under cursor, falling back to time scale lookup
      let time: number | null = null
      if (param.time !== undefined) {
        time = param.time as number
      } else {
        const t = priceChart.timeScale().coordinateToTime(param.point.x)
        if (typeof t === 'number') time = t
      }
      if (time === null) return
      const price = series.coordinateToPrice(param.point.y)
      if (price === null) return

      if (drawWorkingRef.current === null) {
        drawWorkingRef.current = { time, price }
        // eslint-disable-next-line no-console
        console.log(`[draw] anchor1 t=${formatCrosshair(time)} p=${price.toFixed(3)}`)
        return
      }
      const a = drawWorkingRef.current
      const b = { time, price }
      drawWorkingRef.current = null
      const dt = b.time - a.time
      const dp = b.price - a.price
      // eslint-disable-next-line no-console
      console.log(
        `[draw] line a=${formatCrosshair(a.time)}@${a.price.toFixed(3)} b=${formatCrosshair(b.time)}@${b.price.toFixed(3)} dt=${dt}s dp=${dp.toFixed(3)} slope/h=${((dp / dt) * 3600).toFixed(3)}`,
      )
      setDrawnLines((lines) => [
        ...lines,
        { t1: a.time, p1: a.price, t2: b.time, p2: b.price },
      ])
    }
    priceChart.subscribeClick(onPriceClick)

    const ro = new ResizeObserver(() => {
      if (priceContainerRef.current) {
        priceChart.applyOptions({
          width: priceContainerRef.current.clientWidth,
          height: priceContainerRef.current.clientHeight,
        })
      }
      if (cvdContainerRef.current) {
        cvdChart.applyOptions({
          width: cvdContainerRef.current.clientWidth,
          height: cvdContainerRef.current.clientHeight,
        })
      }
    })
    ro.observe(priceContainerRef.current)
    ro.observe(cvdContainerRef.current)

    return () => {
      ro.disconnect()
      priceChart.timeScale().unsubscribeVisibleLogicalRangeChange(onPriceRange)
      cvdChart.timeScale().unsubscribeVisibleLogicalRangeChange(onCvdRange)
      priceChart.unsubscribeCrosshairMove(syncFromPrice)
      cvdChart.unsubscribeCrosshairMove(syncFromCvd)
      priceChart.unsubscribeClick(onPriceClick)
      priceChart.remove()
      cvdChart.remove()
      priceChartRef.current = null
      cvdChartRef.current = null
      candleSeriesRef.current = null
      cvdSeriesRef.current = null
      emaSeriesRef.current = null
      channelsSeriesPoolRef.current = []
      drawnSeriesPoolRef.current = []
      setChartsReady(false)
    }
  }, [])

  // ---------- push visible (replay-aware) dataset to chart ----------
  // Incremental: on a +1 forward step (play / step+ / keyboard right) we
  // call series.update(lastBar). Any other change (scrub, reset, end,
  // timeframe switch, range change, data load) → full setData.
  useEffect(() => {
    const cs = candleSeriesRef.current
    if (!cs) return
    const newLen = visibleCandles.length
    const newEnd = newLen > 0 ? (visibleCandles[newLen - 1].time as number) : null
    const prevLen = lastCandleLenRef.current
    const prevEnd = lastCandleEndRef.current
    const isForwardStep =
      newLen === prevLen + 1 &&
      prevLen > 0 &&
      newLen > 1 &&
      (visibleCandles[newLen - 2].time as number) === prevEnd
    if (isForwardStep) {
      cs.update(visibleCandles[newLen - 1])
    } else {
      cs.setData(visibleCandles)
    }
    lastCandleLenRef.current = newLen
    lastCandleEndRef.current = newEnd
  }, [visibleCandles, chartsReady])

  useEffect(() => {
    const xs = cvdSeriesRef.current
    if (!xs) return
    const newLen = visibleCvd.length
    const newEnd = newLen > 0 ? (visibleCvd[newLen - 1].time as number) : null
    const prevLen = lastCvdLenRef.current
    const prevEnd = lastCvdEndRef.current
    const isForwardStep =
      newLen === prevLen + 1 &&
      prevLen > 0 &&
      newLen > 1 &&
      (visibleCvd[newLen - 2].time as number) === prevEnd
    if (isForwardStep) {
      xs.update(visibleCvd[newLen - 1])
    } else {
      xs.setData(visibleCvd)
    }
    lastCvdLenRef.current = newLen
    lastCvdEndRef.current = newEnd
  }, [visibleCvd, chartsReady])

  // ---------- EMA: visibility ----------
  useEffect(() => {
    const ema = emaSeriesRef.current
    if (!ema) return
    ema.applyOptions({ visible: emaEnabled })
  }, [emaEnabled, chartsReady])

  // ---------- EMA: data ----------
  useEffect(() => {
    const ema = emaSeriesRef.current
    if (!ema) return
    if (!emaEnabled) {
      ema.setData([])
      lastEmaLenRef.current = 0
      lastEmaEndRef.current = null
      lastEmaSettingsRef.current = { length: emaLength, enabled: false }
      return
    }
    const newLen = visibleCandles.length
    const newEnd = newLen > 0 ? (visibleCandles[newLen - 1].time as number) : null
    const prevLen = lastEmaLenRef.current
    const prevEnd = lastEmaEndRef.current
    const prevSettings = lastEmaSettingsRef.current
    const settingsUnchanged = prevSettings.enabled && prevSettings.length === emaLength
    const isForwardStep =
      settingsUnchanged &&
      newLen === prevLen + 1 &&
      prevLen > 0 &&
      newLen > 1 &&
      (visibleCandles[newLen - 2].time as number) === prevEnd

    const points = computeEma(visibleCandles, emaLength)
    if (isForwardStep) {
      const last = points[points.length - 1]
      if (last) ema.update(last as { time: Time; value: number })
    } else {
      ema.setData(points as { time: Time; value: number }[])
    }
    lastEmaLenRef.current = newLen
    lastEmaEndRef.current = newEnd
    lastEmaSettingsRef.current = { length: emaLength, enabled: true }
  }, [visibleCandles, emaLength, emaEnabled, chartsReady])

  // ---------- Trendline channels: touch-scored across all pivot pairs.
  // pickChannels returns distinct non-overlapping channels with ≥3 touches.
  useEffect(() => {
    const chart = priceChartRef.current
    if (!chart) return
    const pool = channelsSeriesPoolRef.current

    const clearAll = () => {
      for (const p of pool) {
        p.res.setData([])
        p.sup.setData([])
      }
    }

    if (!trendlineEnabled || visibleCandles.length === 0) {
      clearAll()
      return
    }
    const highs = findSwingHighs(visibleCandles, TRENDLINE_LOOKBACK)
    const lows = findSwingLows(visibleCandles, TRENDLINE_LOOKBACK)
    const channels = [
      ...pickChannels(highs, visibleCandles, 'resistance'),
      ...pickChannels(lows, visibleCandles, 'support'),
    ]
    // ---- DISABLED: cross-kind non-overlap (keeps broader, drops smaller) ----
    // Re-enable by replacing the merge above with this block:
    //
    // const allCandidates = [
    //   ...pickChannels(highs, visibleCandles, 'resistance'),
    //   ...pickChannels(lows, visibleCandles, 'support'),
    // ]
    // const sorted = [...allCandidates].sort(
    //   (a, b) => b.endTime - b.startTime - (a.endTime - a.startTime),
    // )
    // const channels: typeof allCandidates = []
    // const acceptedRanges: Array<[number, number]> = []
    // for (const c of sorted) {
    //   const overlaps = acceptedRanges.some(
    //     ([s, e]) => !(c.endTime < s || c.startTime > e),
    //   )
    //   if (!overlaps) {
    //     channels.push(c)
    //     acceptedRanges.push([c.startTime, c.endTime])
    //   }
    // }
    // ---- /DISABLED ----
    if (channels.length === 0) {
      clearAll()
      return
    }

    // Grow pool to fit channel count.
    while (pool.length < channels.length) {
      pool.push({
        res: chart.addLineSeries({
          color: theme.accent,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
        sup: chart.addLineSeries({
          color: theme.accent,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
      })
    }

    for (let i = 0; i < channels.length; i++) {
      const ch = channels[i]
      pool[i].res.setData([
        { time: ch.startTime as Time, value: ch.upperStart },
        { time: ch.endTime as Time, value: ch.upperEnd },
      ])
      pool[i].sup.setData([
        { time: ch.startTime as Time, value: ch.lowerStart },
        { time: ch.endTime as Time, value: ch.lowerEnd },
      ])
    }

    // Hide unused pool entries.
    for (let i = channels.length; i < pool.length; i++) {
      pool[i].res.setData([])
      pool[i].sup.setData([])
    }
  }, [visibleCandles, trendlineEnabled, chartsReady])

  // Mirror draw mode + clear pending anchor when toggled off.
  useEffect(() => {
    drawModeEnabledRef.current = drawModeEnabled
    if (!drawModeEnabled) drawWorkingRef.current = null
  }, [drawModeEnabled])

  // Render user-drawn lines as yellow LineSeries on the price chart.
  useEffect(() => {
    const chart = priceChartRef.current
    if (!chart) return
    const pool = drawnSeriesPoolRef.current
    while (pool.length < drawnLines.length) {
      pool.push(
        chart.addLineSeries({
          color: theme.warn,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
      )
    }
    for (let i = 0; i < drawnLines.length; i++) {
      const l = drawnLines[i]
      const [first, second] =
        l.t1 <= l.t2 ? [{ t: l.t1, v: l.p1 }, { t: l.t2, v: l.p2 }] : [{ t: l.t2, v: l.p2 }, { t: l.t1, v: l.p1 }]
      pool[i].setData([
        { time: first.t as Time, value: first.v },
        { time: second.t as Time, value: second.v },
      ])
    }
    for (let i = drawnLines.length; i < pool.length; i++) {
      pool[i].setData([])
    }
  }, [drawnLines, chartsReady])

  // ---------- Strategy signals (computed on the visible slice only) ----------
  const signals = useMemo(
    () => (strategyEnabled ? runPriceActionBeta(visibleCandles) : []),
    [visibleCandles, strategyEnabled],
  )

  // ---------- Strategy stats (winrate, PnL, equity, open position) ----------
  const markPrice = visibleCandles.length > 0 ? visibleCandles[visibleCandles.length - 1].close : null
  const strategyStats = useMemo(
    () => computeStats(signals, lotSize, startingBalance, markPrice),
    [signals, lotSize, startingBalance, markPrice],
  )

  useEffect(() => {
    const cs = candleSeriesRef.current
    if (!cs) return
    const markers: SeriesMarker<Time>[] = signals.map((s) => ({
      time: s.time,
      position: s.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: s.side === 'buy' ? theme.up : theme.down,
      shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: s.label,
    }))
    cs.setMarkers(markers)
  }, [signals, chartsReady])

  // ---------- re-apply pinned range after timeframe / dataset switch ----------
  useEffect(() => {
    if (!appliedRange) return
    const chart = priceChartRef.current
    if (!chart) return
    const id = requestAnimationFrame(() => {
      chart.timeScale().setVisibleRange({
        from: appliedRange.from as Time,
        to: appliedRange.to as Time,
      })
    })
    return () => cancelAnimationFrame(id)
  }, [active, appliedRange, chartsReady])

  // ---------- handlers ----------
  const handleRangeJump = (fromSec: number, toSec: number) => {
    setAppliedRange({ from: fromSec, to: toSec })
    const chart = priceChartRef.current
    if (!chart) return
    chart.timeScale().setVisibleRange({ from: fromSec as Time, to: toSec as Time })
  }

  const handleRangeFit = () => {
    setAppliedRange(null)
    const chart = priceChartRef.current
    if (!chart) return
    chart.timeScale().fitContent()
  }

  const replayMax = Math.max(0, replayWindow.length - 1)
  const handleReplayPlayPause = () => {
    if (replayWindow.length === 0) return
    setReplayPlaying((p) => !p)
  }
  const handleReplayStep = (delta: number) => {
    if (replayWindow.length === 0) return
    setReplayPlaying(false)
    const next = Math.max(0, Math.min(replayMax, replayPlayhead + delta))
    setReplayPlayheadTime(replayWindow[next].time as number)
    // eslint-disable-next-line no-console
    console.log(`[replay] step ${delta > 0 ? '+' : ''}${delta} → ${formatCrosshair(replayWindow[next].time as number)} (idx ${next}/${replayMax})`)
  }
  const handleReplayReset = () => {
    if (replayWindow.length === 0) return
    setReplayPlaying(false)
    setReplayPlayheadTime(replayWindow[0].time as number)
    // eslint-disable-next-line no-console
    console.log(`[replay] reset → ${formatCrosshair(replayWindow[0].time as number)}`)
  }
  const handleReplayScrub = (idx: number) => {
    if (replayWindow.length === 0) return
    setReplayPlaying(false)
    const clamped = Math.max(0, Math.min(replayMax, Math.round(idx)))
    setReplayPlayheadTime(replayWindow[clamped].time as number)
    // eslint-disable-next-line no-console
    console.log(`[replay] scrub → ${formatCrosshair(replayWindow[clamped].time as number)} (idx ${clamped}/${replayMax})`)
  }

  // ---------- derived ----------
  const statusText = useMemo(() => {
    if (loadStatus === 'loading') return 'Loading data'
    if (loadStatus === 'mock') return 'Mock data · CSV load failed'
    if (loadStatus === 'error') return 'Load error'
    const n = active.candles.length
    return `${n.toLocaleString()} bars loaded`
  }, [loadStatus, active])

  // --------------------------------------------------------------------
  return (
    <div style={styles.root}>
      <TopBar
        timeframe={timeframe}
        onTimeframeChange={setTimeframe}
        status={{ kind: loadStatus, text: statusText }}
        replayPlaying={replayPlaying}
        onReplayPlayPause={handleReplayPlayPause}
        onReplayStep={handleReplayStep}
        onReplayReset={handleReplayReset}
        onReplayScrub={handleReplayScrub}
        replayPlayhead={replayPlayhead}
        replayMax={replayMax}
        replaySpeed={replaySpeed}
        onReplaySpeedChange={setReplaySpeed}
        replayNowSec={replayWindow[replayPlayhead]?.time as number | undefined}
      />

      <div style={styles.middle}>
        <LeftNav
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          onRangeJump={handleRangeJump}
          onRangeFit={handleRangeFit}
          initialRangeStart={DEFAULT_RANGE_START_CASA}
          initialRangeEnd={DEFAULT_RANGE_END_CASA}
          emaEnabled={emaEnabled}
          onEmaEnabledChange={setEmaEnabled}
          emaLength={emaLength}
          onEmaLengthChange={setEmaLength}
          sessionsEnabled={sessionsEnabled}
          onSessionsEnabledChange={setSessionsEnabled}
          trendlineEnabled={trendlineEnabled}
          onTrendlineEnabledChange={setTrendlineEnabled}
          drawModeEnabled={drawModeEnabled}
          onDrawModeEnabledChange={setDrawModeEnabled}
          drawnLineCount={drawnLines.length}
          onClearDrawnLines={() => setDrawnLines([])}
          strategyEnabled={strategyEnabled}
          onStrategyEnabledChange={setStrategyEnabled}
          signalCount={signals.length}
        />

        <main style={styles.chartCol}>
          <PaneHeader label="PRICE" />
          <div ref={priceContainerRef} style={styles.chartHost}>
            {chartsReady && (
              <SessionOverlay
                chart={priceChartRef.current}
                series={candleSeriesRef.current}
                containerRef={priceContainerRef}
                candles={visibleCandles}
                visibleEndIndex={visibleCandles.length}
                toggles={sessionToggles}
                showLabels={showSessionLabels}
              />
            )}
          </div>

          <PaneHeader label="CVD" />
          <div ref={cvdContainerRef} style={styles.cvdHost} />
        </main>

        <RightPanels
          timeframe={timeframe}
          hovered={hoveredCandle}
          stats={strategyStats}
          strategyEnabled={strategyEnabled}
          lotSize={lotSize}
          onLotSizeChange={setLotSize}
          startingBalance={startingBalance}
          onStartingBalanceChange={setStartingBalance}
          markPrice={markPrice}
        />
      </div>

      <StatusBar
        symbol="XAUUSD.sml"
        totalBars={active.candles.length}
        hovered={hoveredCandle}
      />
    </div>
  )
}

// --------------------------------------------------------------------
function PaneHeader({ label }: { label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        padding: '7px 14px',
        borderTop: `1px solid ${theme.border}`,
        borderBottom: `1px solid ${theme.border}`,
        background: theme.panel,
        fontFamily: fonts.mono,
        fontSize: 10,
        letterSpacing: 1.2,
        color: theme.text,
        userSelect: 'none',
      }}
    >
      <span style={{ textTransform: 'uppercase', fontWeight: 600 }}>{label}</span>
    </div>
  )
}

// --------------------------------------------------------------------
const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    width: '100vw',
    height: '100vh',
    background: theme.bg,
    color: theme.text,
    overflow: 'hidden',
    fontFamily: fonts.sans,
  },
  middle: {
    flex: 1,
    display: 'grid',
    gridTemplateColumns: `${sizes.leftNav}px 1fr ${sizes.rightPanels}px`,
    minHeight: 0,
    overflow: 'hidden',
  },
  chartCol: {
    display: 'grid',
    gridTemplateRows: 'auto 1fr auto 0.43fr',
    minHeight: 0,
    background: theme.panel,
    overflow: 'hidden',
  },
  chartHost: {
    position: 'relative',
    minHeight: 0,
    width: '100%',
  },
  cvdHost: {
    position: 'relative',
    minHeight: 0,
    width: '100%',
  },
}
