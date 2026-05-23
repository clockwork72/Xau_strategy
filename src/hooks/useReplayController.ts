import { useEffect, useMemo, useRef, useState } from 'react'
import type { Candle, CvdCandle, DatasetBundle } from '../types'
import { formatCrosshair } from '../util/time'

/**
 * Largest index `i` such that `window[i].time <= t`.
 * - t === null → window.length - 1 (default: show everything)
 * - t before window start → 0
 * - t after window end → window.length - 1
 */
export function findIndexForTime(window: ReadonlyArray<Candle>, t: number | null): number {
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

export interface ReplayRange {
  from: number
  to: number
}

export interface ReplayController {
  // window = the full appliedRange-filtered slice of the active dataset
  replayWindow: Candle[]
  replayCvdWindow: CvdCandle[]
  // visible = window sliced up to the playhead
  visibleCandles: Candle[]
  visibleCvd: CvdCandle[]
  // playhead expressed both as derived index and as the canonical time anchor
  replayPlayhead: number
  replayPlayheadTime: number | null
  setReplayPlayheadTime: (t: number | null) => void
  replayPlaying: boolean
  setReplayPlaying: React.Dispatch<React.SetStateAction<boolean>>
  replaySpeed: number
  setReplaySpeed: (s: number) => void
  // Mirror of visibleCandles for handlers that need the latest value without
  // re-subscribing on every tick (drawing chart-click).
  visibleCandlesRef: React.MutableRefObject<Candle[]>
}

/**
 * Replay state machine: window slicing, playhead, tick interval, keyboard
 * shortcuts, and the `[replay]` session-log lines consumed by the agent bridge.
 *
 * Time-anchored (not index-anchored) so that TF switches reuse the same time
 * and resolve against the new bar grid.
 */
export function useReplayController(
  active: DatasetBundle,
  appliedRange: ReplayRange | null,
): ReplayController {
  const [replayPlaying, setReplayPlaying] = useState(false)
  const [replayPlayheadTime, setReplayPlayheadTime] = useState<number | null>(null)
  const [replaySpeed, setReplaySpeed] = useState(4)

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

  const replayPlayhead = useMemo(
    () => findIndexForTime(replayWindow, replayPlayheadTime),
    [replayWindow, replayPlayheadTime],
  )

  // appliedRange change → clear anchor (re-default to "show everything") and pause.
  useEffect(() => {
    setReplayPlayheadTime(null)
    setReplayPlaying(false)
  }, [appliedRange])

  // Window change: if the anchor falls outside the new range, snap to last bar and pause.
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

  // Read latest playheadTime inside the tick interval without re-subscribing
  // on every state change.
  const playheadTimeRef = useRef<number | null>(replayPlayheadTime)
  playheadTimeRef.current = replayPlayheadTime

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

  // keyboard: Space play/pause, ←/→ step (Shift = 10), Home reset, End jump-to-end.
  // Skipped while typing in an input.
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

  // ---------- session.log bridge ----------
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
      console.log(
        `[replay] range ${formatCrosshair(appliedRange.from)} → ${formatCrosshair(appliedRange.to)}`,
      )
    }
  }, [appliedRange])

  const visibleCandlesRef = useRef<Candle[]>([])
  useEffect(() => {
    visibleCandlesRef.current = visibleCandles
  }, [visibleCandles])

  return {
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
  }
}
