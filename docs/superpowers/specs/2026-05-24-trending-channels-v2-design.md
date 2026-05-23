# Trending Channels — v2 Design

**Date:** 2026-05-24
**Status:** Approved, ready for implementation plan
**Author:** Brainstormed with project owner via Claude Code session

---

## 1. Motivation

v1 (`engine/trendlines.ts`) is a pivot-based touch-scored channel detector: enumerate every swing-pair, count touches within an eps band, greedy non-overlap, density filter. It works for geometric pattern recognition but has known limits — channel detection ties on touch-count produce flap, anchor pairs picked by the algorithm don't always match a trader's visual choice, and pivot lag (7-bar lookback) delays first detection.

v2 explores an orthogonal approach: **Dynamic Linear Regression with Pearson correlation**, multi-timeframe sweep, and a snap-and-hold state machine so locked channels become rigid (non-repainting) barriers usable for breakout signals. v1 remains the default; v2 is selectable via a LeftNav switcher for live A/B comparison on the same chart.

## 2. Scope

- v2 is a new algorithm; v1 stays untouched and remains the default.
- A switcher in LeftNav (`v1 · v2`) selects which algorithm feeds the channel pipeline.
- Both algorithms produce `ChannelMeta[]` consumed by the existing chart effect, kind toggles, per-label hide, and right-panel rendering — no UI rebuild.
- Reset triggers (TF / dataset / range change) clear both algorithms' state in lockstep. Switching algorithm clears the per-label hide set but preserves each algorithm's tracker memory.

## 3. Algorithm core — snap-and-hold state machine

For each `(TF, N)` pair in the sweep matrix, maintain an independent tracker with one of three phases.

### 3.1 Hunting (sliding window)

Each render tick (on `visibleCandles` change):

1. Take the trailing `N` bars of the TF's bundle, ending at the current playhead time.
2. Compute least-squares regression on the closes:
   - `b = cov(i, p) / var(i)` (slope)
   - `a = mean(p) − b·mean(i)` (intercept)
   - `σ_e = sqrt(mean((p_i − (a + b·i))²))` (residual std)
   - `r = cov(i, p) / (σ_i · σ_p)` (Pearson correlation)
