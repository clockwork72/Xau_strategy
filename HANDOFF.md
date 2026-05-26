# XAU Algo · Handoff

Trading research sandbox: **Electron + Vite + React + TS + lightweight-charts v4**, fed by MT5 / OANDA Demo data for **XAUUSD.sml** (gold). Built for replay-driven price-action strategy R&D.

- **Project root**: `C:\Users\asus\Desktop\Xau_Algo`
- **Remote**: https://github.com/clockwork72/Xau_strategy (branch `main`, signed commits, ed25519 `5FD2393D65137501`)
- **Current branch**: `main`. v2 regression-channel experiment lives on `v2-trending-channels` (built, reverted, branch + spec + plan preserved as historical reference — see §10).

---

## 1 · Run

```bash
npm install
npm run electron:dev      # Electron + Vite HMR + DevTools detached
npm run dev               # browser-only at http://localhost:5173
npm run build             # Vite production build to dist/
npx tsc --noEmit          # TS check
```

⚠ **Renderer code hot-reloads via Vite HMR. `electron/main.cjs` does NOT** — restart `electron:dev` whenever you edit the main process (e.g. the session.log filter regex). Easy gotcha when iterating on logs.

---

## 2 · File map

```
Xau_Algo/
├── data/                                 # MT5 exports (kept as-is)
├── public/data/                          # CSVs Vite serves at /data/*
│   ├── xauusd_m1.csv
│   └── xauusd_m5.csv
├── electron/
│   ├── main.cjs                          # BrowserWindow + titleBarOverlay + window-state persist + IPC + log bridge ([draw]/[replay]/[channels])
│   └── preload.cjs                       # contextBridge: window.electronAPI.setTheme
├── src/
│   ├── App.tsx, main.tsx, index.css
│   ├── theme.ts                          # CSS-var refs + raw palettes export + ThemeMode + TITLE_BAR_CONTROLS_WIDTH
│   ├── types.ts                          # Candle, CvdCandle, Timeframe, DatasetBundle
│   ├── types/electron.d.ts               # window.electronAPI typing
│   ├── data.ts                           # CSV loader; sign-based CVD with 17 NY anchor + M5 drilldown into M1
│   ├── util/time.ts                      # Casa formatters + parseCasaLocalToUtcSec + casaSessionStartAtOrBefore (22:00 Casa anchor)
│   ├── hooks/
│   │   ├── useReplayController.ts        # replay window, playhead state, tick interval, keyboard, [replay] logs, findIndexForTime
│   │   ├── useDatasets.ts                # CSV load + timeframe + active selector + load status + dataBounds (for range validation)
│   │   └── useThemeSync.ts               # themeMode state + DOM/localStorage/IPC sync (chart re-apply stays in sandbox)
│   ├── engine/
│   │   ├── indicators.ts                 # computeEma
│   │   ├── sessions.ts                   # Asia/London/NY session defs
│   │   ├── swings.ts                     # findSwingHighs + findSwingLows (fractal-N)
│   │   ├── trendlines.ts                 # pickChannels + ChannelMeta (status field) + extendChannelToTime + findChannelBreak (asymmetric: derived-rail-only) + channelFingerprint + tuning constants
│   │   ├── strategy.ts                   # runStrategy — EMA-cross PLACEHOLDER (intact, unused)
│   │   ├── priceActionBeta.ts            # runPriceActionBeta — ACTIVE strategy. STATEFUL (PABState), look-ahead-free, paired sell+buy signals with SL/TP
│   │   ├── portfolio.ts                  # computeStats(signals, lotSize, balance, markPrice)
│   │   └── drawing.ts                    # DrawTool, DrawnLine (with chart field), snap, hit-test, HORIZONTAL_EXTEND_SEC
│   └── components/
│       ├── TradingResearchSandbox.tsx    # state owner + chart effects + channel tracking model (registry-based labels, permanent-freeze)
│       ├── TopBar.tsx                    # brand · TF · replay transport · scrubber · timecode · theme toggle · status · drag region
│       ├── LeftNav.tsx                   # instrument · TF · range picker (bounds-validated) · indicators · strategy
│       ├── RightPanels.tsx               # Strategy summary · Channels (grouped by kind, status pills, per-label hide) · Bar inspector · Notes
│       ├── StatusBar.tsx                 # Casa clock · symbol · bar count · hover
│       ├── SegmentedToggle.tsx           # sliding-indicator pill
│       ├── SessionOverlay.tsx            # session boxes on price pane
│       └── DrawToolbar.tsx               # floating vertical toolbar over chart (cursor/trendline/horizontal/snap/clear)
├── _design/                              # local-only Playwright verification scripts (gitignored)
│   ├── baseline-screenshot.cjs           # opens localhost:5173, screenshots default state
│   ├── inspect-dom.cjs                   # dumps buttons/inputs + their bounding boxes — selector discovery
│   ├── see-5m-support.cjs                # 5m TF, capture start + end states
│   ├── see-at-time.cjs                   # scrub playhead to specific bars, screenshot each
│   ├── see-2day-range.cjs                # load 2-day range, screenshot at chosen bars
│   ├── see-support-only.cjs              # 1-day vs 2-day comparison with resistance toggled off
│   ├── verify-2day-pab1.cjs              # binary-searches the 2-day bar matching 10:30, screenshots
│   └── screenshots/                      # PNG output Claude reads back via the Read tool
├── docs/superpowers/                     # design artifacts
│   ├── specs/
│   │   ├── 2026-05-24-trending-channels-v2-design.md       # v2 channel experiment (reverted but preserved — see §10)
│   │   └── 2026-05-24-price-action-beta-short-setup-design.md  # ACTIVE strategy spec (latest)
│   └── plans/
│       ├── 2026-05-24-trending-channels-v2.md
│       └── 2026-05-24-price-action-beta-short-setup.md     # plan executed; v1 in `main`
├── README.md
├── .gitignore                            # excludes node_modules/, dist/, session.log, .agents/
├── HANDOFF.md                            # this file
├── package.json, vite.config.ts, tsconfig.json, index.html
```

