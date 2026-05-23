# Trending Channels v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Dynamic Linear Regression + Pearson correlation channel algorithm (v2) selectable via a LeftNav switcher, with multi-TF sweep, snap-and-hold state machine, and weighted scoring — coexisting with the existing pivot-based v1 algorithm.

**Architecture:** Per-(TF, N) trackers run an independent hunting → locked → broken state machine on pre-aggregated M5/M15/H1/H4 bundles. Locked channels are rigid (non-repainting) projections of `regressionLine ± 2σ_e`. Top-K by weighted score `|r| · log(TF_minutes · N)` render as ChannelMeta entries through the existing pipeline. A `v1 · v2` segmented pill in LeftNav selects which algorithm feeds the chart on any given tick.

**Tech Stack:** TypeScript, React 18, Vite, lightweight-charts v4, Electron. No test framework — verification is `npx tsc --noEmit` plus manual Electron observation plus `session.log` telemetry inspection.

**Spec:** `docs/superpowers/specs/2026-05-24-trending-channels-v2-design.md` (committed at `7dbd96b`).

---

## File structure

**New files:**

| File | Responsibility |
|---|---|
| `src/engine/regressionChannels.ts` | Pure math (regression, weighted score), state-machine reducers, full pipeline (`runV2Pipeline`), constants, telemetry emission |

**Modified files:**

| File | Change |
|---|---|
| `src/data.ts` | Add `buildHigherBundle(m1Rows, intervalSec)` aggregator |
| `src/hooks/useDatasets.ts` | Load M15/H1/H4 bundles alongside M1/M5; expose `htfBundles` in return shape |
| `src/components/LeftNav.tsx` | Add `algoVersion` + `onAlgoVersionChange` props; render a segmented `v1 · v2` pill in the Trendline row when trendline is enabled |
| `src/components/TradingResearchSandbox.tsx` | Add `algoVersion` state; split `labelRegistryRef` into `{ v1, v2 }`; add `trackerStatesRef` for v2; branch the `channelsMeta` memo on `algoVersion`; clear `hiddenChannelLabels` on algoVersion switch; reset v2 trackers + labels on TF/dataset/range change; pass switcher props to LeftNav |

**Unchanged:**

- `src/engine/trendlines.ts` (v1 algorithm — untouched)
- `src/components/RightPanels.tsx` (consumes ChannelMeta unchanged — v2 emits same shape)
- `src/engine/swings.ts`, `src/engine/drawing.ts`, chart effect, replay controller

**Verification convention (no test framework):**

After every task: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json` must return `exit=0` before commit. Algorithm behavior is verified manually in Electron and by inspecting `session.log` lines — `[channels] lock algo=v2 …`, `[channels] break algo=v2 …`, `[channels] hunt-reset algo=v2 …`. The structured log is the algorithm's contract surface.

**Commit style:** Short lowercase title, no co-author trailer (per project owner preference, HANDOFF §7). Each task = one focused commit.

---

## Task 1 — Add `buildHigherBundle` to data.ts

**Files:**
- Modify: `src/data.ts` (append new function near existing `buildM1Bundle` / `buildM5Bundle`)

- [ ] **Step 1: Read the existing aggregation patterns**

Read `src/data.ts` top to bottom. Note the shape of `DatasetBundle`, the M1 row type, how `buildM5Bundle` walks M1 rows into M5 candles, and how the broker-closed filter (`isBrokerClosed`) and the OANDA UTC+3 → UTC shift (`OANDA_MT5_TZ_OFFSET_SEC`) are applied. Your new function must follow these conventions exactly.

- [ ] **Step 2: Add the function**

Append to `src/data.ts` after `buildM5Bundle`:

```ts
/**
 * Fold consecutive M1 bars into HTF bars of `intervalSec` width (e.g.
 * 900 = M15, 3600 = H1, 14400 = H4). Bucket boundaries align to UTC
 * multiples of `intervalSec` after the OANDA broker-time shift is applied.
 * Bars where every contained M1 falls inside `isBrokerClosed` are dropped.
 * CVD is intentionally not built here — v2 regression is price-only.
 */
export function buildHigherBundle(
  m1Rows: ReadonlyArray<M1Row>,
  intervalSec: number,
): DatasetBundle {
  if (intervalSec <= 60) {
    throw new Error(`buildHigherBundle: intervalSec must be > 60, got ${intervalSec}`)
  }
  const candles: Candle[] = []
  let bucketStart = -1
  let bucket: M1Row[] = []
  const flush = () => {
    if (bucket.length === 0) return
    const allClosed = bucket.every((r) => isBrokerClosed(r.timeSec))
    if (!allClosed) {
      const first = bucket[0]
      const last = bucket[bucket.length - 1]
      let high = first.high
      let low = first.low
      let tickVolume = 0
      for (const r of bucket) {
        if (r.high > high) high = r.high
        if (r.low < low) low = r.low
        tickVolume += r.tickVolume
      }
      candles.push({
        time: first.timeSec as UTCTimestamp,
        open: first.open,
        high,
        low,
        close: last.close,
        tickVolume,
      })
    }
    bucket = []
  }
  for (const r of m1Rows) {
    const bs = Math.floor(r.timeSec / intervalSec) * intervalSec
    if (bs !== bucketStart) {
      flush()
      bucketStart = bs
    }
    bucket.push(r)
  }
  flush()
  return { candles, cvd: [] }
}
```

If the existing `M1Row` / `Candle` / `UTCTimestamp` / `isBrokerClosed` / `DatasetBundle` identifiers differ in your data.ts (older or renamed), reconcile by reading the file — match what's there exactly, don't invent.

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0`