3. Append `|r|` to a per-tracker rolling history of length `LOCK_PEAK_LOOKBACK_K = 5`.
4. **Lock trigger**: fires when
   - `rolling_max(|r|) ≥ MIN_R (0.7)` AND
   - The current `|r|` is less than `rolling_max` AND
   - The rolling max is at least `LOCK_PEAK_CONFIRM_J = 2` ticks behind current (the peak isn't itself the latest sample).
5. On lock: snapshot `{ a, b, σ_e, lockTime: currentPlayhead, windowStart, windowEnd, peakR }` — frozen for the channel's life.

No channel is rendered during hunting. (Dimmed "candidate preview" rendering is deferred — see §11.)

### 3.2 Locked (rigid projection)

- Channel parameters are immutable from the moment of lock.
- For each bar at time `t > lockTime`: project the rails from the locked slope `b` and intercept `a` as `regressionLine(t) ± 2·σ_e`.
- **Break check**: a closing price violates the projected rail by more than `BREAK_EPS_FRAC_OF_SIGMA · σ_e` for `CONFIRM_BREAK_BARS_V2 = 2` consecutive bars → transition to broken.
- **Critical tuning note**: `BREAK_EPS_FRAC_OF_SIGMA = 0.1` is the initial value. For highly liquid markets with aggressive liquidity sweeps, 0.1·σ can translate to pennies and trigger premature breaks during normal session-open volatility. Be prepared to bump to 0.25–0.30 during manual verification (§9) if false breaks are observed.

### 3.3 Broken (terminal for this channel)

- Channel stays rendered (parallel to v1's frozen behavior — preserves history).
- The (TF, N) tracker resumes hunting on the next tick: a fresh hunting state is allocated for the same key.

## 4. Multi-TF data + weighted scoring

### 4.1 Data aggregation

- New function `buildHigherBundle(m1Rows: M1Row[], intervalSec: number): DatasetBundle` in `src/data.ts`. Folds consecutive M1 bars into one HTF bar:
  - `time` = first bar's time
  - `open` = first bar's open
  - `close` = last bar's close
  - `high` = max of contained highs
  - `low` = min of contained lows
  - `tickVolume` = sum
  - Broker-closed filter (`isBrokerClosed`) applied identically.
- `useDatasets` loads M15, H1, H4 bundles at the same time as M5. Three additional bundles, derived once at load — negligible cost.
- CVD aggregation is not needed for v2 (regression is price-only).

### 4.2 Sweep matrix

```
TFs:      { active TF, M15, H1, H4 }   (dedupe if active is already one of these)
Lengths:  { 50, 100, 200 }
Trackers: up to 12 per tick
```

Each regression is O(N) in two passes (one for means, one for residuals/correlation). 12 × O(200) ≈ 2400 ops per tick — microseconds in JS. No memoization needed.

### 4.3 Weighted scoring (statistical fix)

Never sort by raw `|r|`. HTF aggregation reduces variance (inflates `r`); smaller `N` is mathematically easier to fit. Use:

```ts
score = |r| * Math.log(TF_minutes * N)
```

Examples:
- 200-bar H1 fit at r=0.78 → `0.78 · log(60·200) ≈ 7.34`
- 50-bar M5 fit at r=0.85 → `0.85 · log(5·50) ≈ 4.68`

Macro structure outranks fleeting micro-structure even when micro has a tighter mathematical fit. Threshold check (`MIN_R = 0.7`) still applies to raw `|r|` for the lock trigger — scoring is used only for ranking among locked channels (top-K selection for display).

## 5. Output model

### 5.1 ChannelMeta mapping (reuses v1's type)

| Field | Source for v2 |
|---|---|
| `channel.startTime` | `lockTime − N · intervalSec` |
| `channel.endTime` | playhead (live) or break time (broken) |
| `upperStart / upperEnd` | regression line at start/end **+ 2·σ_e** |
| `lowerStart / lowerEnd` | regression line at start/end **− 2·σ_e** |
| `touches` | `Math.round(weightedScore * 100)` — see §5.3 hack note |
| `kind` | `'support'` if `slope > 0` (uptrend, lower rail dominant); `'resistance'` if `slope < 0` (downtrend, upper rail dominant) |
| `sig` | `${kind}\|${tf}\|${N}\|${lockTime}` |
| `label` | `"REG1"`, `"REG2"`, … from a v2-only label registry |
| `status` | `'live'` (locked) or `'broken'` |

### 5.2 Label registry

Separate from v1's. Stored as `labelRegistryRef.v2 = { counter: 0, byIdentity: Map<identity, label> }` where identity = `"${tf}|${N}|${lockTime}"`. Stable across hunt resets and break transitions. Reset on TF / dataset / range change AND on algorithm switch.

### 5.3 `touches` repurposing — known compromise

For v2 entries, the `touches` numeric field is **overloaded** to hold `Math.round(weightedScore * 100)`. The right-panel "Nt" trailing column renders this as if it were a touch count, displaying e.g. "79t" for `score = 0.79`. This is a v1.0-launch compromise to avoid rebuilding the panel UI.

**Constraint for downstream tooling and parsers (agents reading `session.log`, future scripts, the HMM pipeline, etc.):**

> **Read `score=` from telemetry log lines. Never parse the `touches` field on v2 ChannelMeta objects expecting an integer touch count.**

A clean fix (add a `displayMetric: string` field to ChannelMeta, format per algorithm) is deferred until either (a) the panel gets a redesign for v2-specific columns, or (b) a downstream consumer needs the structured value.

### 5.4 Top-K render

Among all locked-or-broken trackers, sort by weighted score descending and render the top `V2_RENDER_TOP_K = 3`. Constant for now; UI knob deferred.

## 6. Bridge telemetry

Keep the `[channels]` prefix (existing agents and `session.log` consumers continue to work). Every v2 line gets an `algo=v2` tag plus the full per-tracker context. Two new verbs distinct from v1's set:

```
[channels] lock label=REG1 algo=v2 tf=H1 N=200 lockTime=2026-05-21 14:30 r=0.84 score=7.93 slope/h=+5.21 sigma=2.45 sig=support|H1|200|1779331800
[channels] break label=REG1 algo=v2 tf=H1 N=200 lockTime=2026-05-21 14:30 violator=2026-05-21 19:05 sigma=2.45 sig=support|H1|200|1779331800
[channels] hunt-reset label=REG1 algo=v2 tf=H1 N=200 (tracker resumed hunting)
```

| Verb | When |
|---|---|
| `lock` | Hunting phase fires the lock trigger |
| `break` | Locked channel's rail is violated for `CONFIRM_BREAK_BARS_V2` consecutive closes |
| `hunt-reset` | A broken channel's tracker allocates a fresh hunting state |
| `reset` | (existing v1 verb) — also fires for v2 on TF/range/dataset change |

`sigma=X.XX` is included on every `lock` and `break` line so downstream probabilistic / regime-detection models receive both **direction** (slope, score) and **volatility regime** (sigma) without needing to cross-reference state.

v1's existing verbs (`detect / freeze / drop / unfreeze`) continue to be emitted by v1 entries unchanged.

## 7. Integration with v1 pipeline

### 7.1 New state in `TradingResearchSandbox.tsx`

```ts
const [algoVersion, setAlgoVersion] = useState<'v1' | 'v2'>('v1')
```

Session-only (no localStorage). Promote to persistent if usage shows frequent toggling.

### 7.2 LeftNav switcher

A segmented pill (`v1 · v2`) appears in the Indicators section next to the Trendline checkbox. Renders only when `trendlineEnabled` is true. Same styling as existing `SegmentedToggle`.

### 7.3 Memo branch

```ts
const channelsMeta = useMemo<ChannelMeta[]>(() => {
  if (!trendlineEnabled || visibleCandles.length === 0) return []
  if (algoVersion === 'v1') {
    return runV1Pipeline(...)
  }
  return runV2Pipeline(visibleCandles, htfBundles, trackerStatesRef.current, playheadTime, ...)
}, [algoVersion, drawSwings, trendlineEnabled, visibleCandles, htfBundles, showResistance, showSupport])
```

### 7.4 Coexisting refs

| Ref | Owner | Reset on |
|---|---|---|
| `trackedChannelsRef` | v1 | TF / dataset / range change |
| `trackerStatesRef` | v2 | TF / dataset / range change |
| `labelRegistryRef.v1` | v1 | TF / dataset / range change |
| `labelRegistryRef.v2` | v2 | TF / dataset / range change OR algoVersion switch |
| `hiddenChannelLabels` | both | TF / dataset / range change OR algoVersion switch |
| `prevTrackedInfoRef` | log diff | TF / dataset / range change (and naturally rebuilt on algoVersion switch via memo re-run) |

Switching `algoVersion` doesn't clear either algorithm's tracker memory — flipping back restores prior state. Caveat: only the active algorithm's memo branch runs each tick, so the inactive algorithm's trackers freeze for the duration of the off-period. On re-activation they resume from current playhead without replaying missed ticks. Any lock or break event that would have fired during the off-period is silently lost — accepted trade-off for the simpler single-branch memo. If perfect cross-switch continuity becomes important later, run both branches every tick and switch only the render path.

### 7.5 New / changed files

| File | Change | Estimated LOC |
|---|---|---|
| `src/data.ts` | add `buildHigherBundle` | +30 |
| `src/hooks/useDatasets.ts` | load + expose `htfBundles` | +15 |
| `src/engine/regressionChannels.ts` | **new file** — `fitRegression`, `weightedScore`, `runV2Pipeline`, state-machine logic, constants | +250 |
| `src/components/TradingResearchSandbox.tsx` | `algoVersion` state, memo branch, switcher pass-through, split label registry | +60 |
| `src/components/LeftNav.tsx` | `algoVersion` prop, segmented pill render | +25 |

No changes to `RightPanels.tsx`, `engine/trendlines.ts`, `engine/drawing.ts`, or the chart effect.

## 8. Constants (all in `src/engine/regressionChannels.ts`)

```ts
export const MIN_R = 0.7
export const LOCK_PEAK_LOOKBACK_K = 5
export const LOCK_PEAK_CONFIRM_J = 2
export const CONFIRM_BREAK_BARS_V2 = 2
export const BREAK_EPS_FRAC_OF_SIGMA = 0.1   // bump to 0.25–0.30 if premature breaks observed
export const V2_RENDER_TOP_K = 3
export const V2_LOOKBACK_NS = [50, 100, 200] as const
export const V2_SWEEP_TFS = ['m5', 'm15', 'h1', 'h4'] as const
```

UI knobs for these are out of scope for v1.0; tune by editing the file. Promote to LeftNav inputs in a follow-up if tuning becomes frequent.

## 9. Testing plan

Manual via Electron, per project convention (no test suite exists). Verification scenarios:

1. Load default range (2026-05-21 00:00 → 20:00). Switch v1 → v2. Chart re-renders with v2 channel(s) — same styling.
2. Replay forward at 4× or 10×. Observe a `lock` line in `session.log` (look for `[channels] lock label=REG1 algo=v2 …`). Confirm a rigid channel appears on the chart.
3. Continue replay until a rail violation occurs. Confirm `[channels] break label=REG1 …` and the channel renders with broken styling (opacity 0.7, "BROKEN" pill in right panel).
4. Tune `BREAK_EPS_FRAC_OF_SIGMA` if breaks fire too readily on standard session-open volatility.
5. Switch v2 → v1 → v2 repeatedly. Confirm labels persist on both sides across switches (REG1 stays REG1, R1/S1 stay R1/S1). Confirm per-label hide clears on each switch (no stale REG1 silently hiding a future entry).
6. Change applied range to a different day. Confirm both v1 and v2 fully reset (counters restart at 1).
7. Apply a kind toggle (Resistance/Support off). Confirm v2 entries respect the same toggle (uptrend regression channels render under Support, downtrend under Resistance — per §5.1 `kind` mapping).
8. Hide a v2 entry via per-row click. Confirm it disappears from chart and dims in panel.

## 10. Reset triggers (consolidated)

| Trigger | v1 tracked | v1 labels | v2 trackers | v2 labels | hidden-labels |
|---|---|---|---|---|---|
| Active dataset change | clear | reset | clear | reset | clear |
| Applied range change | clear | reset | clear | reset | clear |
| `algoVersion` switch | preserve | preserve | preserve | reset | clear |

## 11. Deferred / out of scope

- **Hunting candidate preview render** (dimmer dashed line for the current best (TF, N) before lock). Adds visual signal but more code; revisit after first use.
- **`displayMetric` field on ChannelMeta** to replace the `touches` repurposing hack. Defer until panel redesign OR until a downstream consumer requires the structured value.
- **UI knobs** for `MIN_R`, `BREAK_EPS_FRAC_OF_SIGMA`, lookback set, TF set, top-K. Tune by editing constants for v1.0.
- **Persistent `algoVersion` in localStorage**. Add if usage shows frequent toggling.
- **CVD-aware regression** (regression on CVD instead of price). Could surface volume-divergence channels. Distinct feature.
- **Cross-algorithm channel correlation**: highlight when v1 and v2 agree on a channel region. Distinct feature.

## 12. Open questions

None — design is approved for implementation. Constants and the BREAK_EPS tuning are explicitly flagged as "tune during manual verification".
