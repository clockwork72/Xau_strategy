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

---

## 2 · File map

```
Xau_Algo/
├── data/                                 # MT5 exports (kept as-is)
├── public/data/                          # CSVs Vite serves at /data/*
│   ├── xauusd_m1.csv
│   └── xauusd_m5.csv
├── electron/
│   ├── main.cjs                          # BrowserWindow + titleBarOverlay + window-state persist + IPC + log bridge
│   └── preload.cjs                       # contextBridge: window.electronAPI.setTheme
├── src/
│   ├── App.tsx, main.tsx, index.css
│   ├── theme.ts                          # CSS-var refs + raw palettes export + ThemeMode + TITLE_BAR_CONTROLS_WIDTH
│   ├── types.ts                          # Candle, CvdCandle, Timeframe, DatasetBundle
│   ├── types/electron.d.ts               # window.electronAPI typing
│   ├── data.ts                           # CSV loader, CVD candles, broker filter, TZ offset
│   ├── util/time.ts                      # Casa formatters + parseCasaLocalToUtcSec
│   ├── engine/
│   │   ├── indicators.ts                 # computeEma
│   │   ├── sessions.ts                   # Asia/London/NY session defs
│   │   ├── swings.ts                     # findSwingHighs + findSwingLows (fractal-N)
│   │   ├── trendlines.ts                 # pickChannels + Channel + ChannelMeta + channelSignature + withChannelMeta
│   │   ├── strategy.ts                   # runStrategy — EMA-cross PLACEHOLDER (intact, unused)
│   │   ├── priceActionBeta.ts            # runPriceActionBeta — ACTIVE strategy, currently STUB
│   │   ├── portfolio.ts                  # computeStats(signals, lotSize, balance, markPrice)
│   │   └── drawing.ts                    # DrawTool, DrawnLine, snapToNearestPivot, hitTestLine, nextLineId, HORIZONTAL_EXTEND_SEC
│   └── components/
│       ├── TradingResearchSandbox.tsx    # state owner + chart effects
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

### CVD computation (UNCHANGED)
Body-weighted (NOT real CVD — OANDA streams no aggressor flag). See `src/data.ts` for the formula. Resets to 0 daily at 08:00 UTC.

### Broker-closed filter
`src/data.ts:isBrokerClosed` drops daily settlement window + weekend. Removes ~10–11% of raw bars.

---

## 5 · Architecture overview

### State flow (single source of truth)
```
appliedRange (Casa → UTC seconds, default 2026-05-21 00:00–20:00)
   ↓ filter
replayWindow = active.candles ∩ appliedRange
   ↓ slice
visibleCandles = replayWindow.slice(0, playheadIdx + 1)
   ↓ feeds everything
   chart setData, EMA, swings, channels, drawn lines, strategy signals, portfolio stats
