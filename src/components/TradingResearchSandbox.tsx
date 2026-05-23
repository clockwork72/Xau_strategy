import { useEffect, useMemo, useRef, useState } from 'react'
import {
  createChart,
  CrosshairMode,
  LineStyle,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type MouseEventParams,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts'

import { theme, fonts, sizes, palettes } from '../theme'
import type { Candle, Timeframe } from '../types'
import { computeEma } from '../engine/indicators'
import { runPriceActionBeta } from '../engine/priceActionBeta'
import { computeStats } from '../engine/portfolio'
import { findSwingHighs, findSwingLows, type SwingPoint } from '../engine/swings'
import {
  channelSignature,
  extendChannelToTime,
  findChannelBreak,
  pickChannels,
  TOUCH_PCT,
  type ChannelMeta,
} from '../engine/trendlines'
import type { SessionToggles } from '../engine/sessions'
import {
  HORIZONTAL_EXTEND_SEC,
  hitTestLine,
  nextLineId,
  snapToNearestPivot,
  type DrawTool,
  type DrawnLine,
} from '../engine/drawing'
import { formatAxisTick, formatCrosshair, parseCasaLocalToUtcSec } from '../util/time'
import { useReplayController } from '../hooks/useReplayController'
import { useDatasets } from '../hooks/useDatasets'
import { useThemeSync } from '../hooks/useThemeSync'

const DEFAULT_RANGE_START_CASA = '2026-05-21 00:00'
const DEFAULT_RANGE_END_CASA = '2026-05-21 20:00'
const DEFAULT_RANGE = {
  from: parseCasaLocalToUtcSec(DEFAULT_RANGE_START_CASA)!,
  to: parseCasaLocalToUtcSec(DEFAULT_RANGE_END_CASA)!,
}

// Lookback for swing-high detection. Smaller → more pivots → more touch
// candidates for the scoring algorithm; trades responsiveness for noise.
const TRENDLINE_LOOKBACK = 7

import TopBar from './TopBar'
import LeftNav from './LeftNav'
import RightPanels from './RightPanels'
import StatusBar from './StatusBar'
import SessionOverlay from './SessionOverlay'
import DrawToolbar from './DrawToolbar'

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
  const cvdZeroLineRef = useRef<IPriceLine | null>(null)
  const emaSeriesRef = useRef<ISeriesApi<'Line'> | null>(null)
  // Pool of LineSeries pairs (resistance + support) — grows on demand,
  // one pair per detected channel. History entries get a faded color.
  const channelsSeriesPoolRef = useRef<Array<{
    res: ISeriesApi<'Line'>
    sup: ISeriesApi<'Line'>
  }>>([])
  // Per-line render handles keyed by DrawnLine.id. Trendlines render via a
  // LineSeries; horizontals render via a priceLine on the candle series.
  // `chart` remembers which chart the handle lives on so cleanup picks the
  // right remove* target without needing to look the line up again.
  type DrawHandle =
    | { kind: 'line'; api: ISeriesApi<'Line'>; chart: 'price' | 'cvd' }
    | { kind: 'priceLine'; api: IPriceLine; chart: 'price' | 'cvd' }
  const drawnRenderMapRef = useRef<Map<string, DrawHandle>>(new Map())
  // Working anchor (waiting for the second click on a trendline draw).
  const drawWorkingRef = useRef<{ time: number; price: number; chart: 'price' | 'cvd' } | null>(null)
  // Mirrors so the chart click handler sees the latest values without
  // re-subscribing on every toggle.
  const activeToolRef = useRef<DrawTool>('cursor')
  const snapEnabledRef = useRef(true)
  const drawnLinesRef = useRef<DrawnLine[]>([])
  const selectedLineIdRef = useRef<string | null>(null)
  const swingsRef = useRef<{ highs: SwingPoint[]; lows: SwingPoint[] }>({ highs: [], lows: [] })
  // Stateful channel tracking. Identity = (kind, startTime). When the detector
  // re-emits the "same" channel with refined pivots, we UPDATE the live entry
  // in place (keeping its label). Transients (live entries no longer detected)
  // are silently dropped — not frozen. Channels freeze only when their CURRENT
  // refined form has a confirmed break, so the replay end-state matches
  // single-shot detection on the full range.
  const trackedChannelsRef = useRef<Map<string, ChannelMeta>>(new Map())
  // (key → label/kind) snapshot from the prior render, for log diffing.
  const prevTrackedInfoRef = useRef<Map<string, { label: string; kind: 'resistance' | 'support' }>>(new Map())
  // Persistent identity → label registry. Outlives drops, freezes, backward
  // scrubs, and kind-toggle-off cycles within a session. Cleared only on
  // TF / dataset / range change. Without this, a channel that drops for even
  // one tick re-enters with a fresh counter value — root cause of the
  // S1→S2→…→S14 inflation loop on flapping channels.
  const labelRegistryRef = useRef<{
    counters: { R: number; S: number }
    byIdentity: Map<string, string>
  }>({ counters: { R: 0, S: 0 }, byIdentity: new Map() })
  // Sentinels for detecting TF/range change inside the channelsMeta memo.
  // Initial null/undefined means "not yet seen" — skip reset on first mount.
  const prevActiveRef = useRef<typeof active | null>(null)
  const prevAppliedRangeRef = useRef<typeof appliedRange | undefined>(undefined)

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
  const { timeframe, setTimeframe, active, loadStatus, dataBounds } = useDatasets()

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
  const { themeMode, setThemeMode, toggleTheme, colors } = useThemeSync()
  const [activeTool, setActiveTool] = useState<DrawTool>('cursor')
  const [snapEnabled, setSnapEnabled] = useState(true)
  // Kind-level visibility — toggling Resistance off skips detection of
  // R-kind channels entirely (R1/R2/... gone, both rails + label). Persists
  // across replay because it's just two booleans gating pickChannels.
  const [showResistance, setShowResistance] = useState(true)
  const [showSupport, setShowSupport] = useState(true)
  // Per-channel hide set, keyed by stable label (R1/S4/…). Labels survive flap,
  // freeze, backward scrub, and kind-toggle cycles thanks to the persistent
  // label registry, so hides stick until the registry resets (TF/range/data
  // change), at which point this set is cleared in lockstep below.
  const [hiddenChannelLabels, setHiddenChannelLabels] = useState<ReadonlySet<string>>(() => new Set())
  const [drawnLines, setDrawnLines] = useState<DrawnLine[]>([])
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null)
  const [strategyEnabled, setStrategyEnabled] = useState(true)
  const [lotSize, setLotSize] = useState(0.01)
  const [startingBalance, setStartingBalance] = useState(100)
  const [appliedRange, setAppliedRange] = useState<{ from: number; to: number } | null>(DEFAULT_RANGE)
  // Force SessionOverlay to remount/re-read refs once charts exist.
  const [chartsReady, setChartsReady] = useState(false)

  // ---------- replay ----------
  const {
    replayWindow,
    replayCvdWindow,
    visibleCandles,
    visibleCvd,
    replayPlayhead,
    replayPlayheadTime,
    setReplayPlayheadTime,
    replayPlaying,
    setReplayPlaying,
    replaySpeed,
    setReplaySpeed,
    visibleCandlesRef,
  } = useReplayController(active, appliedRange)

  // ---------- lookup map for hover → candle ----------
  const candleByTime = useMemo(() => {
    const m = new Map<number, Candle>()
    for (const c of active.candles) m.set(c.time as number, c)
    return m
  }, [active])
  const hoveredCandle = hoveredTime === null ? null : candleByTime.get(hoveredTime) ?? null

  // ---------- create charts (once) ----------
  useEffect(() => {
    if (!priceContainerRef.current || !cvdContainerRef.current) return

    const initialColors = palettes[themeMode]
    const commonOpts = {
      layout: {
        background: { color: initialColors.panel },
        textColor: initialColors.text,
        fontSize: 11,
        fontFamily: fonts.sans,
      },
      grid: {
        vertLines: { color: initialColors.border, style: LineStyle.Dotted },
        horzLines: { color: initialColors.border, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: initialColors.border },
      localization: {
        timeFormatter: (t: Time) => formatCrosshair(t as number),
      },
      timeScale: {
        borderColor: initialColors.border,
        timeVisible: true,
        secondsVisible: false,
        tickMarkFormatter: (time: Time, tickMarkType: number) =>
          formatAxisTick(time as number, tickMarkType),
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: {
          color: initialColors.borderStrong,
          width: 1 as const,
          style: LineStyle.Solid,
          labelBackgroundColor: initialColors.borderStrong,
        },
        horzLine: {
          color: initialColors.borderStrong,
          width: 1 as const,
          style: LineStyle.Solid,
          labelBackgroundColor: initialColors.borderStrong,
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
      upColor: initialColors.up,
      downColor: initialColors.down,
      borderUpColor: initialColors.up,
      borderDownColor: initialColors.down,
      wickUpColor: initialColors.up,
      wickDownColor: initialColors.down,
      priceFormat: { type: 'price', precision: 3, minMove: 0.001 },
    })

    const ema = priceChart.addLineSeries({
      color: initialColors.warn,
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    })

    const cvd = cvdChart.addCandlestickSeries({
      upColor: initialColors.up,
      downColor: initialColors.down,
      borderUpColor: initialColors.up,
      borderDownColor: initialColors.down,
      wickUpColor: initialColors.up,
      wickDownColor: initialColors.down,
      priceFormat: { type: 'volume' },
      priceLineVisible: false,
    })

    const cvdZeroLine = cvd.createPriceLine({
      price: 0,
      color: initialColors.textInactive,
      lineStyle: LineStyle.Dashed,
      lineWidth: 1,
      axisLabelVisible: false,
      title: '',
    })
    cvdZeroLineRef.current = cvdZeroLine

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

    // ----- draw mode: routes by active tool. Same handler shape on price
    // and CVD; only price gets snap-to-swing (CVD has no price-domain pivots).
    // Every log line is tagged [draw][price|cvd] so you can grep by chart.
    const makeClickHandler = (
      chartId: 'price' | 'cvd',
      chart: IChartApi,
      series: ISeriesApi<'Candlestick'>,
      withSnap: boolean,
    ) => (param: MouseEventParams) => {
      const tool = activeToolRef.current
      if (!param.point) return
      let time: number | null = null
      if (param.time !== undefined) {
        time = param.time as number
      } else {
        const t = chart.timeScale().coordinateToTime(param.point.x)
        if (typeof t === 'number') time = t
      }
      if (time === null) return
      const rawPrice = series.coordinateToPrice(param.point.y)
      if (rawPrice === null) return

      if (tool === 'cursor') {
        const px = param.point.x
        const py = param.point.y
        const lines = drawnLinesRef.current
        for (let i = lines.length - 1; i >= 0; i--) {
          const ln = lines[i]
          if (ln.chart !== chartId) continue
          if (hitTestLine(px, py, ln, chart, series)) {
            setSelectedLineId(ln.id)
            return
          }
        }
        setSelectedLineId(null)
        return
      }

      const snapped = withSnap && snapEnabledRef.current
        ? snapToNearestPivot(
            time, rawPrice,
            swingsRef.current.highs, swingsRef.current.lows,
            visibleCandlesRef.current,
            chart, series,
          )
        : { time, price: rawPrice, source: null, deltaPx: null }
      const snapTag = snapped.source
        ? ` snap=${snapped.source}@${snapped.price.toFixed(3)} Δ${snapped.deltaPx!.toFixed(1)}px`
        : ''

      if (tool === 'horizontal') {
        const line: DrawnLine = {
          id: nextLineId(),
          tool: 'horizontal',
          chart: chartId,
          t1: snapped.time, p1: snapped.price,
          t2: snapped.time + HORIZONTAL_EXTEND_SEC, p2: snapped.price,
        }
        // eslint-disable-next-line no-console
        console.log(
          `[draw][${chartId}] line tool=horizontal p=${snapped.price.toFixed(3)} t=${formatCrosshair(snapped.time)}${snapTag}`,
        )
        setDrawnLines((lines) => [...lines, line])
        return
      }

      // trendline: two-click flow
      if (drawWorkingRef.current === null) {
        drawWorkingRef.current = { time: snapped.time, price: snapped.price, chart: chartId }
        // eslint-disable-next-line no-console
        console.log(
          `[draw][${chartId}] anchor1 t=${formatCrosshair(snapped.time)} p=${snapped.price.toFixed(3)}${snapTag}`,
        )
        return
      }
      // If second click lands on a different chart than the first anchor,
      // discard the in-progress trendline — cross-chart lines aren't a thing.
      if (drawWorkingRef.current.chart !== chartId) {
        drawWorkingRef.current = { time: snapped.time, price: snapped.price, chart: chartId }
        // eslint-disable-next-line no-console
        console.log(
          `[draw][${chartId}] anchor1 t=${formatCrosshair(snapped.time)} p=${snapped.price.toFixed(3)}${snapTag} (cross-chart restart)`,
        )
        return
      }
      const a = drawWorkingRef.current
      const b = { time: snapped.time, price: snapped.price }
      drawWorkingRef.current = null
      const dt = b.time - a.time
      const dp = b.price - a.price
      const slopeH = dt !== 0 ? ((dp / dt) * 3600).toFixed(3) : 'inf'
      // eslint-disable-next-line no-console
      console.log(
        `[draw][${chartId}] line tool=trendline a=${formatCrosshair(a.time)}@${a.price.toFixed(3)} b=${formatCrosshair(b.time)}@${b.price.toFixed(3)} dt=${dt}s dp=${dp.toFixed(3)} slope/h=${slopeH}${snapTag}`,
      )
      setDrawnLines((lines) => [
        ...lines,
        {
          id: nextLineId(),
          tool: 'trendline',
          chart: chartId,
          t1: a.time, p1: a.price, t2: b.time, p2: b.price,
        },
      ])
    }
    const onPriceClick = makeClickHandler('price', priceChart, candle, true)
    const onCvdClick = makeClickHandler('cvd', cvdChart, cvd, false)
    priceChart.subscribeClick(onPriceClick)
    cvdChart.subscribeClick(onCvdClick)

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
      cvdChart.unsubscribeClick(onCvdClick)
      priceChart.remove()
      cvdChart.remove()
      priceChartRef.current = null
      cvdChartRef.current = null
      candleSeriesRef.current = null
      cvdSeriesRef.current = null
      cvdZeroLineRef.current = null
      emaSeriesRef.current = null
      channelsSeriesPoolRef.current = []
      drawnRenderMapRef.current.clear()
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

  // Swings always computed (independent of the trendline overlay toggle) so
  // both the draw-tool snap and the channel detector can read them.
  const drawSwings = useMemo(() => ({
    highs: findSwingHighs(visibleCandles, TRENDLINE_LOOKBACK),
    lows: findSwingLows(visibleCandles, TRENDLINE_LOOKBACK),
  }), [visibleCandles])
  useEffect(() => { swingsRef.current = drawSwings }, [drawSwings])

  // ---------- Trendline channels: touch-scored across all pivot pairs.
  // pickChannels returns distinct non-overlapping channels with ≥3 touches.
  // Labels (R1/R2/S1/S2…) are assigned by full enumeration order, so a
  // hidden channel keeps its label and the visible chart can have gaps.
  const channelsMeta = useMemo<ChannelMeta[]>(() => {
    // Detect TF / dataset / range change in-memo: the prior separate reset
    // useEffect ran after render and wiped tracked just before the log effect
    // could see populated entries (causing missing detect logs). Doing the
    // reset here keeps the populate and log-diff in the same commit.
    const isFirstSeen = prevActiveRef.current === null && prevAppliedRangeRef.current === undefined
    const activeChanged = !isFirstSeen && prevActiveRef.current !== active
    const rangeChanged = !isFirstSeen && prevAppliedRangeRef.current !== appliedRange
    if (activeChanged || rangeChanged) {
      const n = trackedChannelsRef.current.size
      if (n > 0) {
        // eslint-disable-next-line no-console
        console.log(`[channels] reset (cleared ${n} tracked)`)
      }
      trackedChannelsRef.current.clear()
      prevTrackedInfoRef.current = new Map()
      labelRegistryRef.current = { counters: { R: 0, S: 0 }, byIdentity: new Map() }
    }
    prevActiveRef.current = active
    prevAppliedRangeRef.current = appliedRange

    if (!trendlineEnabled || visibleCandles.length === 0) return []
    const rawChannels = [
      ...(showResistance ? pickChannels(drawSwings.highs, visibleCandles, 'resistance') : []),
      ...(showSupport ? pickChannels(drawSwings.lows, visibleCandles, 'support') : []),
    ]
    // ---- DISABLED: cross-kind non-overlap (keeps broader, drops smaller) ----
    // Re-enable by sorting all candidates by (endTime - startTime) desc and
    // dropping any that overlaps an already-accepted one in time.
    // ---- /DISABLED ----
    const lastTime = visibleCandles[visibleCandles.length - 1].time as number
    const midPrice = visibleCandles[Math.floor(visibleCandles.length / 2)].close
    const eps = midPrice * TOUCH_PCT
    const prev = trackedChannelsRef.current
    const next = new Map<string, ChannelMeta>()
    const registry = labelRegistryRef.current

    // Process raw channels — one entry per identity. The registry preserves
    // labels across drops/freezes/backward-scrubs/kind-toggles, so the same
    // line never gets a different number within a session.
    const detectedIdentities = new Set<string>()
    for (const c of rawChannels) {
      const identity = `${c.kind}|${c.startTime}`
      if (detectedIdentities.has(identity)) continue
      detectedIdentities.add(identity)

      const breakT = findChannelBreak(c, visibleCandles, eps)
      const extended = extendChannelToTime(c, breakT ?? lastTime)
      const sig = channelSignature(c)

      let label = registry.byIdentity.get(identity)
      if (!label) {
        label = c.kind === 'resistance'
          ? `R${++registry.counters.R}`
          : `S${++registry.counters.S}`
        registry.byIdentity.set(identity, label)
      }

      const meta: ChannelMeta = {
        channel: extended,
        sig,
        label,
        status: breakT !== null ? 'broken' : 'live',
      }
      if (breakT !== null) {
        next.set(`frozen|${identity}|${breakT}`, meta)
      } else {
        next.set(`live|${identity}`, meta)
      }
    }

    // Carry over prev frozens whose identity wasn't re-detected AND whose
    // break is still in view. Re-detected ones were replaced above; out-of-
    // view ones are silently dropped (backward scrub). Carry runs for ALL
    // kinds — when a kind is toggled off, its broken channels persist in
    // tracked but are filtered at the render boundary; toggling back on
    // restores them in place.
    for (const [key, meta] of prev) {
      if (meta.status !== 'broken') continue
      const identity = `${meta.channel.kind}|${meta.channel.startTime}`
      if (detectedIdentities.has(identity)) continue
      if ((meta.channel.endTime as number) > lastTime) continue
      next.set(key, meta)
    }

    trackedChannelsRef.current = next
    return [...next.values()]
  }, [drawSwings, trendlineEnabled, visibleCandles, showResistance, showSupport])

  // ---------- session.log: channel detect / freeze / drop / unfreeze ----------
  // Diffs tracked entries by KEY (not sig) so refinements within the same
  // identity don't spam. Lives in a useEffect so StrictMode double-invoke of
  // memos can't double-log.
  useEffect(() => {
    const current = trackedChannelsRef.current
    const prevInfo = prevTrackedInfoRef.current

    // Map identity → new frozen key, so a live-key removal can tell whether it
    // was a freeze (transition) or an actual drop (transient gone).
    const newFrozenByIdentity = new Map<string, string>()
    for (const [key, meta] of current) {
      if (meta.status !== 'broken' || prevInfo.has(key)) continue
      newFrozenByIdentity.set(`${meta.channel.kind}|${meta.channel.startTime}`, key)
    }

    for (const [key, meta] of current) {
      if (prevInfo.has(key)) continue
      const ch = meta.channel
      if (meta.status === 'broken') {
        // eslint-disable-next-line no-console
        console.log(
          `[channels] freeze label=${meta.label} kind=${ch.kind} break=${formatCrosshair(ch.endTime)} sig=${meta.sig}`,
        )
      } else {
        const dt = ch.endTime - ch.startTime
        const slopeH =
          dt > 0 ? (((ch.upperEnd - ch.upperStart) / dt) * 3600).toFixed(3) : 'inf'
        const aY = ch.kind === 'resistance' ? ch.upperStart : ch.lowerStart
        const bY = ch.kind === 'resistance' ? ch.upperEnd : ch.lowerEnd
        // eslint-disable-next-line no-console
        console.log(
          `[channels] detect label=${meta.label} kind=${ch.kind} touches=${ch.touches} anchors=${formatCrosshair(ch.startTime)}@${aY.toFixed(3)}/${formatCrosshair(ch.endTime)}@${bY.toFixed(3)} slope/h=${slopeH} sig=${meta.sig}`,
        )
      }
    }

    for (const [key, info] of prevInfo) {
      if (current.has(key)) continue
      if (key.startsWith('live|')) {
        const parts = key.split('|')
        const identity = `${parts[1]}|${parts[2]}`
        // Live → frozen transition already logged above as "freeze".
        if (newFrozenByIdentity.has(identity)) continue
        // eslint-disable-next-line no-console
        console.log(`[channels] drop label=${info.label} kind=${info.kind}`)
      } else {
        // eslint-disable-next-line no-console
        console.log(`[channels] unfreeze label=${info.label} kind=${info.kind}`)
      }
    }

    const nextInfo = new Map<string, { label: string; kind: 'resistance' | 'support' }>()
    for (const [key, meta] of current) {
      nextInfo.set(key, { label: meta.label, kind: meta.channel.kind })
    }
    prevTrackedInfoRef.current = nextInfo
  }, [channelsMeta])

  useEffect(() => {
    const chart = priceChartRef.current
    if (!chart) return
    const pool = channelsSeriesPoolRef.current

    const clearPoolSlot = (i: number) => {
      pool[i].res.setData([])
      pool[i].sup.setData([])
      pool[i].res.setMarkers([])
      pool[i].sup.setMarkers([])
    }

    const visible = channelsMeta.filter((m) => {
      if (hiddenChannelLabels.has(m.label)) return false
      return m.channel.kind === 'resistance' ? showResistance : showSupport
    })

    while (pool.length < visible.length) {
      pool.push({
        res: chart.addLineSeries({
          color: colors.accent,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
        sup: chart.addLineSeries({
          color: colors.accent,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        }),
      })
    }

    for (let i = 0; i < visible.length; i++) {
      const ch = visible[i].channel
      pool[i].res.setData([
        { time: ch.startTime as Time, value: ch.upperStart },
        { time: ch.endTime as Time, value: ch.upperEnd },
      ])
      pool[i].sup.setData([
        { time: ch.startTime as Time, value: ch.lowerStart },
        { time: ch.endTime as Time, value: ch.lowerEnd },
      ])
      const isRes = ch.kind === 'resistance'
      const label = visible[i].label
      pool[i].res.setMarkers(isRes ? [{
        time: ch.startTime as Time,
        position: 'aboveBar',
        color: colors.accent,
        shape: 'circle',
        text: label,
      }] : [])
      pool[i].sup.setMarkers(!isRes ? [{
        time: ch.startTime as Time,
        position: 'belowBar',
        color: colors.accent,
        shape: 'circle',
        text: label,
      }] : [])
    }

    for (let i = visible.length; i < pool.length; i++) clearPoolSlot(i)
  }, [channelsMeta, showResistance, showSupport, hiddenChannelLabels, chartsReady, colors])

  // Mirror tool state into refs for the chart click handler.
  // Switching away from trendline mid-draw clears the pending anchor.
  // Switching away from cursor clears the selection.
  useEffect(() => {
    activeToolRef.current = activeTool
    if (activeTool !== 'trendline') drawWorkingRef.current = null
    if (activeTool !== 'cursor') setSelectedLineId(null)
  }, [activeTool])

  useEffect(() => { snapEnabledRef.current = snapEnabled }, [snapEnabled])
  useEffect(() => { drawnLinesRef.current = drawnLines }, [drawnLines])
  useEffect(() => { selectedLineIdRef.current = selectedLineId }, [selectedLineId])

  // ---------- chart-side theme re-apply ----------
  // DOM/localStorage/IPC sync lives in useThemeSync; this effect only
  // re-applies the hex colors that lightweight-charts can't resolve as CSS vars.
  useEffect(() => {
    const c = palettes[themeMode]
    const layoutOpts = {
      layout: { background: { color: c.panel }, textColor: c.text },
      grid: {
        vertLines: { color: c.border, style: LineStyle.Dotted },
        horzLines: { color: c.border, style: LineStyle.Dotted },
      },
      rightPriceScale: { borderColor: c.border },
      timeScale: { borderColor: c.border },
      crosshair: {
        vertLine: { color: c.borderStrong, labelBackgroundColor: c.borderStrong },
        horzLine: { color: c.borderStrong, labelBackgroundColor: c.borderStrong },
      },
    }
    priceChartRef.current?.applyOptions(layoutOpts)
    cvdChartRef.current?.applyOptions(layoutOpts)

    const candleOpts = {
      upColor: c.up, downColor: c.down,
      borderUpColor: c.up, borderDownColor: c.down,
      wickUpColor: c.up, wickDownColor: c.down,
    }
    candleSeriesRef.current?.applyOptions(candleOpts)
    cvdSeriesRef.current?.applyOptions(candleOpts)
    emaSeriesRef.current?.applyOptions({ color: c.warn })
    cvdZeroLineRef.current?.applyOptions({ color: c.textInactive })

    for (const pair of channelsSeriesPoolRef.current) {
      pair.res.applyOptions({ color: c.accent })
      pair.sup.applyOptions({ color: c.accent })
    }
    for (const handle of drawnRenderMapRef.current.values()) {
      handle.api.applyOptions({ color: c.warn })
    }
  }, [themeMode])

  const toggleChannelKind = (kind: 'resistance' | 'support') => {
    if (kind === 'resistance') setShowResistance((v) => !v)
    else setShowSupport((v) => !v)
  }
  const toggleChannelLabelHidden = (label: string) => {
    setHiddenChannelLabels((prev) => {
      const next = new Set(prev)
      if (next.has(label)) next.delete(label)
      else next.add(label)
      return next
    })
  }
  const clearHiddenChannelLabels = () => setHiddenChannelLabels(new Set())

  // Clear hidden-labels set when the label registry resets (active dataset or
  // applied range change). Otherwise a stale "S4" hide from the prior range
  // would silently suppress a brand-new S4 in the next range.
  useEffect(() => {
    setHiddenChannelLabels(new Set())
  }, [active, appliedRange])

  // ---------- keyboard: draw tool shortcuts ----------
  // V cursor · T trendline · H horizontal · S snap toggle
  // Esc clears working anchor + deselects · Del/Backspace removes selection
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      switch (e.key) {
        case 'v': case 'V':
          setActiveTool('cursor'); return
        case 't': case 'T':
          setActiveTool('trendline'); return
        case 'h': case 'H':
          setActiveTool('horizontal'); return
        case 's': case 'S':
          setSnapEnabled((v) => !v); return
        case 'Escape':
          drawWorkingRef.current = null
          setSelectedLineId(null)
          setActiveTool('cursor')
          return
        case 'Delete': case 'Backspace': {
          const id = selectedLineIdRef.current
          if (!id) return
          e.preventDefault()
          const target = drawnLinesRef.current.find((l) => l.id === id)
          const chartTag = target ? `[${target.chart}]` : ''
          setDrawnLines((lines) => lines.filter((l) => l.id !== id))
          setSelectedLineId(null)
          // eslint-disable-next-line no-console
          console.log(`[draw]${chartTag} delete id=${id}`)
          return
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  // Render user-drawn lines. Keyed by line.id, mixing LineSeries (trendlines)
  // and priceLine (horizontals) so different shapes coexist cleanly. Each
  // handle remembers its chart so cleanup removes from the right one.
  // The selected line gets a thicker stroke; others render at lineWidth 2.
  useEffect(() => {
    const priceChart = priceChartRef.current
    const cvdChart = cvdChartRef.current
    const candleSeries = candleSeriesRef.current
    const cvdSeries = cvdSeriesRef.current
    if (!priceChart || !cvdChart || !candleSeries || !cvdSeries) return
    const chartFor = (id: 'price' | 'cvd') => (id === 'price' ? priceChart : cvdChart)
    const seriesFor = (id: 'price' | 'cvd') => (id === 'price' ? candleSeries : cvdSeries)

    const map = drawnRenderMapRef.current
    const currentIds = new Set(drawnLines.map((l) => l.id))

    for (const [id, handle] of map) {
      if (currentIds.has(id)) continue
      if (handle.kind === 'line') chartFor(handle.chart).removeSeries(handle.api)
      else seriesFor(handle.chart).removePriceLine(handle.api)
      map.delete(id)
    }

    for (const line of drawnLines) {
      const isSelected = line.id === selectedLineId
      const width = isSelected ? 3 : 2
      const chart = chartFor(line.chart)
      const candle = seriesFor(line.chart)

      if (line.tool === 'horizontal') {
        const existing = map.get(line.id)
        if (existing && existing.kind === 'priceLine' && existing.chart === line.chart) {
          existing.api.applyOptions({ price: line.p1, color: colors.warn, lineWidth: width as 1 | 2 | 3 | 4 })
        } else {
          if (existing) {
            if (existing.kind === 'line') chartFor(existing.chart).removeSeries(existing.api)
            else seriesFor(existing.chart).removePriceLine(existing.api)
          }
          const pl = candle.createPriceLine({
            price: line.p1,
            color: colors.warn,
            lineWidth: width as 1 | 2 | 3 | 4,
            lineStyle: LineStyle.Solid,
            axisLabelVisible: false,
            title: '',
          })
          map.set(line.id, { kind: 'priceLine', api: pl, chart: line.chart })
        }
        continue
      }

      // trendline
      let handle = map.get(line.id)
      if (handle && (handle.kind === 'priceLine' || handle.chart !== line.chart)) {
        if (handle.kind === 'line') chartFor(handle.chart).removeSeries(handle.api)
        else seriesFor(handle.chart).removePriceLine(handle.api)
        handle = undefined
        map.delete(line.id)
      }
      let series: ISeriesApi<'Line'>
      if (handle && handle.kind === 'line') {
        series = handle.api
        series.applyOptions({ color: colors.warn, lineWidth: width as 1 | 2 | 3 | 4 })
      } else {
        series = chart.addLineSeries({
          color: colors.warn,
          lineWidth: width as 1 | 2 | 3 | 4,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        })
        map.set(line.id, { kind: 'line', api: series, chart: line.chart })
      }
      const [first, second] =
        line.t1 <= line.t2
          ? [{ t: line.t1, v: line.p1 }, { t: line.t2, v: line.p2 }]
          : [{ t: line.t2, v: line.p2 }, { t: line.t1, v: line.p1 }]
      series.setData([
        { time: first.t as Time, value: first.v },
        { time: second.t as Time, value: second.v },
      ])
    }
  }, [drawnLines, selectedLineId, chartsReady])

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
      color: s.side === 'buy' ? colors.up : colors.down,
      shape: s.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: s.label,
    }))
    cs.setMarkers(markers)
  }, [signals, chartsReady, themeMode])

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
        themeMode={themeMode}
        onThemeToggle={toggleTheme}
      />

      <div style={styles.middle}>
        <LeftNav
          timeframe={timeframe}
          onTimeframeChange={setTimeframe}
          onRangeJump={handleRangeJump}
          onRangeFit={handleRangeFit}
          initialRangeStart={DEFAULT_RANGE_START_CASA}
          initialRangeEnd={DEFAULT_RANGE_END_CASA}
          dataBounds={dataBounds}
          emaEnabled={emaEnabled}
          onEmaEnabledChange={setEmaEnabled}
          emaLength={emaLength}
          onEmaLengthChange={setEmaLength}
          sessionsEnabled={sessionsEnabled}
          onSessionsEnabledChange={setSessionsEnabled}
          trendlineEnabled={trendlineEnabled}
          onTrendlineEnabledChange={setTrendlineEnabled}
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
            <DrawToolbar
              activeTool={activeTool}
              onActiveToolChange={setActiveTool}
              snapEnabled={snapEnabled}
              onSnapEnabledChange={setSnapEnabled}
              lineCount={drawnLines.length}
              onClearAll={() => { setDrawnLines([]); setSelectedLineId(null) }}
            />
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
          channelsMeta={channelsMeta}
          showResistance={showResistance}
          showSupport={showSupport}
          onToggleChannelKind={toggleChannelKind}
          hiddenChannelLabels={hiddenChannelLabels}
          onToggleChannelLabelHidden={toggleChannelLabelHidden}
          onClearHiddenChannelLabels={clearHiddenChannelLabels}
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
