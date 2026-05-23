# XAU Algo · Handoff

Trading research sandbox: **Electron + Vite + React + TS + lightweight-charts v4**, fed by MT5 / OANDA Demo data for **XAUUSD.sml** (gold). Built for replay-driven price-action strategy R&D.

- **Project root**: `C:\Users\asus\Desktop\Xau_Algo`
- **Remote**: https://github.com/clockwork72/Xau_strategy (branch `main`, signed commits, ed25519 `5FD2393D65137501`)

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
│   ├── util/time.ts                      # Casa formatters + parseCasaLocalToUtcSec
│   ├── hooks/
│   │   ├── useReplayController.ts        # replay window, playhead state, tick interval, keyboard, [replay] logs, findIndexForTime
│   │   ├── useDatasets.ts                # CSV load + timeframe + active selector + load status
│   │   └── useThemeSync.ts               # themeMode state + DOM/localStorage/IPC sync (chart re-apply stays in sandbox)
│   ├── engine/
│   │   ├── indicators.ts                 # computeEma
│   │   ├── sessions.ts                   # Asia/London/NY session defs
│   │   ├── swings.ts                     # findSwingHighs + findSwingLows (fractal-N)
│   │   ├── trendlines.ts                 # pickChannels + ChannelMeta + extendChannelToTime + findChannelBreak + channelFingerprint + tuning constants
│   │   ├── strategy.ts                   # runStrategy — EMA-cross PLACEHOLDER (intact, unused)
│   │   ├── priceActionBeta.ts            # runPriceActionBeta — ACTIVE strategy, currently STUB
│   │   ├── portfolio.ts                  # computeStats(signals, lotSize, balance, markPrice)
│   │   └── drawing.ts                    # DrawTool, DrawnLine (with chart field), snap, hit-test, HORIZONTAL_EXTEND_SEC
│   └── components/
│       ├── TradingResearchSandbox.tsx    # state owner + chart effects + channel tracking model
│       ├── TopBar.tsx                    # brand · TF · replay transport · scrubber · timecode · theme toggle · status · drag region
│       ├── LeftNav.tsx                   # instrument · TF · range · indicators (EMA, Sessions, Trendline) · strategy
│       ├── RightPanels.tsx               # Strategy summary · Channels (kind toggles + per-channel rows) · Bar inspector · Notes
│       ├── StatusBar.tsx                 # Casa clock · symbol · bar count · hover
│       ├── SegmentedToggle.tsx           # sliding-indicator pill
│       ├── SessionOverlay.tsx            # session boxes on price pane
│       └── DrawToolbar.tsx               # floating vertical toolbar over chart (cursor/trendline/horizontal/snap/clear)
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
- **History cap**: ~100,000 M1 bars on OANDA Demo (~70 trading days). M5 reaches a bit further.

### CVD computation (TradingView-aligned)

Mirrors Pine's `ta.requestVolumeDelta("1", "1D")` for `OANDA:XAUUSD`:

- **Classification**: sign-based — `close > open` → all `tick_volume` is buy; `close < open` → all sell; doji split 50/50. (Old body-weighted split is gone.)
- **Anchor reset**: **17:00 NY** (DST-aware via `America/New_York`), matching TV's default daily session for OANDA gold. Old 08:00 UTC reset is gone.
- **M5 candles drill into M1**: `buildM5Bundle(m5Rows, m1Rows)` walks the 5 underlying M1 bars per M5 window, classifies each individually, tracks the running cumulative through the window. `open` = cum at window start, `close` = cum at end, `high`/`low` = max/min during. M1 stays simple (one CVD candle per row).
- **Magnitudes won't match TV exactly** (MT5 tick_volume ≠ TV's spot vendor volume). What matches is shape, direction, drift trajectory, and reset points.

### Broker-closed filter
`src/data.ts:isBrokerClosed` drops daily settlement window + weekend. Removes ~10–11% of raw bars.

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

