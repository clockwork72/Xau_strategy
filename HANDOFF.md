# XAU Algo · Handoff

Trading research sandbox: **Electron + Vite + React + TS + lightweight-charts v4**, fed by MT5 / OANDA Demo data for **XAUUSD.sml** (gold). Built for replay-driven price-action strategy R&D.

- **Project root**: `C:\Users\asus\Desktop\Xau_Algo`
- **Remote**: https://github.com/clockwork72/Xau_strategy (branch `main`, signed commits)

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
│   └── main.cjs                          # BrowserWindow + console-message → session.log bridge
├── src/
│   ├── App.tsx, main.tsx, index.css
│   ├── theme.ts                          # color / font / size tokens (only)
│   ├── types.ts                          # Candle, CvdCandle, Timeframe, DatasetBundle
│   ├── data.ts                           # CSV loader, CVD candles, broker filter, TZ offset
│   ├── util/time.ts                      # Casa formatters + parseCasaLocalToUtcSec
│   ├── engine/
│   │   ├── indicators.ts                 # computeEma
│   │   ├── sessions.ts                   # Asia/London/NY session defs
│   │   ├── swings.ts                     # findSwingHighs + findSwingLows (fractal-N)
│   │   ├── trendlines.ts                 # pickChannels(swings, candles, kind) — touch-scored
│   │   ├── strategy.ts                   # runStrategy — EMA-cross PLACEHOLDER (intact, unused)
│   │   ├── priceActionBeta.ts            # runPriceActionBeta — ACTIVE strategy, currently STUB
│   │   └── portfolio.ts                  # computeStats(signals, lotSize, balance, markPrice)
│   └── components/
│       ├── TradingResearchSandbox.tsx    # state owner + chart effects
│       ├── TopBar.tsx                    # brand · TF · replay transport · speed · scrubber · timecode · status
│       ├── LeftNav.tsx                   # instrument · TF · range · indicators · strategy
│       ├── RightPanels.tsx               # Strategy summary · Bar inspector · Notes
│       ├── StatusBar.tsx                 # Casa clock · symbol · bar count · hover
│       ├── SegmentedToggle.tsx           # sliding-indicator pill
│       └── SessionOverlay.tsx            # session boxes on price pane
├── README.md
├── .gitignore                            # excludes node_modules/, dist/, session.log, .agents/
├── HANDOFF.md                            # this file
├── package.json, vite.config.ts, tsconfig.json, index.html
```

`session.log` is generated at runtime by `electron/main.cjs` for the agent bridge (see §6). Gitignored.

---

## 3 · Critical gotcha · timezone offset (UNCHANGED)

OANDA MT5 demo reports bar times as **UTC+3** (EEST broker time), not real UTC, even though the export labels rows `+00:00`. Fixed at ingest in `src/data.ts`:

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
`src/data.ts:isBrokerClosed` drops daily settlement window + weekend (Fri 17 NY → Sun 17 NY). Removes ~10–11% of raw bars.

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
   chart setData, EMA, swings, channels, strategy signals, portfolio stats
```

Time anchor: `replayPlayheadTime` (UTC seconds), NOT an index. Index `replayPlayhead` is derived via `findIndexForTime`. **TF switch is seamless** — same time anchor resolves to whatever bar exists at-or-before that time in the new TF's grid.

### Replay
- Default playhead = **end of window** (chart looks complete on load; Reset jumps to bar 0).
- Per-tick advancement reads `playheadTimeRef.current` (no effect re-subscription on every tick).
- Forward-step-by-1 uses `series.update(lastBar)` (incremental); any other change uses `setData()` (full).
- Controls live in the **TopBar**: SVG transport (Reset / −1 / Play-Pause / +1), speed pill (1/4/10/60×), scrubber, timecode block.
- Keyboard (active anywhere except in inputs): `Space` play/pause, `←/→` step ±1, `Shift+←/→` step ±10, `Home` reset, `End` jump to end.