`session.log` is generated at runtime by `electron/main.cjs` for the agent bridge (see §6). Gitignored. `window-state.json` is at `app.getPath('userData')` — not in repo, persists window bounds + last theme.

---

## 3 · Critical gotcha · timezone offset (UNCHANGED)

OANDA MT5 demo reports bar times as **UTC+3** (EEST broker time), not real UTC. Fixed at ingest in `src/data.ts`:

```ts
const OANDA_MT5_TZ_OFFSET_SEC = -10800   // subtract 3h to convert CSV → real UTC
```

Assumes fixed UTC+3 year-round (no DST). On-disk CSVs not rewritten — shift is applied only at ingest. If Feb winter data reads 1h off vs TradingView, switch to a dynamic offset via `Intl.DateTimeFormat({ timeZone: 'Europe/Athens' })`.

---

## 4 · Data context

- **Account**: OANDA Global Markets · `OANDA_Global-Demo-1` · login `1715540085`
- **Symbol**: `XAUUSD.sml` (OANDA "small lot" gold; same prices as XAUUSD)
- **Digits**: 3, point = 0.001 → 1 pip ≈ $0.10 / oz
- **Contract size assumption** (for portfolio P&L): **100 oz / lot**. So `lotSize 0.01 = 1 oz`, $1 price move on 0.01 lot = $1 P&L.
- **History cap**: ~100,000 M1 bars on OANDA Demo (~70 trading days). M5 reaches a bit further. CSVs in repo end at **2026-05-22 ~22:30 Casa**.

### CVD computation (TradingView-aligned)

Mirrors Pine's `ta.requestVolumeDelta("1", "1D")` for `OANDA:XAUUSD`:

- **Classification**: sign-based — `close > open` → all `tick_volume` is buy; `close < open` → all sell; doji split 50/50. (Old body-weighted split is gone.)
- **Anchor reset**: **17:00 NY** (DST-aware via `America/New_York`), matching TV's default daily session for OANDA gold. Old 08:00 UTC reset is gone.
- **M5 candles drill into M1**: `buildM5Bundle(m5Rows, m1Rows)` walks the 5 underlying M1 bars per M5 window, classifies each individually, tracks the running cumulative through the window. `open` = cum at window start, `close` = cum at end, `high`/`low` = max/min during. M1 stays simple (one CVD candle per row).
- **Magnitudes won't match TV exactly** (MT5 tick_volume ≠ TV's spot vendor volume). What matches is shape, direction, drift trajectory, and reset points.

### Broker-closed filter
`src/data.ts:isBrokerClosed` drops daily settlement window + weekend. Removes ~10–11% of raw bars. Applied inside `parseRows()` — downstream functions never see broker-closed bars.

---

## 5 · Architecture overview

### State flow (single source of truth)
```
appliedRange (Casa → UTC seconds, default 2026-05-21 00:00–20:00)
   ↓ filter
replayWindow = active.candles ∩ appliedRange         (useReplayController)
   ↓ slice
visibleCandles = replayWindow.slice(0, playheadIdx + 1)
   ↓ feeds everything
   chart setData, EMA, swings, channels, drawn lines, strategy signals, portfolio stats
```

Time anchor: `replayPlayheadTime` (UTC seconds), NOT an index. Index `replayPlayhead` is derived via `findIndexForTime`. **TF switch is seamless** — same time anchor resolves to whatever bar exists at-or-before that time in the new TF's grid.

### Hooks (phase 1 extraction)
- `useReplayController(active, appliedRange)` — owns `replayWindow`, `visibleCandles`/`visibleCvd`, `replayPlayhead`, `replayPlayheadTime`, `replayPlaying`, `replaySpeed`, tick interval, keyboard shortcuts, `[replay]` log lines, `visibleCandlesRef` mirror. Includes `findIndexForTime`.
- `useDatasets()` — fetches M1 + M5 CSVs in parallel; exposes `data1m`, `data5m`, `active`, `timeframe`, `setTimeframe`, `loadStatus`, **`dataBounds`** (first/last bar time of active dataset; consumed by the range picker for out-of-bounds validation).
- `useThemeSync()` — `themeMode` state + DOM `data-theme` + localStorage + `electronAPI.setTheme` IPC. Chart-side re-`applyOptions` stays in the sandbox.

### Replay
- Default playhead = **end of window** (chart looks complete on load; Reset jumps to bar 0).
- Per-tick advancement reads `playheadTimeRef.current` (no effect re-subscription on every tick).
- Forward-step-by-1 uses `series.update(lastBar)` (incremental); any other change uses `setData()` (full).
- Controls live in the **TopBar**: SVG transport (Reset / −1 / Play-Pause / +1), speed pill (1/4/10/60×), scrubber, timecode block.
- Keyboard (active anywhere except in inputs): `Space` play/pause, `←/→` step ±1, `Shift+←/→` step ±10, `Home` reset, `End` jump to end.

### Range picker — bounds-validated (NEW)
`LeftNav` RangePicker receives `dataBounds` from `useDatasets`. Apply is disabled and a red "outside data range" warning shows when either start or end falls outside `[dataBounds.from, dataBounds.to]`. A hint line `data: <first bar> → <last bar>` is always visible. Prevents the previous silent failure where requesting a range past the data end produced an empty `replayWindow` and a stale-looking chart.

