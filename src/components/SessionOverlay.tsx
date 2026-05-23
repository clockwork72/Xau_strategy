import { useEffect, useMemo, useRef, useState } from 'react'
import type { IChartApi, ISeriesApi } from 'lightweight-charts'
import { fonts } from '../theme'
import type { Candle } from '../types'
import {
  computeSessionRuns,
  SESSION_DEFS,
  type SessionRun,
  type SessionToggles,
} from '../engine/sessions'

interface Props {
  chart: IChartApi | null
  series: ISeriesApi<'Candlestick'> | null
  containerRef: React.RefObject<HTMLDivElement>
  candles: Candle[]
  visibleEndIndex: number
  toggles: SessionToggles
  showLabels: boolean
}

/**
 * Renders session boxes as absolute-positioned <div>s on top of the chart canvas.
 * Boxes update on pan/zoom/resize because we recompute pixel coords from world
 * (time + price) every render, and bump a `tick` state from the chart's
 * subscribeVisibleLogicalRangeChange to force re-renders.
 */
export default function SessionOverlay({
  chart,
  series,
  containerRef,
  candles,
  visibleEndIndex,
  toggles,
  showLabels,
}: Props) {
  // `tick` increments when chart visible range / size changes — triggers re-render.
  const [, setTick] = useState(0)
  const roRef = useRef<ResizeObserver | null>(null)

  useEffect(() => {
    if (!chart) return
    const onRange = () => setTick((t) => t + 1)
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange)
    // Also bump on each render frame initially so we catch the first setData.
    const rafId = requestAnimationFrame(() => setTick((t) => t + 1))
    return () => {
      cancelAnimationFrame(rafId)
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange)
    }
  }, [chart])

  // Re-render when chart container resizes.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setTick((t) => t + 1))
    ro.observe(el)
    roRef.current = ro
    return () => ro.disconnect()
  }, [containerRef])

  const visibleCandles = useMemo(
    () => candles.slice(0, visibleEndIndex),
    [candles, visibleEndIndex],
  )

  const runs = useMemo(
    () => computeSessionRuns(visibleCandles, toggles),
    [visibleCandles, toggles],
  )

  if (!chart || !series) return null

  // Compute pixel boxes from world coords. Drop any box outside the visible viewport.
  const ts = chart.timeScale()
  const boxes = runs
    .map((run): BoxPx | null => {
      const x1 = ts.timeToCoordinate(run.startTime)
      const x2 = ts.timeToCoordinate(run.endTime)
      const y1 = series.priceToCoordinate(run.high)
      const y2 = series.priceToCoordinate(run.low)
      if (x1 === null || x2 === null || y1 === null || y2 === null) return null
      const left = Math.min(x1, x2)
      const right = Math.max(x1, x2)
      const top = Math.min(y1, y2)
      const bot = Math.max(y1, y2)
      if (right - left < 1) return null
      return { run, left, top, width: right - left, height: bot - top }
    })
    .filter((b): b is BoxPx => b !== null)

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
        zIndex: 2,
      }}
    >
      {boxes.map((b, i) => {
        const def = SESSION_DEFS[b.run.sessionId]
        return (
          <div
            key={`${b.run.sessionId}-${b.run.startIndex}-${i}`}
            style={{
              position: 'absolute',
              left: b.left,
              top: b.top,
              width: b.width,
              height: b.height,
              background: def.bg,
              border: `1px solid ${def.border}`,
              boxSizing: 'border-box',
            }}
          >
            {showLabels && b.width > 60 && (
              <div
                style={{
                  position: 'absolute',
                  top: 4,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  fontFamily: fonts.mono,
                  fontSize: 9,
                  letterSpacing: 1.4,
                  color: def.text,
                  whiteSpace: 'nowrap',
                  textShadow: '0 1px 2px rgba(0,0,0,0.6)',
                }}
              >
                {def.name}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface BoxPx {
  run: SessionRun
  left: number
  top: number
  width: number
  height: number
}