- [ ] **Step 4: Commit**

```bash
git add src/data.ts
git commit -m "data: add buildHigherBundle aggregator for v2 HTF sweep"
```

---

## Task 2 — Load HTF bundles in useDatasets

**Files:**
- Modify: `src/hooks/useDatasets.ts`

- [ ] **Step 1: Add `buildHigherBundle` to the import**

In `src/hooks/useDatasets.ts`, change the import line:

```ts
import { buildM1Bundle, buildM5Bundle, buildHigherBundle, loadCsv, MOCK_M1, MOCK_M5 } from '../data'
```

- [ ] **Step 2: Extend the returned shape**

Modify the `DatasetsState` interface:

```ts
export interface DatasetsState {
  timeframe: Timeframe
  setTimeframe: (tf: Timeframe) => void
  active: DatasetBundle
  data1m: DatasetBundle
  data5m: DatasetBundle
  loadStatus: LoadStatus
  dataBounds: { from: number; to: number } | null
  // Higher-TF bundles derived from M1 at load time. Consumed by the v2
  // trending-channels algorithm's multi-TF sweep. Built once and never
  // re-derived during replay — zero recompute cost per tick.
  htfBundles: { m15: DatasetBundle; h1: DatasetBundle; h4: DatasetBundle }
}
```

- [ ] **Step 3: Build the HTF bundles inside the loader**

Inside the async loader, immediately after `setData5m(buildM5Bundle(m5Rows, m1Rows))`, add the three bundles to state. The cleanest approach is to add three new `useState` values and set them in the same callback. Modify the hook body:

Add near `const [data5m, setData5m] = useState<DatasetBundle>(MOCK_M5)`:

```ts
const EMPTY_BUNDLE: DatasetBundle = { candles: [], cvd: [] }
const [m15, setM15] = useState<DatasetBundle>(EMPTY_BUNDLE)
const [h1, setH1] = useState<DatasetBundle>(EMPTY_BUNDLE)
const [h4, setH4] = useState<DatasetBundle>(EMPTY_BUNDLE)
```

Inside the loader, after `setData5m(...)`:

```ts
setM15(buildHigherBundle(m1Rows, 15 * 60))
setH1(buildHigherBundle(m1Rows, 60 * 60))
setH4(buildHigherBundle(m1Rows, 4 * 60 * 60))
```

- [ ] **Step 4: Memoize the htfBundles object**

Below the existing `active` memo, add:

```ts
const htfBundles = useMemo(() => ({ m15, h1, h4 }), [m15, h1, h4])
```

- [ ] **Step 5: Include `htfBundles` in the returned object**

Modify the return statement:

```ts
return { timeframe, setTimeframe, active, data1m, data5m, loadStatus, dataBounds, htfBundles }
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0`

- [ ] **Step 7: Manual smoke (Electron)**

If `electron:dev` is running, the HMR reload will pull this in. Open DevTools and in the console run:

```js
// nothing should be exposed globally — instead, eyeball the network tab
// to confirm xauusd_m1.csv loaded once (not three times). buildHigherBundle
// re-uses the m1Rows array.
```

Acceptable smoke: app still renders, no console errors, no extra network requests for CSVs.

- [ ] **Step 8: Commit**

```bash
git add src/hooks/useDatasets.ts
git commit -m "useDatasets: load M15/H1/H4 bundles for v2 HTF sweep"
```

---

## Task 3 — Create regressionChannels.ts with constants, types, and pure math

**Files:**
- Create: `src/engine/regressionChannels.ts`

- [ ] **Step 1: Create the file with constants and types**

Create `src/engine/regressionChannels.ts` with:

```ts
import type { Candle, DatasetBundle } from '../types'
import type { ChannelMeta, Channel } from './trendlines'

// --------------------------------------------------------------------
//   Tunables — all consts here, no UI knobs in v1.0.
//   Tune in this file during manual verification; promote to UI later if
//   editing becomes frequent.
// --------------------------------------------------------------------
export const MIN_R = 0.7
export const LOCK_PEAK_LOOKBACK_K = 5
export const LOCK_PEAK_CONFIRM_J = 2
export const CONFIRM_BREAK_BARS_V2 = 2
// Initial value 0.1 ≈ pennies on tight σ_e. Bump to 0.25–0.30 if you see
// premature breaks during session-open volatility (spec §3.2).
export const BREAK_EPS_FRAC_OF_SIGMA = 0.1
export const V2_RENDER_TOP_K = 3
export const V2_LOOKBACK_NS = [50, 100, 200] as const
// TFs in the sweep matrix. The string is also the key used in tracker map
// keys and telemetry log tf= attributes.
export const V2_SWEEP_TFS = ['m5', 'm15', 'h1', 'h4'] as const

export type V2Tf = typeof V2_SWEEP_TFS[number]

export const TF_INTERVAL_SEC: Record<V2Tf, number> = {
  m5: 5 * 60,
  m15: 15 * 60,
  h1: 60 * 60,
  h4: 4 * 60 * 60,
}

export const TF_MINUTES: Record<V2Tf, number> = {
  m5: 5,
  m15: 15,
  h1: 60,
  h4: 240,
}

// --------------------------------------------------------------------
//   Pure math
// --------------------------------------------------------------------

export interface RegressionFit {
  a: number       // intercept (price at bar index 0 within the window)
  b: number       // slope (price per bar)
  sigmaE: number  // std of residuals
  r: number       // Pearson correlation, signed
}

/**
 * Closed-form OLS on `closes` indexed 0..N-1. Returns NaNs if N < 2 or
 * if all closes are equal (zero variance in p — undefined correlation).
 * Caller MUST check Number.isFinite(fit.r) before use.
 */
export function fitRegression(closes: ReadonlyArray<number>): RegressionFit {
  const n = closes.length
  if (n < 2) return { a: NaN, b: NaN, sigmaE: NaN, r: NaN }
  let sumI = 0
  let sumP = 0
  for (let i = 0; i < n; i++) {
    sumI += i
    sumP += closes[i]
  }
  const meanI = sumI / n
  const meanP = sumP / n
  let covIP = 0
  let varI = 0
  let varP = 0
  for (let i = 0; i < n; i++) {
    const di = i - meanI
    const dp = closes[i] - meanP
    covIP += di * dp
    varI += di * di
    varP += dp * dp
  }
  if (varI === 0 || varP === 0) return { a: NaN, b: NaN, sigmaE: NaN, r: NaN }
  const b = covIP / varI
  const a = meanP - b * meanI
  let sumSqRes = 0
  for (let i = 0; i < n; i++) {
    const fitted = a + b * i
    const res = closes[i] - fitted
    sumSqRes += res * res
  }
  const sigmaE = Math.sqrt(sumSqRes / n)
  const r = covIP / Math.sqrt(varI * varP)
  return { a, b, sigmaE, r }
}

/**
 * Weighted score = |r| · log(TF_minutes · N).
 * Use for ranking among locked channels (top-K render). Do NOT use raw |r|
 * for cross-TF/cross-N comparisons — HTF aggregation inflates r, smaller N
 * fits more easily, and ranking by raw r would systematically favor fleeting
 * short-window fits over macro structure. See spec §4.3.
 */
export function weightedScore(r: number, tfMinutes: number, N: number): number {
  if (!Number.isFinite(r)) return 0
  return Math.abs(r) * Math.log(tfMinutes * N)
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0`

- [ ] **Step 3: Inline numerical sanity in DevTools (optional, recommended)**

When `electron:dev` is running, open DevTools console and paste:

```js
// Import is not directly available in the renderer console, but you can verify
// math by importing from src/engine/regressionChannels.ts inside a temporary
// scratch console.log added to TradingResearchSandbox. For v1.0, the pure
// math is straightforward and tsc + manual lock observation in Task 9 is
// sufficient verification. Skip this step if pressed.

// Reference values for hand-verification:
//   closes = [10, 11, 12, 13, 14]
//   expected: a=10, b=1, sigmaE=0, r=1 (perfect line)
//
//   closes = [10, 11, 10, 11, 10]
//   expected: a≈10.4, b=0, sigmaE≈0.49, r≈0 (no trend)
```

- [ ] **Step 4: Commit**

```bash
git add src/engine/regressionChannels.ts
git commit -m "v2: regression math + weighted score + tunable constants"
```

---

## Task 4 — Add the per-tracker state machine types and reducers

**Files:**
- Modify: `src/engine/regressionChannels.ts` (append below the math section)

- [ ] **Step 1: Append the state-machine block**

Append to `src/engine/regressionChannels.ts`:

```ts
// --------------------------------------------------------------------
//   Per-tracker state machine — see spec §3.
//   Identity of a tracker = `${tf}|${N}`. State map is keyed by this.
// --------------------------------------------------------------------

export interface LockedParams {
  a: number          // intercept at window's first bar (bar index 0)
  b: number          // slope (price per bar)
  sigmaE: number     // residual std at lock time
  lockTime: number   // playhead time (UTC sec) at the moment of lock
  windowStart: number  // earliest bar's time (UTC sec) in the locked window
  windowEnd: number    // latest bar's time (UTC sec) — == lockTime
  peakR: number      // |r| at the peak that triggered the lock
}

export type V2TrackerState =
  | {
      phase: 'hunting'
      // Rolling history of |r| from recent ticks, oldest first. Capped at
      // LOCK_PEAK_LOOKBACK_K entries. Empty array on fresh hunt.
      rHistory: number[]
    }
  | {
      phase: 'locked'
      params: LockedParams
      // The TF and N this lock was made for, redundantly stored so the
      // pipeline can rebuild ChannelMeta without re-looking-up the key.
      tf: V2Tf
      n: number
      label: string  // assigned from the v2 label registry at lock time
    }
  | {
      phase: 'broken'
      params: LockedParams
      tf: V2Tf
      n: number
      label: string
      breakTime: number  // UTC sec of the first violating close
    }

export type V2TrackerStates = Map<string, V2TrackerState>

export function trackerKey(tf: V2Tf, n: number): string {
  return `${tf}|${n}`
}

/**
 * Step a hunting tracker with the latest regression fit. Returns either an
 * updated hunting state (still searching) or `'lock'` to signal the caller
 * should transition this tracker to locked (caller assigns label + builds
 * LockedParams from the fit). See spec §3.1.
 *
 * Lock trigger: rolling max of |r| ≥ MIN_R AND current < rolling max AND
 * the rolling max sits at least J ticks behind current (not the latest
 * sample). The "not the latest" check prevents locking at a peak that's
 * itself still climbing.
 */
export function huntingStep(
  state: Extract<V2TrackerState, { phase: 'hunting' }>,
  fit: RegressionFit,
): { phase: 'hunting'; rHistory: number[] } | 'lock' {
  const r = Number.isFinite(fit.r) ? Math.abs(fit.r) : 0
  const history = [...state.rHistory, r].slice(-LOCK_PEAK_LOOKBACK_K)
  if (history.length < LOCK_PEAK_CONFIRM_J + 1) {
    return { phase: 'hunting', rHistory: history }
  }
  // Find the index of the max in history.
  let maxIdx = 0
  let maxVal = history[0]
  for (let i = 1; i < history.length; i++) {
    if (history[i] > maxVal) {
      maxVal = history[i]
      maxIdx = i
    }
  }
  const ticksBehindCurrent = history.length - 1 - maxIdx
  const current = history[history.length - 1]
  if (
    maxVal >= MIN_R &&
    current < maxVal &&
    ticksBehindCurrent >= LOCK_PEAK_CONFIRM_J
  ) {
    return 'lock'
  }
  return { phase: 'hunting', rHistory: history }
}

/**
 * Step a locked tracker with the latest closes that fall AFTER the lock's
 * windowEnd. Returns `'break'` (with the first violator's time) if the
 * close violates a rail by more than BREAK_EPS_FRAC_OF_SIGMA·sigmaE for
 * CONFIRM_BREAK_BARS_V2 consecutive bars; returns null otherwise.
 *
 * `barsAfterLock` is the TF's candles[] with .time > params.windowEnd,
 * in chronological order. Pass an empty array on tick boundaries where
 * no new bar has formed past the lock window.
 */
export function lockedStep(
  params: LockedParams,
  barsAfterLock: ReadonlyArray<Candle>,
  intervalSec: number,
): { breakTime: number } | null {
  if (barsAfterLock.length < CONFIRM_BREAK_BARS_V2) return null
  const eps = BREAK_EPS_FRAC_OF_SIGMA * params.sigmaE
  let streak = 0
  let firstViolator: number | null = null
  for (const bar of barsAfterLock) {
    const t = bar.time as number
    // Bar index relative to lock window's bar 0:
    const idx = (t - params.windowStart) / intervalSec
    const line = params.a + params.b * idx
    const upper = line + 2 * params.sigmaE
    const lower = line - 2 * params.sigmaE
    const close = bar.close
    if (close > upper + eps || close < lower - eps) {
      if (firstViolator === null) firstViolator = t
      streak++
      if (streak >= CONFIRM_BREAK_BARS_V2) {
        return { breakTime: firstViolator }
      }
    } else {
      streak = 0
      firstViolator = null
    }
  }
  return null
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0`

- [ ] **Step 3: Commit**

```bash
git add src/engine/regressionChannels.ts
git commit -m "v2: per-tracker state machine (hunting/locked/broken reducers)"
```

---

## Task 5 — Add `runV2Pipeline` orchestration + ChannelMeta mapping + telemetry

**Files:**
- Modify: `src/engine/regressionChannels.ts` (append)

- [ ] **Step 1: Append the pipeline + mapping**

Append to `src/engine/regressionChannels.ts`:

```ts
// --------------------------------------------------------------------
//   ChannelMeta mapping — see spec §5.1
// --------------------------------------------------------------------

function metaFromLocked(
  params: LockedParams,
  tf: V2Tf,
  n: number,
  label: string,
  status: 'live' | 'broken',
  channelEndTime: number,
  score: number,
): ChannelMeta {
  const intervalSec = TF_INTERVAL_SEC[tf]
  const startTime = params.windowStart
  // End-of-channel bar index from the lock window's bar 0:
  const endIdx = (channelEndTime - startTime) / intervalSec
  const lineStart = params.a + params.b * 0
  const lineEnd = params.a + params.b * endIdx
  const upperStart = lineStart + 2 * params.sigmaE
  const upperEnd = lineEnd + 2 * params.sigmaE
  const lowerStart = lineStart - 2 * params.sigmaE
  const lowerEnd = lineEnd - 2 * params.sigmaE
  // Positive slope → uptrend → support is dominant. Negative slope →
  // downtrend → resistance is dominant. See spec §5.1.
  const kind = params.b >= 0 ? 'support' : 'resistance'
  const channel: Channel = {
    startTime,
    endTime: channelEndTime,
    upperStart,
    upperEnd,
    lowerStart,
    lowerEnd,
    touches: Math.round(score * 100),  // SEE SPEC §5.3 — overloaded for display
    kind,
  }
  const sig = `${kind}|${tf}|${n}|${params.lockTime}`
  return { channel, sig, label, status }
}

// --------------------------------------------------------------------
//   Label registry — separate from v1's, see spec §5.2
// --------------------------------------------------------------------

export interface V2LabelRegistry {
  counter: number
  byIdentity: Map<string, string>  // identity = `${tf}|${N}|${lockTime}` → "REG1" / "REG2" / …
}

export function emptyV2LabelRegistry(): V2LabelRegistry {
  return { counter: 0, byIdentity: new Map() }
}

function assignLabel(reg: V2LabelRegistry, identity: string): string {
  const existing = reg.byIdentity.get(identity)
  if (existing) return existing
  const label = `REG${++reg.counter}`
  reg.byIdentity.set(identity, label)
  return label
}

// --------------------------------------------------------------------
//   Telemetry log emission
// --------------------------------------------------------------------

import { formatCrosshair } from '../util/time'

function logLock(label: string, tf: V2Tf, n: number, params: LockedParams, score: number): void {
  const slopePerHour = (params.b / TF_INTERVAL_SEC[tf]) * 3600
  const sig = `${params.b >= 0 ? 'support' : 'resistance'}|${tf}|${n}|${params.lockTime}`
  // eslint-disable-next-line no-console
  console.log(
    `[channels] lock label=${label} algo=v2 tf=${tf} N=${n} lockTime=${formatCrosshair(params.lockTime)} r=${params.peakR.toFixed(3)} score=${score.toFixed(2)} slope/h=${slopePerHour >= 0 ? '+' : ''}${slopePerHour.toFixed(3)} sigma=${params.sigmaE.toFixed(3)} sig=${sig}`,
  )
}

function logBreak(label: string, tf: V2Tf, n: number, params: LockedParams, breakTime: number): void {
  const sig = `${params.b >= 0 ? 'support' : 'resistance'}|${tf}|${n}|${params.lockTime}`
  // eslint-disable-next-line no-console
  console.log(
    `[channels] break label=${label} algo=v2 tf=${tf} N=${n} lockTime=${formatCrosshair(params.lockTime)} violator=${formatCrosshair(breakTime)} sigma=${params.sigmaE.toFixed(3)} sig=${sig}`,
  )
}

function logHuntReset(label: string, tf: V2Tf, n: number): void {
  // eslint-disable-next-line no-console
  console.log(`[channels] hunt-reset label=${label} algo=v2 tf=${tf} N=${n} (tracker resumed hunting)`)
}

// --------------------------------------------------------------------
//   Pipeline — one call per memo tick
// --------------------------------------------------------------------

export interface V2PipelineInputs {
  // Current playhead in UTC seconds — caller derives from visibleCandles.
  playheadTime: number
  // The M5 bundle as exposed by useDatasets (data5m). Always passed
  // explicitly so the sweep is correct regardless of the user's active TF.
  m5Bundle: DatasetBundle
  htfBundles: { m15: DatasetBundle; h1: DatasetBundle; h4: DatasetBundle }
  // Mutable refs — pipeline MUTATES these so caller sees the post-tick state.
  trackerStates: V2TrackerStates
  labelRegistry: V2LabelRegistry
}

function getBundleForTf(inputs: V2PipelineInputs, tf: V2Tf): DatasetBundle {
  switch (tf) {
    case 'm5': return inputs.m5Bundle
    case 'm15': return inputs.htfBundles.m15
    case 'h1': return inputs.htfBundles.h1
    case 'h4': return inputs.htfBundles.h4
  }
}

/**
 * One memo tick. Mutates `trackerStates` and `labelRegistry`. Returns the
 * ChannelMeta[] to render (top-K by weighted score, locked + broken only).
 */
export function runV2Pipeline(inputs: V2PipelineInputs): ChannelMeta[] {
  const { playheadTime, trackerStates, labelRegistry } = inputs

  // Per (tf, N), get trailing N bars of that TF ending at or before playhead.
  for (const tf of V2_SWEEP_TFS) {
    const bundle = getBundleForTf(inputs, tf)
    if (bundle.candles.length === 0) continue
    for (const n of V2_LOOKBACK_NS) {
      const key = trackerKey(tf, n)
      const current = trackerStates.get(key)

      // Slice trailing N bars ending at-or-before playhead.
      // We linear-scan from end (candle counts are small — H4 has hundreds).
      let lastIdx = bundle.candles.length - 1
      while (lastIdx >= 0 && (bundle.candles[lastIdx].time as number) > playheadTime) {
        lastIdx--
      }
      if (lastIdx < n - 1) continue  // not enough bars yet
      const firstIdx = lastIdx - n + 1
      const window = bundle.candles.slice(firstIdx, lastIdx + 1)

      if (!current || current.phase === 'hunting') {
        const hunting = current ?? { phase: 'hunting' as const, rHistory: [] as number[] }
        const closes = window.map((c) => c.close)
        const fit = fitRegression(closes)
        const next = huntingStep(hunting, fit)
        if (next === 'lock') {
          const params: LockedParams = {
            a: fit.a,
            b: fit.b,
            sigmaE: fit.sigmaE,
            lockTime: window[window.length - 1].time as number,
            windowStart: window[0].time as number,
            windowEnd: window[window.length - 1].time as number,
            peakR: Math.abs(fit.r),
          }
          const identity = `${tf}|${n}|${params.lockTime}`
          const label = assignLabel(labelRegistry, identity)
          trackerStates.set(key, { phase: 'locked', params, tf, n, label })
          const score = weightedScore(fit.r, TF_MINUTES[tf], n)
          logLock(label, tf, n, params, score)
        } else {
          trackerStates.set(key, next)
        }
        continue
      }

      if (current.phase === 'locked') {
        // Find bars on this TF strictly after the lock's windowEnd, up to playhead.
        const after: Candle[] = []
        for (let i = 0; i < bundle.candles.length; i++) {
          const t = bundle.candles[i].time as number
          if (t <= current.params.windowEnd) continue
          if (t > playheadTime) break
          after.push(bundle.candles[i])
        }
        const result = lockedStep(current.params, after, TF_INTERVAL_SEC[tf])
        if (result) {
          trackerStates.set(key, {
            phase: 'broken',
            params: current.params,
            tf: current.tf,
            n: current.n,
            label: current.label,
            breakTime: result.breakTime,
          })
          logBreak(current.label, current.tf, current.n, current.params, result.breakTime)
        }
        continue
      }

      if (current.phase === 'broken') {
        // Resume hunting on the NEXT tick by allocating a fresh hunting state.
        // We do this lazily: only switch to hunting if the playhead has moved
        // past the break (one full bar). Otherwise the same broken state lingers
        // so the channel keeps rendering with its broken styling.
        const breakIdx = bundle.candles.findIndex(
          (c) => (c.time as number) === current.breakTime,
        )
        const nextBarTime = breakIdx >= 0 && breakIdx + 1 < bundle.candles.length
          ? (bundle.candles[breakIdx + 1].time as number)
          : null
        if (nextBarTime !== null && playheadTime >= nextBarTime) {
          logHuntReset(current.label, current.tf, current.n)
          trackerStates.set(key, { phase: 'hunting', rHistory: [] })
        }
        continue
      }
    }
  }

  // Collect locked + broken trackers, score, sort, top-K.
  interface Ranked {
    state: Extract<V2TrackerState, { phase: 'locked' | 'broken' }>
    score: number
    channelEndTime: number
  }
  const ranked: Ranked[] = []
  for (const [, state] of trackerStates) {
    if (state.phase !== 'locked' && state.phase !== 'broken') continue
    const score = weightedScore(state.params.peakR, TF_MINUTES[state.tf], state.n)
    const channelEndTime = state.phase === 'locked' ? playheadTime : state.breakTime
    ranked.push({ state, score, channelEndTime })
  }
  ranked.sort((a, b) => b.score - a.score)
  const top = ranked.slice(0, V2_RENDER_TOP_K)
  return top.map(({ state, score, channelEndTime }) =>
    metaFromLocked(
      state.params,
      state.tf,
      state.n,
      state.label,
      state.phase === 'locked' ? 'live' : 'broken',
      channelEndTime,
      score,
    ),
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0`