### Algorithm window — `algoCandles` (session-anchored, range-independent)
The data the **algorithm** sees is decoupled from the data the chart **renders**. Two derived candle slices:

- `visibleCandles` — what the chart shows. Drives candle setData, EMA overlay setData, CVD, draw tool, marker rendering, the per-trade visualization line series. Range-restricted: bars in `active.candles ∩ appliedRange ∩ [0, playhead]`.
- `algoCandles` — what the algorithm sees. Drives the channel detector (`pickChannels` + `findChannelBreak`), the strategy's `EMA(21)` lookup, the strategy entry/exit evaluation. **Pulled from the FULL dataset**, restricted to `[casaSessionStartAtOrBefore(playhead), playhead]`. Independent of the loaded range.

**Session anchor** = `22:00 Casa local` (= NY close / Asia open on the FX day clock). DST-safe via `casaOffsetMinutesAt` in `util/time.ts`. The "session day" runs from one 22:00 Casa to the next.

**Why this exists:** without it, loading a wider date range changed which channels `pickChannels`'s touch-scoring picked as winners, which broke trade reproducibility ("PAB-1 fires on the 1-day load but not on the 2-day load even though the playhead time is the same"). With session-anchored `algoCandles`, the algorithm at any playhead T sees bars in `[T's session-start, T]` — same input regardless of how much history is loaded → same channels → same trades.

**No look-ahead.** All bars in `algoCandles` satisfy `time ≤ playhead`. The strategy still only evaluates entries on the playhead bar; exits scan past bars (pure price data, no channel knowledge).

**Two parallel swing sets** (in `TradingResearchSandbox.tsx`):
- `drawSwings` — on `visibleCandles`, for the draw-tool snap targeting visible pivots.
- `algoSwings` — on `algoCandles`, for channel detection.

**Visual side-effect to be aware of:** when the loaded range starts at e.g. `21-00:00` but the session anchor is `20-22:00`, the algorithm uses ~2h of pre-range data. Channels detected with anchors in that pre-range window will visually appear to start at the left edge of the chart (the off-range anchor is invisible). This is acceptable for normal full-session loads. Sub-session loads (e.g. `21-10:00 → 20:00`) get the same algorithmic behavior since `algoCandles` is pulled from the dataset, not the loaded range.

### Trendline channels — detection + lifecycle

**Detection** (`engine/trendlines.ts:pickChannels`)
- `findSwingHighs/Lows(visibleCandles, lookback=7)` — fractal pivots.
- For each pivot pair `(i, j)`: compute slope, count swings within `ε = midPrice * TOUCH_PCT (0.0006)` (~$2.70 on $4500 gold) of the implied line. Sort by touches desc, greedy-reject time-range overlaps within kind.
- Filters: **`MIN_TOUCHES = 3`** (lowered from 4 — channels appear once the 3rd pivot confirms instead of waiting for the 4th), `MIN_TOUCHES_PER_HOUR = 0.4` (rejects sparse-stale lines — max span for 3-touch ≈ 7.5h), greedy non-overlap within kind. Cross-kind overlap is allowed (block commented out in sandbox).
- Derived parallel rail: anchored at the `DERIVED_RAIL_PCT = 0.05` percentile extreme (skip top 5%, then take the next) so a single-bar spike doesn't yank the rail far from the price action.

**Extension + break detection**
- `extendChannelToTime(c, t)` — extrapolates both rails along the same slope to `t`. No-op if `t ≤ c.endTime`. Sandbox calls this with `breakT ?? lastVisibleTime`.
- `findChannelBreak(c, candles, eps)` — scans bars strictly after `c.endTime`; returns the time of the FIRST close in the earliest run of `CONFIRM_BREAK_BARS = 2` consecutive closes that break the **DERIVED PARALLEL rail** by `> eps`. **Asymmetric** (updated 2026-05-24, commit `d0995ce`):
  - `kind='support'` → touch-anchored at lower; freezes on **upper** break only. Lower-rail breaks return null → channel stays live → `pickChannels` gets to refit with the new low absorbed next tick.
  - `kind='resistance'` → touch-anchored at upper; freezes on **lower** break only. Upper-rail breaks return null → refit path.
  - Rationale: touch-anchored rail break = the trend line itself is being tested → let the algorithm move it. Derived parallel break = genuine counter-trend structural failure → freeze.
- `channelFingerprint(c, eps)` — exported but currently unused by the tracker (identity-based dedup replaced it). Available if you ever need fuzzy `(kind, ≈slope, ≈y-intercept)` matching.

**Tracking model** (`TradingResearchSandbox.tsx:channelsMeta`)
- Channels are stateful across replay ticks. Identity = `(kind, startTime)`. Storage: `trackedChannelsRef: Map<key, ChannelMeta>` where key = `live|kind|startTime` or `frozen|kind|startTime|breakTime`. `ChannelMeta` carries a `status: 'live' | 'broken'` field.
- **Persistent label registry**: `labelRegistryRef = { counters, byIdentity: Map<identity, label> }`. The same identity always gets the same label within a session — eliminates the `S1→S2→…→S14` inflation loop that happened when a channel dropped for one tick and re-detected.
- **Permanent-freeze rule** (added 2026-05-24): once an identity has frozen, refinement passes cannot un-freeze it. Implementation: prev frozens are indexed by identity at the top of the memo; raw channels matching a prev-frozen identity are SKIPPED in processing (not re-fitted, not unfrozen). The carry-over loop moves the original frozen entry forward unchanged. CONFIRM_BREAK_BARS=2 already filters single-bar wobbles, so a recorded break is solid evidence and stays put. This intentionally breaks the prior "replay end-state matches single-shot detection" property in favor of chronological honesty — once the user sees "R1 broke at 14:25", R1 stays broken at 14:25 forever (until TF / dataset / range change).
- Each tick:
  1. **Reset detection in-memo**: compare `prevActiveRef`/`prevAppliedRangeRef` to current; if changed, log `[channels] reset (cleared N tracked)`, clear tracked + label registry + prevTrackedInfo.
  2. **Index prev frozens by identity** (the permanent-freeze map).
  3. **Process raw channels**: skip any whose identity is in prev-frozens (preserved); for the rest, run break detection. Label lookup via registry (reuse if known, else mint from counter). Write `live|...` or `frozen|...|breakT`.
  4. **Carry-over**: every prev frozen whose `endTime ≤ lastTime` moves into next. Backward scrub past a break drops the frozen entry (the only legitimate un-freeze path).
- Net behavior: same line refined across ticks updates in place (label preserved) UNTIL it freezes. After that, the frozen entry is permanent within the session.

### `[channels]` log events
Diff effect (`useEffect([channelsMeta])`) compares previous tracked keys against current and emits:
- `[channels] detect label=S1 kind=support touches=4 anchors=...@...//...@... slope/h=... sig=...` — new live key
- `[channels] freeze label=S1 kind=support break=... sig=...` — new frozen key
- `[channels] drop label=S1 kind=support` — live key gone, no new frozen with same identity (transient dropped)
- `[channels] unfreeze label=S1 kind=support` — frozen key gone (backward scrub past break)
- `[channels] reset (cleared N tracked)` — emitted in-memo on TF/range/dataset change