### Trendline detection
- `findSwingHighs(candles, lookback)` and `findSwingLows(candles, lookback)` — fractal-N pivot detection. Default lookback `TRENDLINE_LOOKBACK = 7`.
- `pickChannels(swings, candles, kind)` in `src/engine/trendlines.ts`:
  - For each pair `(i, j)`, count how many other swings have `|swing.price − lineY(swing.time)| ≤ ε`. `ε = midPrice * 0.0006` (~$2.70 on $4500 gold).
  - Keep pairs with `touches ≥ MIN_TOUCHES = 3`.
  - Sort by touches desc, **greedy non-overlap within kind** (skip a candidate whose time range overlaps an already-accepted one).
  - For each accepted: derive the parallel rail.
    - `kind='resistance'`: line anchored to swing **highs** (upper rail); lower rail = parallel through lowest low between firstTouch and lastTouch.
    - `kind='support'`: line anchored to swing **lows** (lower rail); upper rail = parallel through highest high between.
- `Channel` interface uses `upperStart/upperEnd/lowerStart/lowerEnd + touches + kind`.
- Sandbox runs **both** detectors and merges results. **Cross-kind non-overlap is DISABLED** (commented in `TradingResearchSandbox.tsx` — search "DISABLED: cross-kind non-overlap"). Re-enable to keep only the broader channel when resistance and support overlap in time.
- Rendered as blue (`theme.accent`) line pairs via a dynamic LineSeries pool (`channelsSeriesPoolRef`).
- **Known limitation**: anchor-to-anchor only, no right-extension (extrapolation goes wild for tight 2-pivot lines). Multi-touch helps but extension still future work.

### Strategy
- **Active**: `runPriceActionBeta(candles) → Signal[]` in `src/engine/priceActionBeta.ts`. Currently an **empty stub** returning `[]` — no markers, no trades, flat portfolio. To-be-built state machine (Second Entry setup):
  - State 0: a new swing high forms
  - State 1: a bar fails to break previous high (first correction)
  - State 2: subsequent bar breaks previous high → 2nd Entry trigger (long)
- **Placeholder kept**: `runStrategy(candles) → Signal[]` in `src/engine/strategy.ts` — original EMA-cross. Swap import in `TradingResearchSandbox.tsx`'s `signals` useMemo to revert.
- Signal type defined in `strategy.ts`; `Signal { time, side: 'buy' | 'sell', price, label? }`.