### Hooks (extracted phase 1)
- `useReplayController(active, appliedRange)` — owns `replayWindow`, `visibleCandles`/`visibleCvd`, `replayPlayhead`, `replayPlayheadTime`, `replayPlaying`, `replaySpeed`, tick interval, keyboard shortcuts, `[replay]` log lines, `visibleCandlesRef` mirror. Includes `findIndexForTime`.
- `useDatasets()` — fetches M1 + M5 CSVs in parallel; exposes `data1m`, `data5m`, `active`, `timeframe`, `setTimeframe`, `loadStatus`.
- `useThemeSync()` — `themeMode` state + DOM `data-theme` + localStorage + `electronAPI.setTheme` IPC. Chart-side re-`applyOptions` stays in the sandbox (phase 2 will move it into `useChartInstances`).

### Replay
- Default playhead = **end of window** (chart looks complete on load; Reset jumps to bar 0).
- Per-tick advancement reads `playheadTimeRef.current` (no effect re-subscription on every tick).
- Forward-step-by-1 uses `series.update(lastBar)` (incremental); any other change uses `setData()` (full).
- Controls live in the **TopBar**: SVG transport (Reset / −1 / Play-Pause / +1), speed pill (1/4/10/60×), scrubber, timecode block.
- Keyboard (active anywhere except in inputs): `Space` play/pause, `←/→` step ±1, `Shift+←/→` step ±10, `Home` reset, `End` jump to end.

### Trendline channels — detection + lifecycle

**Detection** (`engine/trendlines.ts:pickChannels`)
- `findSwingHighs/Lows(visibleCandles, lookback=7)` — fractal pivots.
- For each pivot pair `(i, j)`: compute slope, count swings within `ε = midPrice * 0.0006` (~$2.70 on $4500 gold) of the implied line. Sort by touches desc, greedy-reject time-range overlaps.
- Filters: `MIN_TOUCHES = 4`, `MIN_TOUCHES_PER_HOUR = 0.4` (rejects sparse-stale lines), greedy non-overlap within kind. Cross-kind overlap is allowed (block commented out in sandbox).
- Derived parallel rail: instead of through the absolute extreme high/low in the channel span, anchors at the **`DERIVED_RAIL_PCT = 0.05` percentile** extreme — sort opposite-side prices, skip top 5% — so a single-bar spike inside a long channel doesn't yank the rail far from price action.

**Extension + break detection**
- `extendChannelToTime(c, t)` — extrapolates both rails along the same slope to `t`. No-op if `t ≤ c.endTime`. Sandbox calls this with `breakT ?? lastVisibleTime`.
- `findChannelBreak(c, candles, eps)` — scans bars strictly after `c.endTime`; returns the time of the FIRST close in the earliest run of `CONFIRM_BREAK_BARS = 2` consecutive closes outside either rail by `> eps`. Returns null if no confirmed run. Filters single-bar wobbles.
- `channelFingerprint(c, eps)` — exported but currently unused by the tracker (identity-based dedup replaced it). Kept for future use.

**Tracking model** (`TradingResearchSandbox.tsx:channelsMeta`)
- Channels are stateful across replay ticks. Identity = `(kind, startTime)`. Storage: `trackedChannelsRef: Map<key, { meta, status: 'live' | 'frozen' }>` where key = `live|kind|startTime` or `frozen|kind|startTime|breakTime`.
- Each tick:
  1. **Reset detection in-memo**: compare `prevActiveRef`/`prevAppliedRangeRef` to current; if changed, log `[channels] reset (cleared N)`, clear tracked + label counters + prevTrackedInfo. Done inside the useMemo (NOT in a separate effect — a separate effect ran after the memo and wiped tracked before the log effect could see it, hiding all `detect` lines).
  2. **Index prev by identity** (covers live + frozen, in-view + out-of-view), preferring live on collision.
  3. **Process raw channels**: one entry per identity. If prev has same identity → inherit label. Else → assign next free from persistent counters (`labelCountersRef.current.R / .S`). If `findChannelBreak` returns non-null → write to `frozen|...|breakT`; else write to `live|...`.
  4. **Carry over prev frozen** whose identity wasn't re-detected AND whose `endTime ≤ lastTime`. Out-of-view (backward scrub) frozens are silently dropped; re-detected ones were replaced in step 3.