Note: with the permanent-freeze rule, `unfreeze` should now only fire on backward-scrub, never on forward refinement. If you ever see `unfreeze` followed by detect+freeze in continuous forward play, the permanent-freeze invariant has been broken — investigate.

### Channel rendering on chart
- Pool of LineSeries pairs (`channelsSeriesPoolRef`). Per-channel: `res` line (upper rail) + `sup` line (lower rail), both in `colors.accent`.
- Marker at the channel's left anchor: `R1`/`R2`/… for resistance (aboveBar on upper rail), `S1`/`S2`/… for support (belowBar on lower rail).

### Channels panel (right side · `RightPanels.tsx`)
Redesigned 2026-05-23:
1. **Grouped by kind** — two `KindSection`s (Resistance, Support). Each section's header is the `KindHeader` (the kind toggle): filled/hollow dot, kind name, count or `off` text.
2. **Per-row** — clickable button showing label, **LIVE/BROKEN pill**, touch count. Click toggles hide for that channel.
3. **Per-label hide** — `hiddenChannelLabels: Set<string>` keyed by stable label (R1/S4/…). Labels survive flap, freeze, backward scrub, and kind-toggle cycles thanks to the persistent label registry, so hides stick. Cleared when TF / dataset / range / algoVersion changes. The old broken sig-keyed hide (which died on any pivot refinement because `endTime` shifted) is gone.
4. **Header `extra` shows visible/hidden** — `5 · 2 hidden` when any rows are hidden. A "show all" link clears the hide set.

### Strategy — `runPriceActionBeta` v1 (Price Action Beta · Short Setup)
Built 2026-05-24. Spec at `docs/superpowers/specs/2026-05-24-price-action-beta-short-setup-design.md`.

**What it trades**: shorts off the top rail of a live, rising support channel when price still sits above EMA(21) and the entry bar prints `upper_wick > body`. Fixed 1:3 RR, stop pinned to entry candle high + buffer.

**Signature** — stateful, no look-ahead:
```ts
runPriceActionBeta(
  candles: ReadonlyArray<Candle>,
  liveSupportChannels: ReadonlyArray<ChannelMeta>,  // status='live', kind='support', filtered by caller
  ema21ByTime: Map<number, number>,                 // sandbox computes EMA(21) in dedicated memo, independent of overlay length
  prevState: PABState,
): PABState
```

