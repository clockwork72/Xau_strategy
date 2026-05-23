# XAU Algo · Handoff

Trading research sandbox: Electron + Vite + React + TS + lightweight-charts v4, fed by
MT5 / OANDA Demo data for **XAUUSD.sml** (gold). Built for exploring historical 1m / 5m
data with EMA, session overlays, and arbitrary date-range zoom.

Project root: `C:\Users\asus\Desktop\Xau_Algo`

---

## 1 · Run

```powershell
cd C:\Users\asus\Desktop\Xau_Algo

# desktop app (Electron + Vite HMR + DevTools detached)
npm run electron:dev

# browser-only (no Electron shell)
npm run dev   # → http://localhost:5173

# production build (Vite to dist/)
npm run build

# TS no-emit check
npx tsc --noEmit
```

`concurrently -k` ensures closing the Electron window terminates Vite cleanly.

---

## 2 · File map

```
Xau_Algo/
├── data/                                # original MT5 exports (kept as-is)
│   ├── XAUUSD_sml_M1_2026-02-10_to_2026-05-22.csv
│   ├── XAUUSD_sml_M1_with_CVD.csv
│   └── XAUUSD_sml_M5_2026-02-10_to_2026-05-23.csv
├── public/data/                         # CSVs Vite serves at /data/*
│   ├── xauusd_m1.csv
│   └── xauusd_m5.csv
├── electron/
│   └── main.cjs                         # BrowserWindow, dev/prod URL switch, devtools
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── index.css
│   ├── theme.ts                         # color / font / size tokens
│   ├── types.ts                         # Candle, CvdCandle, Timeframe, DatasetBundle
│   ├── data.ts                          # CSV loader, body-weighted CVD candle builder,
│   │                                    #   timezone offset, broker-closed/weekend filter,
│   │                                    #   CVD daily reset bucketing
│   ├── util/
│   │   └── time.ts                      # Casablanca formatters + parseCasaLocalToUtcSec
│   ├── engine/
│   │   ├── indicators.ts                # computeEma(candles, length)
│   │   └── sessions.ts                  # session defs (Asia/London/NY/Overlap) + runs
│   └── components/
│       ├── TradingResearchSandbox.tsx   # layout shell + chart effects owner
│       ├── TopBar.tsx                   # brand · 1m/5m toggle · status chip
│       ├── LeftNav.tsx                  # instrument · timeframes · range · indicators
│       ├── RightPanels.tsx              # Bar Inspector · Notes
│       ├── StatusBar.tsx                # Casa clock · symbol · bars · hover
│       ├── SegmentedToggle.tsx          # sliding-indicator pill
│       └── SessionOverlay.tsx           # absolute boxes over price pane
├── export_xauusd.py                     # MT5 → CSV exporter (M1)
├── export_xauusd_m5.py                  # same for M5
├── compute_cvd.py                       # standalone CVD computation (legacy / reference)
├── probe_tz.py                          # MT5 timezone probe
├── probe_xauusd.py                      # probe local M1 cache depth
├── force_fetch.py                       # attempt to force broker backfill
├── package.json
├── vite.config.ts                       # base: './', strictPort: true
├── tsconfig.json
└── index.html
```

---

## 3 · The single most important gotcha · timezone offset

**OANDA's MT5 demo server reports bar times in UTC+3 (EEST broker time)**, *not* real UTC,
even though the export script labels rows as `+00:00`. Verified two ways:

1. `probe_tz.py` showed MT5's reported tick time was 3 h ahead of the actual real-UTC time
   of the last tick.
2. Visual cross-check with TradingView's OANDA spot feed in Casablanca display showed our
   app reading 4 h later than TradingView, consistent with `+3` broker offset + `+1` Casa
   display offset.

The fix lives in `src/data.ts`:

```ts
const OANDA_MT5_TZ_OFFSET_SEC = -10800   // subtract 3h to convert CSV → real UTC

function parseTimeSec(s: string): number {
  const iso = s.includes('T') ? s : s.replace(' ', 'T')
  return Math.floor(new Date(iso).getTime() / 1000) + OANDA_MT5_TZ_OFFSET_SEC
}
```

**This assumes fixed UTC+3 year-round on the broker** (no DST). If February data
(winter, would be UTC+2 if DST-observing) reads 1 h off vs TradingView, switch the
constant to a dynamic offset via `Intl.DateTimeFormat({ timeZone: 'Europe/Athens' })`.

On-disk CSVs are **not** rewritten — the shift is applied only at app-ingest time.

---

## 4 · Data context

### Broker / source