- Net behavior: same line refined across ticks updates in place (label preserved). Transient lines the detector stops producing are silently dropped — **no freeze**. Channels freeze only when their current refined form has a confirmed break. Backward scrub past a break un-freezes; if re-detected at the new playhead, the original label is restored. Labels are persistent counters per session (reset only on TF/range/dataset change), so labels never "shuffle" mid-session.

### `[channels]` log events
Diff effect (`useEffect([channelsMeta])`) compares previous tracked keys against current and emits:
- `[channels] detect label=S1 kind=support touches=4 anchors=...@...//...@... slope/h=... sig=...` — new live key
- `[channels] freeze label=S1 kind=support break=... sig=...` — new frozen key (covers live→frozen transition too — the prior live key's disappearance is detected and suppressed if a frozen with same identity just appeared)
- `[channels] drop label=S1 kind=support` — live key gone, no new frozen with same identity (transient dropped)
- `[channels] unfreeze label=S1 kind=support` — frozen key gone (backward scrub)
- `[channels] reset (cleared N tracked)` — emitted in-memo on TF/range/dataset change

### Channel rendering on chart
- Pool of LineSeries pairs (`channelsSeriesPoolRef`). Per-channel: `res` line (upper rail) + `sup` line (lower rail), both in `colors.accent`.
- Marker at the channel's left anchor: `R1`/`R2`/… for resistance (aboveBar on upper rail), `S1`/`S2`/… for support (belowBar on lower rail).

### Channels panel (right side · RightPanels.tsx)
Two layers (unchanged from before):
1. **Kind toggles** — `Resistance · N` and `Support · N` chips. Clicking flips `showResistance`/`showSupport`. When off, that kind is skipped at detection. Persists across replay scrubs (booleans gating `pickChannels`).
2. **Per-channel rows** — click to hide a specific channel for the snapshot. Keyed by `${kind}|${startTime}|${endTime}` — `endTime` shifts as pivots refine, so the hide **still breaks on replay scrub** by design. Use kind toggles for sticky hides.

### Strategy
- **Active**: `runPriceActionBeta(candles) → Signal[]` in `src/engine/priceActionBeta.ts`. Currently an **empty stub** returning `[]`. Second-entry state machine TBD.
- **Placeholder**: `runStrategy(candles)` in `src/engine/strategy.ts` (original EMA-cross). Swap import in `TradingResearchSandbox.tsx` to revert.

### Portfolio
- `computeStats(signals, lotSize, balance, markPrice) → StrategyStats` in `src/engine/portfolio.ts`.
- Pairs consecutive opposite signals into closed trades; trailing unmatched signal = open position, marked to `markPrice` (= last visible candle's close).

### Draw tool (`engine/drawing.ts` + `components/DrawToolbar.tsx`)
Floating vertical toolbar pinned to the top-left of the price chart.

**Tools**
- **V · Cursor** (default). Click a drawn line to select it. `Delete`/`Backspace` removes selection.
- **T · Trendline** — 2-click diagonal line. Anchors snap to nearest pivot if snap on (price chart only).
- **H · Horizontal** — 1-click horizontal line. Renders via `series.createPriceLine` so it doesn't affect the time-scale extents. Extends `HORIZONTAL_EXTEND_SEC` (30 days) forward visually.
- **S · Snap** toggle — when on, anchors snap to nearest swing high/low or raw candle H/L within 8px.
- **Trash** — clears all drawn lines.

**CVD chart drawing**
- Both charts subscribe to clicks via `makeClickHandler(chartId, chart, series, withSnap)` factory in the sandbox. CVD passes `withSnap=false` (price-domain pivots don't apply to cumulative values).
- `DrawnLine.chart: 'price' | 'cvd'` tags each line. The render effect routes each line to its chart (handle map remembers chart for cleanup). Cursor hit-test on each chart only considers lines on that chart.
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
- Filter: lines starting with `[draw]`, `[replay]`, or `[channels]`.
- Writes ISO-timestamped to `session.log` at project root. Cleared on every session start.
- **Use case**: agents `Read session.log` to see what the user did + what the algorithm did, without screenshots.
- **Gotcha**: `electron/main.cjs` does NOT hot-reload — edit it, restart `electron:dev`.

---

## 6 · WIP / Next moves

### Build Price Action Beta state machine
File: `src/engine/priceActionBeta.ts`. Use `findSwingHighs(candles, lookback)` for swing tracking, then implement the State 0/1/2 Second Entry logic. Emit `Signal[]` — markers + portfolio update come for free.

### Sandbox refactor — phase 2
Phase 1 extracted `useReplayController`, `useDatasets`, `useThemeSync`. Phase 2 candidates:
- `useChartInstances` — chart creation + sync + teardown + chart-side theme re-apply. ~280 lines out of the sandbox.
- `useChannels` — channel detection + tracking + render pool. Currently ~150 lines in the sandbox.
- `useDrawTool` — keyboard + chart-click handlers + render map. ~200 lines.
- After phase 2, sandbox ≈ 250–300 lines (orchestrator + JSX only).

### Trendline tuning knobs (currently hard-coded)
- `TRENDLINE_LOOKBACK = 7` (in `TradingResearchSandbox.tsx`)
- `TOUCH_PCT = 0.0006`, `MIN_TOUCHES = 4`, `MIN_TOUCHES_PER_HOUR = 0.4`, `DERIVED_RAIL_PCT = 0.05`, `CONFIRM_BREAK_BARS = 2` (all in `engine/trendlines.ts`)
- If wide ranges start showing weak channels again, the density threshold or the percentile are the first knobs to tune. UI inputs for these are deferred.

### Trendline algorithm — known deferred items
- Hard span cap (rejected once because it would kill the user's 16h `S1`; density filter does this job without false positives so far).
- Re-enable cross-kind non-overlap (commented block in sandbox).
- Similarity-based matching for channel identity (currently exact `startTime`). If `startTime` drifts earlier for a refined channel, it's treated as a new identity and label increments. Replace with fuzzy matching on `(kind, ≈startTime, ≈slope)` if seen in practice.

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

- **No tests**. Manual verification via Electron window is the only loop.
- **`electron/main.cjs` does NOT hot-reload** — restart `electron:dev` after editing it. Vite HMR handles renderer changes.
- **OANDA Demo history cap** is ~100k M1 bars. Scrolling back won't trigger backfill.
- **lightweight-charts pinned v4.2.3**. v5 has breaking API changes.
- **CVD magnitudes don't match TV** (different vendor volumes). Shape/direction/anchor points should match.
- **Per-channel sig-based hide breaks on replay scrub** — sig includes `endTime` which shifts as pivots refine. Use the kind toggles for sticky hides.
- **Channel tracking by exact `startTime`** — if a refined channel's `startTime` drifts earlier (new earlier swing fits), identity changes and label increments. Hasn't been observed in practice on this dataset.
- **`useMemo` mutates `trackedChannelsRef`** — deliberate cache pattern. Mutations are idempotent (Map set/delete by key) so StrictMode double-invoke is safe. Console.log of `[channels] reset` inside the memo can double-log under StrictMode dev (production single-logs).
- **titleBarOverlay is Windows/Linux only**. On macOS would need `titleBarStyle: 'hiddenInset'`.
- **`npm audit`**: 2 moderate vulnerabilities in transitive Vite deps. Dev-only paths.
- **GPG signing**: repo-local `user.signingkey = 5FD2393D65137501` (ed25519, no passphrase). Global config references an expired key — other repos will fail to sign until that's updated.
- **session.log is gitignored**. Don't commit it.

---

## 9 · Commit history (recent → old)

```
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

Major recent additions: TradingView-aligned CVD (sign-based + 17 NY anchor + M5→M1 drilldown), Phase 1 sandbox refactor into custom hooks, stateful channel tracking with break confirmation and identity-based labels, percentile-anchored derived rail + density filter for cleaner detection on wide windows, drawable CVD chart with per-chart-tagged logs, `[channels]` lifecycle logs into session.log.

Last update: 2026-05-23 evening.