**Critical: NO LOOK-AHEAD**. Entries are evaluated ONLY on the playhead bar (the last bar in `candles`). Historical bars are never re-evaluated for entries — at the time those bars were the playhead, the strategy already had its chance. This eliminates the classic backtest bias where historical bars would be evaluated using channels-as-known-now (which didn't exist yet at that historical time).

**Critical: RANGE-INDEPENDENT**. The caller passes `algoCandles` (session-anchored slice of the full dataset — see "Algorithm window" above), not `visibleCandles`. So the strategy's input at any playhead time T is identical regardless of which range the user loaded. Same playhead → same channels → same trade.

Exits scan forward from `open.entryTime` up to the playhead, using ONLY price data (`bar.high` vs SL, `bar.low` vs TP). Pure price — no channels — so scanning over skipped bars (e.g. user scrubbed forward) introduces no bias.

**PABState** (sandbox holds in a ref):
```ts
{ signals: Signal[], lastProcessedTime: number }
```
**Signals are the single source of truth.** The open trade and the running `tradeCount` are **derived fresh from signals** on every call — never stored separately. This makes backward-scrub pruning automatically clean up both derived values (fixes ID inflation and phantom-trade bugs from a prior design that stored them).

- Idempotent — repeated calls with the same playhead return the same state.
- Backward scrub — signals with `time > playhead` are pruned; `open` is recomputed from the pruned signals (the trailing unmatched `sell` with full metadata becomes the open trade, or `null`).
- Reset on TF / range / dataset / strategy-toggle change (`pabSettingsKeyRef` mirrors the channels tracker pattern).

**Output**: `state.signals` is the existing `Signal[]` shape — alternating `sell` (entry at close) + `buy` (synthetic exit at SL or TP). Entries carry `sl`, `tp`, `channelLabel` metadata; exits carry `reason: 'stop' | 'target'`. `computeStats` in `portfolio.ts` pairs them **by label** (not by alternation) — see Portfolio below.

**Constants** (file-level in `priceActionBeta.ts`, no UI knob in v1):
- `STOP_BUFFER_PCT = 0.0002` (~$0.90 on $4500 gold above entry-bar high)
- `RR = 3` (fixed 1:3)
- Proximity threshold = `TOUCH_PCT = 0.0006` (imported from trendlines.ts)
- EMA length = 21
- `MIN_BODY_TO_RANGE = 0.15` — doji filter on the entry candle (body must be ≥ 15% of total candle range; rejects dojis + spinning tops where `upper_wick > body` is trivially satisfied)

**Same-bar SL+TP collision**: stop wins (pessimistic).

**Placeholder**: `runStrategy(candles)` in `src/engine/strategy.ts` (original EMA-cross). Swap import in `TradingResearchSandbox.tsx` to revert.

### Portfolio
- `computeStats(signals, lotSize, balance, markPrice) → StrategyStats` in `src/engine/portfolio.ts`.
- **Two pairing models** auto-selected per call:
  - **Label-paired** (PAB-style, when any signal carries a `label`): sells with `sl/tp` are entries, buys with `reason` are exits; entries pair with exits by matching `label`. Open trades = entries with no matching exit. Orphan signals dropped. This avoids the "consecutive sells fabricate a phantom long" bug that the old alternating model produced for explicit short-entry/short-exit pair semantics.
  - **Alternating-flip** (fallback for unlabeled signals): each new signal closes the previous open and flips side. Kept so the EMA-cross placeholder still works if re-enabled.
- `ClosedTrade` carries `label`, `sl`, `tp`, `rMultiple`, `reason`, `channelLabel` when the entry signal had them — RightPanels uses these to render the trade-by-trade list.

### Trade visualization on the price chart (MetaTrader-style, per trade)
For every closed trade + the live open trade, three `LineSeries` segments are drawn on the price chart (pool kept in `tradeVizPoolRef`, grows on demand):
- **Connector** — solid line from `(entryTime, entryPrice)` to `(exitTime, exitPrice)`. Color: green if profit, red if loss. For the open trade, exit point = `(playheadTime, markPrice)` and updates each tick.
- **SL segment** — red dashed line from entry to exit at the stop price.
- **TP segment** — green dashed line from entry to exit at the target price.

The legacy infinite SL/TP `createPriceLine` overlays were removed in favor of these scoped segments. Sell/buy arrow markers stay; exit markers show `±NR` text (e.g. `PAB-1  +3.0R`).

### Strategy panel (right side · `RightPanels.tsx::StrategySummary`)
Direction A layout (the "minimal lines + summary" of the trade-viz redesign):
- **LIVE card** (only when an open trade has SL/TP) — `● LIVE  PAB-N  SHORT  ch=S1` header, entry / SL / TP / now rows with prices and R-multiples; left-accent border identifies it as the active position.
- **One-line summary**: `N closed · WW/LL · +$X realized · $Equity ±N%`.
- **Closed trades list** (newest first): `PAB-K  ±NR  ch  reason  Nm` per row.
- **Settings** at the bottom: lot size + starting balance inputs.

### Draw tool (`engine/drawing.ts` + `components/DrawToolbar.tsx`)
Floating vertical toolbar pinned to the top-left of the price chart.

**Tools**
- **V · Cursor** (default). Click a drawn line to select it. `Delete`/`Backspace` removes selection.
- **T · Trendline** — 2-click diagonal line. Anchors snap to nearest pivot if snap on (price chart only).
- **H · Horizontal** — 1-click horizontal line. Renders via `series.createPriceLine` so it doesn't affect the time-scale extents. Extends `HORIZONTAL_EXTEND_SEC` (30 days) forward visually.
- **S · Snap** toggle — when on, anchors snap to nearest swing high/low or raw candle H/L within 8px.
- **Trash** — clears all drawn lines.

**CVD chart drawing**
- Both charts subscribe to clicks via `makeClickHandler(chartId, chart, series, withSnap)` factory in the sandbox. CVD passes `withSnap=false`.
- `DrawnLine.chart: 'price' | 'cvd'` tags each line. The render effect routes each line to its chart. Cursor hit-test on each chart only considers lines on that chart.
- Trendline cross-chart restart: if anchor1 is on price and the second click lands on CVD (or vice versa), the in-progress line is discarded and the new click becomes anchor1 on the new chart. Log line notes `(cross-chart restart)`.

**Keyboard**: `V`/`T`/`H`/`S`, `Esc` clears working anchor + deselects + back to cursor, `Del`/`Backspace` removes selection.

### Charts
- Two stacked `createChart` instances (price + CVD). Time scales synced via `subscribeVisibleLogicalRangeChange`. Crosshair synced via `subscribeCrosshairMove` (try/catch — `setCrosshairPosition` throws "Value is null" during transient empty data; keep the guard).
- All times rendered in Casablanca (IANA `Africa/Casablanca`, DST-aware). Internal data stays real UTC.
- Chart colors must be real hex strings, NOT CSS vars (lightweight-charts doesn't resolve vars). The component reads `colors = palettes[themeMode]` and passes hex to `createChart` / `applyOptions` / series. A dedicated theme-sync `useEffect` re-`applyOptions` on every series when `themeMode` flips.

### Theme system (light + dark)
- **DOM styling** uses CSS variables. `theme.ts` exports `theme.bg = 'var(--theme-bg)'`, etc. Components keep using `theme.x` in inline styles — the variables are defined in `src/index.css` scoped to `[data-theme="dark"]` and `[data-theme="light"]`.
- **Chart-side code** uses `palettes[mode]` directly (raw hex). The component imports `palettes`, `ThemeMode` from `theme.ts`.
- **Theme toggle** is a sun/moon icon in TopBar. Click flips `themeMode`. State persists in `localStorage` under `xau:theme` AND in `window-state.json` (so first paint is correct, no flash).
- `main.tsx` reads `localStorage` and sets `document.documentElement.dataset.theme` before React renders.
- `useThemeSync` handles DOM/localStorage/IPC; the chart re-apply effect stays in the sandbox (touches chart refs).
- Light palette tweaks: `accent = #2563eb`, `warn = #b8860b` (darker yellow for white-bg contrast). Up/Down stay `#26a69a` / `#ef5350`.

### Electron custom title bar
- `titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height: 44 }` — Win11 native min/max/close on the right, themed colors, snap-aware. Height matches `sizes.topbar = 44`.
- **TopBar IS the drag region** — `WebKitAppRegion: 'drag'` on the header, `'no-drag'` on every interactive Group. Right padding = `TITLE_BAR_CONTROLS_WIDTH = 140` reserves space for the OS controls.
- **Window state persistence** — bounds + maximized + theme saved to `app.getPath('userData')/window-state.json` on resize/move/close.
- **IPC bridge** — `electron/preload.cjs` exposes `window.electronAPI.setTheme(mode)`. Main handles `set-theme` → `mainWindow.setTitleBarOverlay({...})` + persists.

### Session logging (agent bridge — important)
- `electron/main.cjs` hooks `webContents.on('console-message', ...)`.
- Filter: lines starting with `[draw]`, `[replay]`, `[channels]`, or `[strategy]`.
- Writes ISO-timestamped to `session.log` at project root. Cleared on every session start.
- **Use case**: agents `Read session.log` to see what the user did + what the algorithm did, without screenshots.
- **Gotcha**: `electron/main.cjs` does NOT hot-reload — edit it, restart `electron:dev`.

### `[strategy]` log events (Price Action Beta)
- `[strategy] entry label=PAB-1 ch=S1 close=... rail=... ema=... SL=... TP=... R=...` — short opened on the playhead bar
- `[strategy] exit label=PAB-1 reason=stop|target price=... at=<unix ts>` — short closed by SL/TP scan
- `[strategy] skip-armed ch=S1 close=... rail=... reason=already-short` — conditions fired on the playhead bar while a position is still open (informational; one log per qualifying channel per playhead bar)

---

## 6 · WIP / Next moves

### Iterate Price Action Beta v1
v1 strategy is BUILT (see Strategy section in §5 and the spec). Fine-tuning lives in:
- `STOP_BUFFER_PCT`, `RR`, `MIN_BODY_TO_RANGE`, EMA length — file-level constants in `priceActionBeta.ts`.
- Optional follow-ups (deferred): RSI / volume / time-of-session filters; trail-stops / partial closes; UI tuning knobs.
- The Second-Entry state-machine idea from the original handoff is NOT what was built — v1 is the support-channel top-rail rejection short, not a second-entry pattern. If second-entry is wanted, that's a separate strategy file (don't overload `priceActionBeta`).

### Channel labels by trend direction (DT/UT) — proposed, not implemented
User-requested rename: instead of `S1/R1` (which describe *which rail is touch-anchored*), label channels by *trend direction*: `DT1` for negative-slope, `UT1` for positive-slope. The internal `kind: 'support' | 'resistance'` field would stay (the asymmetric freeze rule depends on which rail is touch-anchored) — only the displayed label changes. Where to wire: `withChannelMeta`/label registry in `channelsMeta` memo + the kind sections in `RightPanels.ChannelsList`.

### Sandbox refactor — phase 2
Phase 1 extracted `useReplayController`, `useDatasets`, `useThemeSync`. Phase 2 candidates:
- `useChartInstances` — chart creation + sync + teardown + chart-side theme re-apply. ~280 lines out of the sandbox.
- `useChannels` — channel detection + tracking + render pool (now ~200 lines after registry / status / permanent-freeze additions).
- `useDrawTool` — keyboard + chart-click handlers + render map. ~200 lines.
- After phase 2, sandbox ≈ 250–300 lines (orchestrator + JSX only).

### Trendline tuning knobs (currently hard-coded)
- `TRENDLINE_LOOKBACK = 7` (in `TradingResearchSandbox.tsx`)
- `TOUCH_PCT = 0.0006`, **`MIN_TOUCHES = 3`**, `MIN_TOUCHES_PER_HOUR = 0.4`, `DERIVED_RAIL_PCT = 0.05`, `CONFIRM_BREAK_BARS = 2` (all in `engine/trendlines.ts`)
- If wide ranges start showing weak channels again, the density threshold or the percentile are the first knobs to tune. UI inputs deferred.

### Trendline algorithm — known deferred items
- Hard span cap (rejected once because it would kill the user's 16h `S1`; density filter does this job without false positives so far).
- Re-enable cross-kind non-overlap (commented block in sandbox).
- **Fingerprint-based identity** — currently identity is `(kind, startTime)`. Refined channels that shift their first-anchored pivot would become a new identity → new label. `channelFingerprint` is written but unused; switch to fuzzy `(kind, ≈slope, ≈y)` matching if startTime drift becomes a problem in practice.
- A refinement that finds a *different* slope at the same `startTime` after a freeze is silently skipped (permanent-freeze rule still applies, just freezes are now rarer with the asymmetric rule). If you want both the frozen original and the refined version visible simultaneously, that requires fingerprint-based identity.

### Draw tool — deferred items
- Drag-to-move endpoints (currently no edit, only delete+redraw)
- Right-extension toggle for trendlines (horizontals already extend)
- Ray tool
- Per-line right-click context menu
- Undo (ring buffer)
- Per-line color
- Snap on CVD chart (currently disabled — CVD pivots are conceptually different)

### Other
- CSV portability: bake the −3h timezone shift into the Python exporter so on-disk CSVs are real UTC.
- DST verification: scroll to **February data** and cross-check vs TradingView; switch to dynamic offset if 1h off.
- Session H/L lines (port from user's Pine).
- Installer / packaging via `electron-builder`.
- Mica / Acrylic background material on Windows 11.

---

## 7 · Coding conventions

- **Anti-slop guards on**: no purple gradients, no emoji icons, no rounded-card-with-left-border accent, no fabricated stats. SVG icons only when needed.
- **Theme tokens only** (`src/theme.ts`). DOM uses CSS vars via `theme.x`. Chart code uses `palettes[mode].x` raw hex. No new colors invented in components.
- **Casablanca display, real UTC under the hood**. Sessions defined in real UTC, DST-agnostic.
- **Honest placeholders** over half-done implementations. Bar Inspector starts empty with `— hover a bar`.
- **No comments narrating WHAT code does** — only WHY when non-obvious.
- **Karpathy guidelines**: surface assumptions and tradeoffs before coding; surgical changes; no abstractions for single-use code; verify before claiming done.
- **Commits**: short titles, no co-author trailer (per project owner preference).

---

## 8 · Caveats

- **No tests**. Manual verification via Electron window + `session.log` telemetry inspection is the verification loop. `npx tsc --noEmit` is the only automated gate.
- **`electron/main.cjs` does NOT hot-reload** — restart `electron:dev` after editing it. Vite HMR handles renderer changes.
- **OANDA Demo history cap** is ~100k M1 bars. Scrolling back won't trigger backfill. CSVs in repo end 2026-05-22 ~22:30 Casa; range picker now hard-rejects requests past `dataBounds.to`.
- **lightweight-charts pinned v4.2.3**. v5 has breaking API changes.
- **CVD magnitudes don't match TV** (different vendor volumes). Shape/direction/anchor points should match.
- **Asymmetric freeze rule** (2026-05-24, commit `d0995ce`): freezes happen only on a confirmed break of the **derived parallel rail** (support → upper; resistance → lower). Touch-anchored rail breaks return null from `findChannelBreak` and let `pickChannels` refit the channel on the next tick. Permanent-freeze still applies — once frozen, stays frozen — but freezes are now rarer and only fire on genuine counter-trend structural failures.
- **No look-ahead in the strategy** (`runPriceActionBeta`): entries fire ONLY on the playhead bar; never re-evaluated for historical bars. State carried across replay ticks via `pabStateRef` in the sandbox. Backward scrub prunes signals; open trade is re-derived from the pruned signals.
- **Range-independent algorithm window** (2026-05-24, commit `86dd360`): channel detection, EMA(21), and the strategy all read `algoCandles` = full-dataset bars in `[casaSessionStartAtOrBefore(playhead), playhead]`. Same playhead time → same algorithmic output, regardless of how much history the user loaded. Trade-off: channels with anchors before the loaded range's start render visually as starting at the chart's left edge.
- **Channel tracking by exact `startTime`** — if a refined channel's `startTime` drifts to an earlier swing, identity changes and the label increments (fresh slot in the registry). Hasn't been observed in practice on this dataset.
- **`useMemo` mutates `trackedChannelsRef`** — deliberate cache pattern. Mutations are idempotent (Map set/delete by stable key) so StrictMode double-invoke is safe.
- **titleBarOverlay is Windows/Linux only**. On macOS would need `titleBarStyle: 'hiddenInset'`.
- **`npm audit`**: 2 moderate vulnerabilities in transitive Vite deps. Dev-only paths.
- **GPG signing**: repo-local `user.signingkey = 5FD2393D65137501` (ed25519, no passphrase). Global config references an expired key — other repos will fail to sign until that's updated.
- **session.log is gitignored**. Don't commit it.
- **Playwright verification harness** lives in `_design/` (gitignored). Playwright `1.60.0` is not a project dep but is cached at `C:\Users\asus\AppData\Local\npm-cache\_npx\e41f203b7505f1fb\node_modules\playwright`. To run any `_design/*.cjs` script: `NODE_PATH="C:/Users/asus/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules" node _design/<script>.cjs`. The Chromium binary lives at `C:\Users\asus\AppData\Local\ms-playwright\chromium_headless_shell-1223\` (one-time `npx playwright install chromium`). The dev server must be running on `http://localhost:5173` (`npm run dev`). Scripts drive the chart, scrub the playhead, and screenshot to `_design/screenshots/`; Claude `Read`s the PNGs to inspect results visually.

---

## 9 · Commit history (recent → old)

```
86dd360 algo: session-anchored window (22:00 Casa = NY close / Asia open) makes channels + trades range-independent
bca3a51 Revert "algo: use range-independent 24h window from full dataset…"
e6852d5 algo: use range-independent 24h window from full dataset …       (reverted by bca3a51)
181f874 price action beta: skip doji entries (body must be ≥15% of candle range)
4842609 trade viz: MetaTrader-style per-trade segments (entry-exit connector + SL/TP segments)
d01fb39 portfolio: pair signals by label (fix phantom trades from sell+buy semantic mismatch)
5e8a558 price action beta: derive open + tradeCount from signals (fix ID inflation + phantom trades on replay)
fccd038 trade viz: SL/TP price lines on open trade, exit markers show ±NR, redesigned strategy panel
ae461e5 handoff: price action beta v1 + asymmetric channel freeze rule
d0995ce channels: freeze only on derived-rail break, touch-anchored break lets pickChannels refit
48be2c6 price action beta: stateful, no look-ahead — entries only at playhead
ada66cb electron: forward [strategy] console lines to session.log
1f9c119 sandbox: feed live support channels and EMA21 map into strategy
862956c price action beta: implement short setup off support top rail
f6b749c price action beta short setup implementation plan
6badfcc price action beta short setup design spec
9655d81 channels: freeze is permanent within session, refinement cannot un-freeze
b40d17e docs: v2 trending channels implementation plan
1f40e34 range: validate against data bounds, show range hint in picker
05eb62c trendlines: lower MIN_TOUCHES from 4 to 3 for earlier detection
a208e6d channels: persistent label registry, status field, panel redesign, per-label hide
5492339 handoff: refresh file map and recent-changes notes
7dbd96b v2 trending channels design spec
137e8b2 track channel lifecycle, draw on cvd chart
419166a extend trend channel rails forward to current replay edge
01e4f61 phase 1 refactor: extract sandbox state into hooks
9ec7a74 match TradingView CVD: sign-based delta, 17 NY anchor, M5 drills into M1
2880e79 update handoff for current state
5d7118b channel kind toggles above the per-channel list
44d7b87 Revert "right panel kind toggles, sticky across replay"
3aebc66 right panel kind toggles, sticky across replay
65e4eb7 revert channels mask to labels + single trendline toggle
ab27051 remove channels section from right panel
b33374f channels panel row click toggles its kind
dc1e853 persist per-channel hide via geometric fingerprint
e365f75 hide rails per kind, including derived parallel rails
20176a8 split trendline toggle into resistance and support
a7876e1 channel labels and per-channel mask
9bd8493 draw tools, light theme, custom title bar
f6dd729 Initial commit
```

**Recent session additions (2026-05-23 → 2026-05-24):**
- Persistent label registry (no more `S1→S2→…→S14` inflation on flap/scrub/toggle)
- `ChannelMeta.status: 'live' | 'broken'` field; right panel redesigned with grouped kind sections + LIVE/BROKEN pills + per-label hide
- `MIN_TOUCHES` lowered 4→3 for earlier detection (density filter still caps span)
- Range picker validates against `useDatasets.dataBounds` — out-of-data ranges rejected with clear hint
- Permanent-freeze rule — once frozen, refinement cannot un-freeze (`9655d81`)
- **Price Action Beta v1 BUILT** — support-channel top-rail rejection short, 1:3 RR, stateful + no look-ahead (`862956c`, `1f9c119`, `ada66cb`, `48be2c6`). Spec + plan committed (`6badfcc`, `f6b749c`).
- **Asymmetric freeze rule** — only derived-rail breaks freeze; touch-anchored breaks let `pickChannels` refit (`d0995ce`).
- **Trade visualization v1** — LIVE card + closed-trades list in the Strategy panel (`fccd038`); MetaTrader-style per-trade segments on the price chart (connector + SL/TP segments per trade) (`4842609`).
- **PAB state refactor** — `open` and `tradeCount` derived fresh from `signals` each call; fixes ID inflation on replay and phantom-trade pairing bugs (`5e8a558`).
- **Portfolio label-paired model** — `computeStats` pairs labeled signals by `label` instead of alternation; alternation kept as fallback for unlabeled signals (placeholder EMA-cross) (`d01fb39`).
- **Doji filter** — entries reject candles where body < 15% of total range (`181f874`).
- **Range-independent algorithm window** — `algoCandles` = full-dataset bars in `[22:00 Casa session start, playhead]`; channels + EMA + strategy all read it instead of `visibleCandles`. Same playhead → same trades regardless of loaded range. Verified end-to-end via Playwright (`86dd360`).
- **Playwright verification harness** — `_design/*.cjs` scripts drive the live app, screenshot to `_design/screenshots/`, agent reads PNGs.

---

## 10 · v2 (Dynamic Linear Regression) — built, reverted, preserved

Between 2026-05-23 and 2026-05-24 an experimental v2 algorithm was designed, implemented across 16 commits on the `v2-trending-channels` branch, and reverted by user decision. Artifacts kept on `main` for future reference:

- **Spec**: `docs/superpowers/specs/2026-05-24-trending-channels-v2-design.md` (committed at `7dbd96b`)
- **Plan**: `docs/superpowers/plans/2026-05-24-trending-channels-v2.md` (committed at `b40d17e`)
- **Code**: branch `v2-trending-channels` (16 commits ahead of main; not merged; preserved locally — `git checkout v2-trending-channels` to inspect)

**Approach (per spec):** per-`(TF, N)` snap-and-hold state machine on a pre-aggregated M5/M15/H1/H4 sweep. Locked channels were rigid `regressionLine ± 2σ_e` projections; broke when close violated rails for `CONFIRM_BREAK_BARS_V2` consecutive bars. Top-K render by weighted score `|r| · log(TF_minutes · N)`. Selectable via a `v1 · v2` segmented pill in LeftNav.

**Why reverted:** in practice, multi-TF channels with long `N` produced wide `σ_e` (residual std over weeks of off-screen variance) and rendered visually unactionable rails on short replay windows. Restricting fits to visible-range bars (added near the end) helped but didn't recover the user's goal. v1 stays as the production algorithm.

**If revisiting:** the spec's open-questions are empty; the plan still applies. Most likely useful pieces if v3 happens — `buildHigherBundle` aggregator, `useDatasets.htfBundles`, the `algoVersion` switcher pattern, the `[channels] algo=v2 …` telemetry conventions. The snap-and-hold state machine is sound but the multi-TF visualization needs rethinking before re-deployment.

---

Last update: 2026-05-24 (commit `86dd360` — session-anchored algorithm window).