- [ ] **Step 3: Commit**

```bash
git add src/engine/regressionChannels.ts
git commit -m "v2: pipeline orchestration, ChannelMeta mapping, telemetry"
```

---

## Task 6 — Add LeftNav switcher pill

**Files:**
- Modify: `src/components/LeftNav.tsx`

- [ ] **Step 1: Extend the Props interface**

Add two new props to the `Props` interface in LeftNav.tsx (place after `trendlineEnabled` / `onTrendlineEnabledChange`):

```ts
algoVersion: 'v1' | 'v2'
onAlgoVersionChange: (v: 'v1' | 'v2') => void
```

- [ ] **Step 2: Destructure in the component**

In the LeftNav function signature, add `algoVersion, onAlgoVersionChange` to the destructured props alongside the existing trendline ones.

- [ ] **Step 3: Render the pill conditionally inside the Indicators section**

Find the existing `<SimpleToggleRow label="Trendline" enabled={trendlineEnabled} … />` row inside the `<Section label="Indicators">`. Replace it with:

```tsx
<SimpleToggleRow
  label="Trendline"
  enabled={trendlineEnabled}
  onChange={onTrendlineEnabledChange}
/>
{trendlineEnabled && (
  <AlgoVersionPill value={algoVersion} onChange={onAlgoVersionChange} />
)}
```

- [ ] **Step 4: Add the AlgoVersionPill component**

Append this component near the bottom of `LeftNav.tsx`, before the `rangeBtn` const:

```tsx
function AlgoVersionPill({
  value,
  onChange,
}: {
  value: 'v1' | 'v2'
  onChange: (v: 'v1' | 'v2') => void
}) {
  const opts: Array<'v1' | 'v2'> = ['v1', 'v2']
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 8px 6px 32px',
      }}
    >
      <span
        style={{
          fontSize: 9,
          color: theme.textInactive,
          letterSpacing: 0.6,
          fontFamily: fonts.mono,
        }}
      >
        ALGO
      </span>
      <div
        style={{
          display: 'inline-flex',
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          padding: 1,
        }}
      >
        {opts.map((v) => {
          const active = v === value
          return (
            <button
              key={v}
              onClick={() => onChange(v)}
              style={{
                appearance: 'none',
                background: active ? theme.accent : 'transparent',
                color: active ? theme.panel : theme.textMuted,
                border: 'none',
                borderRadius: 3,
                padding: '2px 8px',
                fontSize: 10,
                fontFamily: fonts.mono,
                letterSpacing: 0.4,
                cursor: 'pointer',
                fontWeight: active ? 600 : 400,
                textTransform: 'uppercase',
              }}
            >
              {v}
            </button>
          )
        })}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0` (will fail until Task 7 wires the props from the Sandbox — if so, proceed to Task 7 and come back to commit).