```

Time anchor: `replayPlayheadTime` (UTC seconds), NOT an index. Index `replayPlayhead` is derived via `findIndexForTime`. **TF switch is seamless** — same time anchor resolves to whatever bar exists at-or-before that time in the new TF's grid.

### Replay
- Default playhead = **end of window** (chart looks complete on load; Reset jumps to bar 0).
- Per-tick advancement reads `playheadTimeRef.current` (no effect re-subscription on every tick).
- Forward-step-by-1 uses `series.update(lastBar)` (incremental); any other change uses `setData()` (full).
- Controls live in the **TopBar**: SVG transport (Reset / −1 / Play-Pause / +1), speed pill (1/4/10/60×), scrubber, timecode block.
- Keyboard (active anywhere except in inputs): `Space` play/pause, `←/→` step ±1, `Shift+←/→` step ±10, `Home` reset, `End` jump to end.

### Trendline detection (channels)
- `findSwingHighs(candles, lookback)` and `findSwingLows(candles, lookback)` — fractal-N pivot detection. Default `TRENDLINE_LOOKBACK = 7`.
- `pickChannels(swings, candles, kind)` in `src/engine/trendlines.ts`:
  - For each pair `(i, j)`, count swings with `|swing.price − lineY(swing.time)| ≤ ε`. `ε = midPrice * 0.0006` (~$2.70 on $4500 gold).
  - Keep pairs with `touches ≥ MIN_TOUCHES = 3`. Sort by touches desc. **Greedy non-overlap within kind**.
  - For each accepted: derive parallel rail through the extreme price on the opposite side.
- `Channel` interface: `upperStart/upperEnd/lowerStart/lowerEnd + touches + kind`.
- **`withChannelMeta(channels)` returns `ChannelMeta[]`** = `{channel, sig, label}`. Labels are per-kind enumeration order (`R1`, `R2`, … for resistance; `S1`, `S2`, …). `channelSignature(c)` = `${kind}|${startTime}|${endTime}`.
- Sandbox runs both detectors and merges results. **Cross-kind non-overlap is DISABLED** (commented in `TradingResearchSandbox.tsx`).

### Channel rendering on chart
- Pool of LineSeries pairs (`channelsSeriesPoolRef`). Per-channel: `res` line (upper rail) + `sup` line (lower rail), both in `colors.accent`.
- Marker at the channel's left anchor: `R1`/`R2`/… for resistance (aboveBar on upper rail), `S1`/`S2`/… for support (belowBar on lower rail).
- IDs reshuffle on each recompute (sorted by touches desc, so set membership shifts as data evolves).

### Channels panel (right side · RightPanels.tsx)
Section between Strategy and Bar Inspector. Two layers:

1. **Kind toggles (top)** — two clickable chips: `● Resistance · N` and `● Support · N`. Clicking flips `showResistance` / `showSupport` state. When off, that kind is **skipped at detection** (`pickChannels` isn't called) — so `R1/R2/...` channels disappear entirely (both rails + label). **Persists across replay scrubs** because it's just two booleans. Note: when Resistance is off, support channels still draw their *derived* upper rails — those are not R-kind channels, just the parallel rail of S-kind channels. If you want those gone too, that's the per-rail variant (see git log for `e365f75`).
2. **Per-channel rows (below)** — one row per detected channel, click to sig-hide that specific channel for the current snapshot. Hide is keyed by `${kind}|${startTime}|${endTime}` so it **breaks on replay scrub** when the algo re-anchors; that's a known limitation kept around for quick snapshot-level filtering. `show all` link clears.

### Strategy
- **Active**: `runPriceActionBeta(candles) → Signal[]` in `src/engine/priceActionBeta.ts`. Currently an **empty stub** returning `[]`. To-be-built Second Entry state machine (State 0 swing forms → State 1 fails to break → State 2 breaks prior high).
- **Placeholder kept**: `runStrategy(candles)` in `src/engine/strategy.ts` — original EMA-cross. Swap import in `TradingResearchSandbox.tsx` to revert.
- Signal type defined in `strategy.ts`; `Signal { time, side: 'buy' | 'sell', price, label? }`.

### Portfolio
- `computeStats(signals, lotSize, balance, markPrice) → StrategyStats` in `src/engine/portfolio.ts`.
- Pairs consecutive opposite signals into closed trades; trailing unmatched signal = open position, marked to `markPrice` (= last visible candle's close).
- Rendered in **StrategySummary** (top of RightPanels). Editable `lotSize` (default 0.01) and `startingBalance` (default 100).

### Draw tool (totally rewritten · `engine/drawing.ts` + `components/DrawToolbar.tsx`)
Floating vertical toolbar pinned to the top-left of the price chart. Replaces the old LeftNav checkbox.

**Tools**
- **V · Cursor** (default). Click a drawn line to select it. `Delete`/`Backspace` removes selection.
- **T · Trendline** — 2-click diagonal line. Anchors snap to nearest pivot if snap on.
- **H · Horizontal** — 1-click horizontal line. Renders via `candleSeries.createPriceLine` (not LineSeries) so it doesn't affect the time-scale extents. Extends `HORIZONTAL_EXTEND_SEC` (30 days) forward visually.
- **S · Snap** toggle — when on, anchors snap to nearest swing high/low or raw candle H/L within 8px. Algo swings are reused (`drawSwings` useMemo, independent of trendline overlay).
- **Trash** — clears all drawn lines.

**Data model**: `DrawnLine = { id, tool, t1, p1, t2, p2 }`. Stored in `drawnLines` state, rendered via `drawnRenderMapRef: Map<id, {kind: 'line'|'priceLine', api}>`. Selected line renders at `lineWidth: 3` vs `2`.

**Keyboard**: `V`/`T`/`H`/`S`, `Esc` clears working anchor + deselects + back to cursor, `Del`/`Backspace` removes selection.

**Session log lines emitted** by `TradingResearchSandbox.tsx`:
- `[draw] anchor1 t=... p=... [snap=swingHigh@4509.800 Δ4.2px]`
- `[draw] line tool=trendline a=... b=... dt=... dp=... slope/h=... [snap=...]`
- `[draw] line tool=horizontal p=... t=... [snap=...]`
- `[draw] delete id=...`
- `[replay] play / pause / step / reset / scrub / speed / range`

### Charts
- Two stacked `createChart` instances (price + CVD). Time scales synced via `subscribeVisibleLogicalRangeChange`. Crosshair synced via `subscribeCrosshairMove` (try/catch — `setCrosshairPosition` throws "Value is null" during transient empty data; keep the guard).
- All times rendered in Casablanca (IANA `Africa/Casablanca`, DST-aware). Internal data stays real UTC.
- Chart colors must be real hex strings, NOT CSS vars (lightweight-charts doesn't resolve vars). The component reads `colors = palettes[themeMode]` and passes hex to `createChart` / `applyOptions` / series. A dedicated theme-sync `useEffect` re-`applyOptions` on every series when `themeMode` flips.

### Theme system (light + dark)
- **DOM styling** uses CSS variables. `theme.ts` exports `theme.bg = 'var(--theme-bg)'`, etc. Components keep using `theme.x` in inline styles — the variables are defined in `src/index.css` scoped to `[data-theme="dark"]` and `[data-theme="light"]`.
- **Chart-side code** uses `palettes[mode]` directly (raw hex), since lightweight-charts doesn't resolve CSS vars. The component imports `palettes`, `ThemeMode` from `theme.ts`.
- **Theme toggle** is a sun/moon icon in TopBar (right side, before status). Click flips `themeMode`. State persists in `localStorage` under `xau:theme` AND in `window-state.json` (so first paint is correct, no flash).
- `main.tsx` reads `localStorage` and sets `document.documentElement.dataset.theme` before React renders.
- On theme change, a `useEffect` syncs everything: `data-theme` attr, `localStorage`, `window.electronAPI.setTheme(mode)` IPC (updates the OS title-bar overlay color), and chart re-`applyOptions` for layout/grid/crosshair/candles/EMA/CVD zero-line/channel pool/drawn lines.
- Light palette tweaks: `accent = #2563eb`, `warn = #b8860b` (darker yellow for white-bg contrast). Up/Down stay `#26a69a` / `#ef5350`.