- **Account:** OANDA Global Markets · server `OANDA_Global-Demo-1` · login `1715540085`
- **Symbol:** `XAUUSD.sml` (OANDA's "small lot" gold variant; same prices as XAUUSD)
- **Digits:** 3, point = 0.001 → 1 pip ≈ $0.10 / oz
- **History cap:** MT5 holds **100,000 M1 bars locally** (≈70 trading days). Older bars
  are not in OANDA Demo's server cache regardless of "Max bars in chart" setting. M5
  reaches slightly further back for the same byte budget.

### CVD computation

Body-weighted, **NOT** real CVD (OANDA streams quote ticks with no aggressor flag, verified
in `probe_ticks.py` — 0/31987 ticks carry TICK_FLAG_BUY/SELL). Formula:

```
buy_share  = (close - low) / (high - low)        # 0.5 on doji bars
buy_vol    = tick_volume * buy_share
sell_vol   = tick_volume * (1 - buy_share)
delta      = buy_vol - sell_vol
```

CVD candles per bar:

```
open  = prev_close
close = open + delta
high  = open + buy_vol                # max upward excursion (if all buys happened first)
low   = open - sell_vol               # max downward excursion (if all sells happened first)
```

**CVD resets to 0 daily at 08:00 UTC** (Tokyo close → London open, conventional TradingView
session-anchored CVD reset). Bucket logic in `src/data.ts:sessionBucket`.

`tick_volume` is the count of quote updates per minute, not contracts — CVD shape
(divergence vs price) is meaningful; absolute magnitude is not.

### Filters applied at ingest

`src/data.ts:isBrokerClosed` drops bars during:

| Window (anchored to NY local) | Real-UTC summer / winter |
|---|---|
| Any day, hour = 17 NY (daily settlement) | 21:00 / 22:00 UTC |
| Fri 18+ NY, all Sat, Sun before 17 NY (weekend) | ~Fri 22:00 UTC → Sun 21:00 UTC |

Bar count drops ~10–11% vs raw CSV after filtering.

---

## 5 · Component architecture

### Layout

```
┌── TopBar ──────────────────────────────────────────────────────────┐
│   XAU·SBX · 1m|5m · status dot+text                                │
├──────┬─────────────────────────────────────────────────┬───────────┤
│ Left │ PRICE pane (candles + EMA line + SessionOverlay)│ Bar       │
│ Nav  │   ~58% height                                   │ Inspector │
│      ├─────────────────────────────────────────────────┤           │
│      │ CVD pane (candles, dashed 0 line)               │ Notes     │
│      │   ~25% height                                   │           │
├──────┴─────────────────────────────────────────────────┴───────────┤
│   StatusBar · Casa clock · symbol · bars · hover                   │
└────────────────────────────────────────────────────────────────────┘
```

Grid: `gridTemplateColumns: 190px 1fr 280px`. Chart column rows:
`auto 1fr auto 0.43fr` so price ≈ 70%, CVD ≈ 30%.

### LeftNav

```
INSTRUMENT      XAUUSD.sml
TIMEFRAME       1-Minute  · 5-Minute
RANGE (CASA)    Start [YYYY-MM-DD HH:MM]
                End   [YYYY-MM-DD HH:MM]
                [Apply]  [Fit]
INDICATORS      ☑ ● EMA       [21]
                ☑   Sessions
```

- **Range (Casa)** — inputs interpreted as Casablanca local time, converted to real UTC
  seconds via `parseCasaLocalToUtcSec` (DST-safe two-pass `Intl.DateTimeFormat` offset
  lookup). `Apply` calls `chart.timeScale().setVisibleRange()`. `Fit` calls `fitContent()`.
  Invalid input → red border; Apply silently no-ops. Enter in either input fires Apply.
- **EMA** — yellow line on price pane. Length input clamps to [2, 300] on blur/Enter.
  Default ON, length 21.
- **Sessions** — single toggle. ON → Asia + London + NY overlays drawn (Overlap stays
  off). Default ON.

### Chart sync (lightweight-charts v4)

Two `createChart` instances stacked. Sync handled in the chart-creation `useEffect`:

- **Time axis** — `subscribeVisibleLogicalRangeChange` propagated both directions,
  guarded by a `syncing` flag.
- **Crosshair** — `subscribeCrosshairMove` → `setCrosshairPosition(price, time, series)`
  on the other chart. Wrapped in `try/catch` because the API throws `"Value is null"`
  during dataset reset / timeframe switch. **Don't remove the guard** — it caused a
  full-screen unmount before.
- **Casablanca formatting** — `localization.timeFormatter` + `timeScale.tickMarkFormatter`,
  both delegating to `src/util/time.ts`. IANA `Africa/Casablanca` handles the Ramadan
  UTC-offset shift automatically.

### Range pin behavior

`appliedRange` state in `TradingResearchSandbox` remembers the last Apply'd window.
When the active dataset changes (timeframe switch), an effect re-applies the same window
via `requestAnimationFrame` so it runs after `setData` has been ingested. `Fit` clears
the pinned range — subsequent TF switches no longer re-snap.

### EMA series

Created alongside the candle series in the chart-creation effect; ref stored in
`emaSeriesRef`. Two effects:

- **Visibility**: `ema.applyOptions({ visible })` toggles when `emaEnabled` changes.
- **Data**: recomputes `computeEma(active.candles, emaLength)` on dataset/length/enabled
  change and `setData()`s. Full recompute each time — fine for ≤100k bars, optimize if
  it grows.

### EMA formula

`src/engine/indicators.ts`:

```
k = 2 / (length + 1)
seed = SMA of first `length` closes
ema[i] = close[i] * k + ema[i-1] * (1 - k)
```

Plotting starts at bar `length-1` (canonical TV behavior). If candles < length, falls
back to a running EMA seeded by the first close.

### Session indicator

`src/engine/sessions.ts` defines four sessions (UTC, DST-agnostic). The single
`sessionsEnabled` boolean in the sandbox derives a `SessionToggles` object:
`{ asia, london, ny: enabled, overlap: false }`. Overlap is no longer surfaced in the UI.

`SessionOverlay.tsx` renders runs as absolute-positioned `<div>` boxes inside the price
pane via `timeScale().timeToCoordinate(time)` + `candleSeries.priceToCoordinate(price)`.
**z-index: 2** on the overlay container (lightweight-charts paints its canvas *after*
React, so without explicit z-index the canvas covers the boxes).

Repositions on pan/zoom via `subscribeVisibleLogicalRangeChange` bumping a `tick` state.
Initial render uses `requestAnimationFrame` to catch the first `setData` call.
`pointer-events: none` so crosshair still works through the boxes.

### Right panels

- **Bar Inspector** — hover-driven. Shows TIME · CASA, OPEN, HIGH, LOW, CLOSE, RANGE,
  DELTA, TICKVOL, plus a colored body-position bar indicating where the candle body sits
  within the high-low range.
- **Notes** — per-timeframe localStorage textarea, keys `xau-sbx-notes-1m` and
  `xau-sbx-notes-5m`, debounced 300 ms.

### Status chip

Top-right shows a colored dot encoding load state:
- yellow → loading or mock fallback
- green → real CSV loaded
- red → load error

Just a dot + text now — no pill background.

---

## 6 · What works (verified clean TS, manual verify pending)

- Electron window opens, both charts render with synced time scale + crosshair
- 1m ↔ 5m toggle swaps dataset cleanly
- Range Apply zooms both panes; Fit returns to all bars
- Range pin survives TF switch (`appliedRange` re-applies after `setData`)
- EMA(21) yellow line follows price; toggle hides/shows; length input commits on blur/Enter
  and clamps [2, 300]
- Single Sessions toggle drives Asia/London/NY overlays + labels
- Casablanca times everywhere: axis ticks, crosshair tooltip, Bar Inspector "TIME · CASA",
  status bar clock
- Broker-closed + weekend filter removes the right bars
- CVD wraps to 0 at each 08:00 UTC reset

---

## 7 · Open items / next moves

- **CSV portability** — modify `export_xauusd.py` to apply the −3h shift at export time
  so CSVs land in real UTC on disk. Removes the in-app shift. ~10 line change.
- **DST verification** — scroll to **February data** in the loaded set and cross-check
  times vs TradingView. If 1 h off, swap fixed `OANDA_MT5_TZ_OFFSET_SEC` for a per-bar
  dynamic lookup via `Intl.DateTimeFormat({ timeZone: 'Europe/Athens' })`.
- **Session H/L lines + extend-right** — port the two remaining bits of the user's Pine
  script: thin horizontal lines at session high and low, optionally extending right past
  session end. Same SessionOverlay infra, just adds two `<div>` per run + an extend flag.
- **More indicators** — EMA scaffold is in place. Adding RSI, VWAP, anchored VWAP, etc.
  follows the same pattern: `engine/indicators.ts` helper + ref + visibility/data effect
  pair + LeftNav row.
- **Range-input pre-fill** — currently empty placeholder. Could seed with last bar's
  date 00:00 → 23:59 on first focus.
- **Installer / packaging** — `electron-builder` for a redistributable `.exe`. Not done.
- **Resizable splitters / collapsible nav** — deferred to v2.

---

## 8 · Coding conventions

- **Anti-slop guards on**. No purple gradients, no emoji icons, no rounded-card +
  left-border-accent treatment, no fabricated stats.
- **Honest placeholders** over half-done implementations. Bar Inspector starts empty
  with `— hover a bar` instead of pretending it has data.
- **Casablanca display, real UTC under the hood.** Internal data stays in real UTC; only
  the formatters apply Casablanca. Sessions defined in real UTC, DST-agnostic.
- **Theme tokens only.** No inventing colors mid-file. Tokens live in `src/theme.ts`.

---

## 9 · Known caveats

- Tests are not set up. Manual verification via Electron window is the only loop.
- The "Max bars in chart" setting in MT5 is unlimited per user, but OANDA Demo still only
  retains ~100k M1 bars. Scrolling back further won't trigger additional download — the
  broker doesn't have older data to send.
- `npm audit` reports 2 moderate vulnerabilities (transitive Vite deps). Not fixed —
  no breaking changes available and these are dev-only paths.
- Lightweight-charts is pinned to v4.2.3. v5 changed the series creation API
  (`chart.addSeries(CandlestickSeries, opts)` instead of `chart.addCandlestickSeries`)
  and marker handling — upgrading needs a refactor.
- The replay engine, dummy strategy, Strategy Performance panel, and Markers panel were
  deleted on 2026-05-23. Any future strategy work starts from scratch — either as a pure
  function called on the loaded dataset (precomputed signals visualized as markers) or
  via Electron IPC to a Python sidecar.

Last update: 2026-05-23.