### Portfolio
- `computeStats(signals, lotSize, balance, markPrice) → StrategyStats` in `src/engine/portfolio.ts`.
- Pairs consecutive opposite signals into closed trades; trailing unmatched signal = open position, marked to `markPrice` (= last visible candle's close).
- Stats: `realizedPnl`, `unrealizedPnl`, `totalTrades`, `wins`, `losses`, `winRate`, `avgWin`, `avgLoss`, `equity`.
- Rendered in **StrategySummary** (top of RightPanels). Editable `lotSize` (default 0.01) and `startingBalance` (default 100).

### Draw tool
- "Draw" toggle in LeftNav Indicators (yellow `theme.warn` checkbox + count + Clear button).
- When ON: click on price chart logs anchor coords (time, price). Two clicks → forms a line, logs full details, renders yellow LineSeries.
- Working anchor cleared when toggle goes OFF.

### Session logging (agent bridge — important)
- `electron/main.cjs` hooks `mainWindow.webContents.on('console-message', ...)`.
- Filters renderer `console.log` lines starting with `[draw]` or `[replay]`.
- Writes them with ISO timestamps to `session.log` at project root.
- Cleared on every session start.
- **Use case**: the agent (Claude) can `Read` `session.log` to see what the user did (replay actions, drawn ground-truth lines) without screenshots. Critical for calibration loop.

Renderer log emitters (in `TradingResearchSandbox.tsx`):
- `[draw] anchor1 t=... p=...` — first click
- `[draw] line a=...@... b=...@... dt=... dp=... slope/h=...` — line complete
- `[replay] play from ...` / `pause at ...` — play state transitions
- `[replay] step / reset / scrub → ... (idx X/N)` — user-initiated playhead changes
- `[replay] speed X×` — speed change (also fires on mount)
- `[replay] range ...` — applied range change (also fires on mount)

### Charts
- Two stacked `createChart` instances (price + CVD). Time scales synced via `subscribeVisibleLogicalRangeChange`. Crosshair synced via `subscribeCrosshairMove` (with try/catch — `setCrosshairPosition` throws "Value is null" during transient empty data; don't remove the guard).
- All times rendered in Casablanca (IANA `Africa/Casablanca`, DST-aware).
- Internal data stays real UTC; only formatters apply Casa.

---

## 6 · WIP / Next moves

### Build Price Action Beta state machine
File: `src/engine/priceActionBeta.ts`. Use `findSwingHighs(candles, lookback)` for swing tracking, then implement the State 0/1/2 logic. Emit `Signal[]` — markers + portfolio update for free.

### Tune trendline detection
- Workflow: replay through the area of interest, use **Draw** tool to mark the "real" trendlines as ground truth, then `Read session.log` to compare with algo output and tweak params.
- Knobs:
  - `TRENDLINE_LOOKBACK` in `TradingResearchSandbox.tsx` (currently 7) — smaller = more pivots, noisier
  - `TOUCH_PCT` in `trendlines.ts` (currently 0.0006) — wider tolerance = more touch matches
  - `MIN_TOUCHES` in `trendlines.ts` (currently 3) — drop to 2 if too few lines detected

### Trendline algorithm — deferred items
- Right-extension (currently anchor-to-anchor only)
- Break detection / lifecycle (channel ends when a candle decisively closes outside ± ε)
- Re-enable cross-kind non-overlap (see commented block in sandbox)
- UI inputs for lookback / touch tolerance / min-touches
- Distinct (non-chained) channel detection across regime changes

### Other
- CSV portability: bake the −3h timezone shift into the Python exporter so on-disk CSVs are real UTC. Removes the in-app shift.
- DST verification: scroll to **February data** and cross-check vs TradingView; switch to dynamic offset if 1h off.
- Session H/L lines (port from user's Pine).
- Installer / packaging via `electron-builder`.

---

## 7 · Coding conventions

- **Anti-slop guards on**: no purple gradients, no emoji icons, no rounded-card-with-left-border accent, no fabricated stats. SVG icons only when needed (transport icons in TopBar).
- **Theme tokens only** (`src/theme.ts`). No new colors invented in components. Up/down green/red used **only** for semantic P&L / direction.
- **Casablanca display, real UTC under the hood**. Internal data stays UTC; formatters apply Casa. Sessions defined in real UTC, DST-agnostic.
- **Honest placeholders** over half-done implementations. Bar Inspector starts empty with `— hover a bar`.
- **No comments narrating WHAT code does** — only WHY when non-obvious. No reference to current task/PR. (Per session-level guidance.)

---

## 8 · Caveats

- **No tests**. Manual verification via Electron window is the only loop.
- **OANDA Demo history cap** is ~100k M1 bars. Scrolling back won't trigger backfill.
- **lightweight-charts pinned v4.2.3**. v5 has breaking API changes (different series add API, marker handling) — upgrade needs a refactor.
- **`npm audit`**: 2 moderate vulnerabilities in transitive Vite deps. Dev-only paths.
- **GPG signing**: repo-local `user.signingkey = 5FD2393D65137501` (ed25519, no passphrase, no expiry). The user's **global** config still references an expired key `D3C7D5A31DB0A696`; other repos will fail to sign until that's updated. Public key for GitHub verification: see `gpg --armor --export 5FD2393D65137501`.
- **session.log is gitignored**. Don't commit it.

Last update: 2026-05-23 evening. State after a long session that: added Price Action Beta scaffold + the EMA-cross placeholder kept intact; introduced Strategy summary panel + lot/balance config; reworked replay (TopBar transport, time anchoring, incremental updates, keyboard); built swing detection + touch-scored channels with both resistance + support; added the Draw tool + Electron-side session.log bridge; pushed initial commit to GitHub.