### Electron custom title bar
- `titleBarStyle: 'hidden'` + `titleBarOverlay: { color, symbolColor, height: 44 }` — Win11 native min/max/close on the right, themed colors, snap-aware. Height matches `sizes.topbar = 44` so the OS buttons sit inside the TopBar strip visually.
- **TopBar IS the drag region** — `WebKitAppRegion: 'drag'` on the header, `'no-drag'` on every interactive Group (timeframe, transport, speed, scrubber, theme toggle). Right padding = `TITLE_BAR_CONTROLS_WIDTH = 140` reserves space for the OS controls.
- **Window state persistence** — bounds + maximized + theme saved to `app.getPath('userData')/window-state.json` on resize/move/close. Restored on launch.
- **IPC bridge** — `electron/preload.cjs` exposes `window.electronAPI.setTheme(mode)`. Main handles `set-theme` → calls `mainWindow.setTitleBarOverlay({...})` + persists.

### Session logging (agent bridge — important)
- `electron/main.cjs` hooks `webContents.on('console-message', ...)`.
- Filters renderer `console.log` lines starting with `[draw]` or `[replay]`.
- Writes them with ISO timestamps to `session.log` at project root. Cleared on every session start.
- **Use case**: the agent can `Read` `session.log` to see what the user did without screenshots.

---

## 6 · WIP / Next moves

### Build Price Action Beta state machine
File: `src/engine/priceActionBeta.ts`. Use `findSwingHighs(candles, lookback)` for swing tracking, then implement the State 0/1/2 Second Entry logic. Emit `Signal[]` — markers + portfolio update come for free.