If tsc reports the LeftNav usage in TradingResearchSandbox is missing props — that's expected. Don't commit yet, finish Task 7 first.

- [ ] **Step 6: Hold commit until Task 7**

The switcher pill renders nothing without the Sandbox wiring. Defer the commit to combine LeftNav + Sandbox switcher integration as one atomic change.

---

## Task 7 — Wire algoVersion + v2 pipeline into TradingResearchSandbox

**Files:**
- Modify: `src/components/TradingResearchSandbox.tsx`

- [ ] **Step 1: Add the v2 imports**

Near the existing trendlines import, add:

```ts
import {
  runV2Pipeline,
  emptyV2LabelRegistry,
  type V2TrackerStates,
  type V2LabelRegistry,
} from '../engine/regressionChannels'
```

- [ ] **Step 2: Add `algoVersion` state**

In the UI state block, after `const [showSupport, setShowSupport] = useState(true)`:

```ts
const [algoVersion, setAlgoVersion] = useState<'v1' | 'v2'>('v1')
```

- [ ] **Step 3: Split the label registry into v1 + v2 sub-refs**

Find the existing:

```ts
const labelRegistryRef = useRef<{
  counters: { R: number; S: number }
  byIdentity: Map<string, string>
}>({ counters: { R: 0, S: 0 }, byIdentity: new Map() })
```

Replace with:

```ts
const labelRegistryRef = useRef<{
  v1: { counters: { R: number; S: number }; byIdentity: Map<string, string> }
  v2: V2LabelRegistry
}>({
  v1: { counters: { R: 0, S: 0 }, byIdentity: new Map() },
  v2: emptyV2LabelRegistry(),
})
```

- [ ] **Step 4: Add the v2 trackers ref**

Right after the labelRegistryRef declaration, add:

```ts
const trackerStatesV2Ref = useRef<V2TrackerStates>(new Map())
```

- [ ] **Step 5: Update the reset block to clear v1 + v2 state and report both in the log**

Inside the `channelsMeta` memo, find the existing reset branch:

```ts
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
```

Replace with:

```ts
if (activeChanged || rangeChanged) {
  const v1Count = trackedChannelsRef.current.size
  const v2Count = trackerStatesV2Ref.current.size
  const total = v1Count + v2Count
  if (total > 0) {
    // eslint-disable-next-line no-console
    console.log(`[channels] reset (cleared ${total} tracked: v1=${v1Count} v2=${v2Count})`)
  }
  trackedChannelsRef.current.clear()
  prevTrackedInfoRef.current = new Map()
  labelRegistryRef.current.v1 = { counters: { R: 0, S: 0 }, byIdentity: new Map() }
  labelRegistryRef.current.v2 = emptyV2LabelRegistry()
  trackerStatesV2Ref.current.clear()
}
```

Also update every other `labelRegistryRef.current` reference inside the v1 branch of the memo:

```ts
const registry = labelRegistryRef.current
```

becomes:

```ts
const registry = labelRegistryRef.current.v1
```

(Search the memo body for all `labelRegistryRef.current` usages. The `registry.byIdentity` and `registry.counters` reads in the v1 label-lookup loop work unchanged after this rename.)

- [ ] **Step 6: Branch the memo on algoVersion**

Find the start of the existing `channelsMeta = useMemo<ChannelMeta[]>(() => { ... }, [...])` body. After the reset block (which clears tracked state on TF/range change — keep this code unchanged at the top), insert the v2 branch BEFORE the existing v1 logic:

```ts
    if (algoVersion === 'v2') {
      if (!trendlineEnabled || visibleCandles.length === 0) return []
      const playheadTime = visibleCandles[visibleCandles.length - 1].time as number
      return runV2Pipeline({
        playheadTime,
        m5Bundle: data5m,
        htfBundles,
        trackerStates: trackerStatesV2Ref.current,
        labelRegistry: labelRegistryRef.current.v2,
      })
    }

    // v1 fallthrough below — existing code unchanged.
```

Also update the memo dependency array to include `algoVersion`, `data5m`, and `htfBundles`:

```ts
}, [algoVersion, drawSwings, trendlineEnabled, visibleCandles, showResistance, showSupport, data5m, htfBundles])
```

(The `data5m` and `htfBundles` deps are needed because the v2 branch reads them. `drawSwings` is only used by v1 but staying in deps does no harm.)

- [ ] **Step 7: Add `data5m` and `htfBundles` to the useDatasets destructure**

Find:

```ts
const { timeframe, setTimeframe, active, loadStatus, dataBounds } = useDatasets()
```

Change to:

```ts
const { timeframe, setTimeframe, active, data5m, loadStatus, dataBounds, htfBundles } = useDatasets()
```

(`data5m` is already exported by useDatasets — no change to useDatasets needed for this step.)

- [ ] **Step 8: Reset hidden-labels on algoVersion switch**

Find the existing effect that clears `hiddenChannelLabels` on active/range change:

```ts
useEffect(() => {
  setHiddenChannelLabels(new Set())
}, [active, appliedRange])
```

Change deps to include algoVersion:

```ts
useEffect(() => {
  setHiddenChannelLabels(new Set())
}, [active, appliedRange, algoVersion])
```

- [ ] **Step 9: Pass switcher props to LeftNav**

In the LeftNav JSX, add (alongside the existing trendline props):