### Tune trendline detection
- Workflow: replay through the area of interest, use **Draw tool** (`T` for trendline, snap on) to mark the "real" trendlines as ground truth, then `Read session.log` to compare with algo output and tweak params.
- Knobs:
  - `TRENDLINE_LOOKBACK` in `TradingResearchSandbox.tsx` (currently 7)
  - `TOUCH_PCT` in `trendlines.ts` (currently 0.0006)
  - `MIN_TOUCHES` in `trendlines.ts` (currently 3)

### Trendline algorithm — deferred items
- Right-extension (currently anchor-to-anchor only)
- Break detection / lifecycle (channel ends when a candle decisively closes outside ± ε)
- Re-enable cross-kind non-overlap (see commented block in sandbox)
- UI inputs for lookback / touch tolerance / min-touches
- **Stable channel IDs across recomputes** — current labels (R1/S1/…) reshuffle as `pickChannels` re-sorts on each visibleCandles change. Would need similarity-matching (geometric fingerprint) to keep IDs stable. Attempted in commit `dc1e853`, reverted; revisit if needed.

### Draw tool — deferred items
- Drag-to-move endpoints (currently no edit, only delete+redraw)
- Right-extension toggle for trendlines (horizontals already extend)
- Ray tool
- Per-line right-click context menu
- Undo (ring buffer)
- Per-line color

### Other
- CSV portability: bake the −3h timezone shift into the Python exporter so on-disk CSVs are real UTC.
- DST verification: scroll to **February data** and cross-check vs TradingView; switch to dynamic offset if 1h off.
- Session H/L lines (port from user's Pine).
- Installer / packaging via `electron-builder`.
- Mica / Acrylic background material on Windows 11 (currently solid). Drop `backgroundMaterial: 'mica'` into `BrowserWindow` opts to try.

---

## 7 · Coding conventions

- **Anti-slop guards on**: no purple gradients, no emoji icons, no rounded-card-with-left-border accent, no fabricated stats. SVG icons only when needed.
- **Theme tokens only** (`src/theme.ts`). DOM uses CSS vars via `theme.x`. Chart code uses `palettes[mode].x` raw hex. No new colors invented in components.
- **Casablanca display, real UTC under the hood**. Sessions defined in real UTC, DST-agnostic.
- **Honest placeholders** over half-done implementations. Bar Inspector starts empty with `— hover a bar`.
- **No comments narrating WHAT code does** — only WHY when non-obvious.

---

## 8 · Caveats

- **No tests**. Manual verification via Electron window is the only loop.
- **OANDA Demo history cap** is ~100k M1 bars. Scrolling back won't trigger backfill.
- **lightweight-charts pinned v4.2.3**. v5 has breaking API changes — upgrade needs a refactor.
- **Per-channel sig-based hide breaks on replay scrub** — the panel row click hides via `${kind}|${startTime}|${endTime}` sig, which changes as the algo re-anchors. Use the kind toggles for sticky hides; per-channel rows are snapshot-only. Geometric-fingerprint matching was tried and reverted (commit `dc1e853` → `44d7b87`).
- **Channel labels reshuffle** on every recompute (sorted by touches desc). `R1` at bar T may be a different channel at bar T+10.
- **Light theme `warn` is `#b8860b`** (darker amber) for white-bg contrast — drawn lines and EMA look less punchy than the dark-mode `#f5c518`. By design.
- **titleBarOverlay is Windows/Linux only**. On macOS would need `titleBarStyle: 'hiddenInset'` + different control rendering. You're on Win11, fine.
- **`npm audit`**: 2 moderate vulnerabilities in transitive Vite deps. Dev-only paths.
- **GPG signing**: repo-local `user.signingkey = 5FD2393D65137501` (ed25519, no passphrase). Global config references an expired key — other repos will fail to sign until that's updated.
- **session.log is gitignored**. Don't commit it.

---

## 9 · Commit history (recent → old)

```
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

Several reverts in the channel-mask area — final design landed at `5d7118b`: kind toggles in right panel (sticky across replay) + per-channel sig-based rows below (snapshot only).

Last update: 2026-05-23 evening. Major additions since initial commit: full draw-tool rewrite, light theme, custom Electron title bar with window state persistence, R1/S1 channel labels, channels panel with kind toggles.