```tsx
algoVersion={algoVersion}
onAlgoVersionChange={setAlgoVersion}
```

- [ ] **Step 10: Type-check**

Run: `npx tsc --noEmit -p /c/Users/asus/Desktop/Xau_Algo/tsconfig.json; echo "exit=$?"`
Expected: `exit=0`

- [ ] **Step 11: Commit (LeftNav + Sandbox wiring atomic)**

```bash
git add src/components/LeftNav.tsx src/components/TradingResearchSandbox.tsx
git commit -m "v2: algoVersion switcher in LeftNav, branched memo, registry split"
```

---

## Task 8 — Manual end-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Start Electron dev**

If not already running:

```bash
npm run electron:dev
```

- [ ] **Step 2: Confirm v1 still works (no regression)**

In the app:
1. Default range should load: 2026-05-21 00:00 → 20:00 Casa.
2. Toggle Trendline on (already on by default). The `ALGO v1·v2` pill should appear under it, with v1 active.
3. Trigger a replay scrub or play forward. Confirm v1 channels (R1/S1/…) render on the chart and in the right panel exactly as before.
4. Open `session.log` (project root). Confirm v1 lines still emit (`[channels] detect …`, `[channels] freeze …`).

If any v1 regression is observed, stop and diagnose before continuing — the Task 7 registry split is the most likely cause.

- [ ] **Step 3: Switch to v2 and observe**

1. Click `v2` in the ALGO pill.
2. The chart's channels should disappear immediately (v2 trackers start in hunting; no rendered channels yet).
3. Scrub or play replay forward. Watch `session.log` for `[channels] lock label=REG1 algo=v2 …` lines.
4. When a lock fires, a v2 channel should render on the chart with REG1 marker. The right panel's "Channels" section should show the REG1 row under Resistance or Support depending on slope.
5. Continue forward until the channel breaks. Confirm `[channels] break label=REG1 …` appears and the panel row dims with a "BROKEN" pill.

- [ ] **Step 4: Switch back to v1, then v2 again**

Toggle v2 → v1 → v2. Confirm:
- v1 channels reappear immediately with their original labels (R1/S1 stay the same).
- v2 trackers retain prior state — REG1 should reappear (locked or broken) without renumbering.
- The per-label hide set IS cleared on each switch (an S4 you hid under v1 reappears after v1→v2→v1).

- [ ] **Step 5: Tune `BREAK_EPS_FRAC_OF_SIGMA` if needed**

If breaks fire too readily on standard session-open volatility:

1. Open `src/engine/regressionChannels.ts`.
2. Change `BREAK_EPS_FRAC_OF_SIGMA = 0.1` to `0.25` (or `0.30`).
3. Save — Vite HMR reloads the renderer.
4. Re-test the locked-channel break scenarios.

If you tune this, note the chosen value in your verification log; commit the change as its own focused commit:

```bash
git add src/engine/regressionChannels.ts
git commit -m "v2: bump BREAK_EPS_FRAC_OF_SIGMA to 0.25 after manual tuning"
```

- [ ] **Step 6: Change applied range and verify reset**

In LeftNav, type a different valid range (e.g. 2026-05-22 00:00 → 12:00) and click Apply. Confirm:
- `[channels] reset (cleared N tracked: v1=X v2=Y)` line appears in session.log with both counts.
- v2 counter resets — first new lock becomes REG1 (not REG2 or higher).
- v1 counters reset — first new pivot channel becomes R1/S1.

- [ ] **Step 7: Update HANDOFF.md with v2 entry**

Add a brief section under §5 Architecture overview documenting the v2 algorithm exists, the switcher location, and the spec file path. Keep it under 12 lines — the spec doc holds the detail. Suggested wording:

```markdown
### Trending channels — v2 (Dynamic Linear Regression)

Selectable via `ALGO v1·v2` pill in LeftNav (visible when Trendline is on).
Per-(TF, N) snap-and-hold state machine over a pre-aggregated M5/M15/H1/H4
sweep. Locked channels are rigid `regressionLine ± 2σ_e` projections;
break when close violates `BREAK_EPS_FRAC_OF_SIGMA · σ_e` for
CONFIRM_BREAK_BARS_V2 consecutive bars. Top-K render by weighted score
`|r| · log(TF_minutes · N)`. Telemetry: `[channels] lock|break|hunt-reset
algo=v2 …` in session.log. Full spec: `docs/superpowers/specs/2026-05-24-trending-channels-v2-design.md`.
```

Also bump §9 commit history with the new commits when the work lands.

- [ ] **Step 8: Commit HANDOFF update**

```bash
git add HANDOFF.md
git commit -m "handoff: document v2 trending channels algorithm"
```

---

## Done

After Task 8 the implementation is complete and committed. The spec's open-questions section is empty, so no follow-up brainstorming required. If you discover during Step 5 that BREAK_EPS_FRAC_OF_SIGMA needs serious tuning OR that the lock trigger fires too aggressively, log the observation and revisit in a follow-up plan rather than expanding scope here.

**Deferred items the spec explicitly listed (do NOT pursue in this plan):**
- Hunting candidate preview render (dimmed dashed line for in-progress trackers)
- `displayMetric` field on ChannelMeta to replace the `touches` repurposing hack
- UI knobs for the constants
- Persistent `algoVersion` in localStorage
- CVD-aware regression
- Cross-algorithm correlation highlighting
