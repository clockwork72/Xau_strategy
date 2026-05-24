# Price Action Beta — Short Setup v1

**Status:** design approved · ready for implementation plan
**Target file:** `src/engine/priceActionBeta.ts` (currently a stub returning `[]`)
**Algorithm name in UI:** "Price Action Beta" (no change — already wired)

---

## 1. Intent

Trade rejections off the **upper rail of a live, rising support channel**, conditional on price still sitting above EMA(21). Mean-reversion inside an uptrending channel, with EMA(21) acting as the "local trend not yet broken" filter. Risk-reward fixed at 1:3 with the stop pinned to the rejection candle's own high.

---

## 2. Setup (entry conditions)

**Real-time, no look-ahead.** Entries are evaluated ONLY on the playhead bar (the last bar in the visible slice). Historical bars are never re-evaluated for entries — at the time those bars were the playhead, the strategy already had its chance. This eliminates the classic backtest bias where historical bars get evaluated using channels that didn't exist yet at that time.

For the playhead bar and each live `kind='support'` channel `c`, all four must hold:

1. **Bar in channel's active range** — `c.startTime ≤ playhead.time`, and the channel is extended forward to `playhead.time` via `extendChannelToTime(c, playhead.time)`. Frozen/broken channels are excluded by the caller.
2. **Proximity to top rail** — `|playhead.close − upper_rail_at(c, playhead.time)| ≤ midPrice * TOUCH_PCT`, where `TOUCH_PCT = 0.0006` (reused from `trendlines.ts`, ≈$2.70 on $4500 gold).
3. **Above EMA(21)** — `playhead.close > ema21(playhead.time)`.
4. **Upper-wick rejection** — `playhead.high − max(playhead.open, playhead.close) > |playhead.close − playhead.open|`. Strict greater-than. Color-agnostic (green or red qualifies).

If all four hold AND we are currently flat → open short at `playhead.close`.

---

## 3. Risk model

- **Stop loss** — `SL = bar[i].high + midPrice * STOP_BUFFER_PCT`. Default `STOP_BUFFER_PCT = 0.0002` (~$0.90 on $4500 gold).
- **R** — `R = SL − entry_price`.
- **Take profit** — `TP = entry_price − 3 * R`. Fixed 1:3, no structural override.

---

## 4. Exit scan (deterministic, intrabar pessimistic)

Once short, scan forward from the first bar after the entry, up to and including the current playhead. Exits use ONLY price data (`bar.high` vs SL, `bar.low` vs TP) so a scan over multiple skipped bars (e.g. user scrubs forward past the exit) introduces no channel look-ahead.

For each scanned bar `k`:

- If `bar[k].high ≥ SL` → exit at `SL`, time = `bar[k].time`, reason = `stop`.
- Else if `bar[k].low ≤ TP` → exit at `TP`, time = `bar[k].time`, reason = `target`.
- **Both in same bar** → stop wins (pessimistic). Justification: M5 gold can spike up and back down inside one bar; assuming the stop fired first avoids inflating win rate via optimistic intrabar ordering.
- **Playhead reached with no exit** → leave the short open. No close signal emitted; sandbox's portfolio shows it as the trailing open position, marked to last visible close (existing behavior).

---

## 5. Concurrency — one position at a time

While a short is open, new entry triggers are ignored. The "5 near-identical shorts from one rejection" problem can't happen because we're never `flat` while in a trade.

No explicit cancel logic for armed setups: every playhead bar re-evaluates conditions from scratch, so a channel break or close-below-EMA21 simply makes condition 1 or 3 false on that bar.

## 5a. State & replay semantics

The strategy is **stateful across replay ticks**, with state held in a sandbox-owned ref:

```ts
interface PABState {
  signals: Signal[]
  lastProcessedTime: number  // -1 = never
}
```

**Signals are the single source of truth.** The current open trade and the running `tradeCount` are derived fresh from `signals` on every call — never stored separately. This means pruning signals on backward scrub automatically cleans up both derived values, so PAB-N labels reset correctly and there can be no dangling-entry / phantom-trade desyncs.

**Pure function signature** — given `prevState`, produces `nextState`:

```ts
runPriceActionBeta(candles, liveSupportChannels, ema21ByTime, prevState) → PABState
```

**Per-tick behavior:**

- **Forward step (single bar)** — evaluate entry on the new playhead; scan exit if open. Real-time honest, no bias.
- **Forward scrub (multi-bar jump)** — entries are NOT replayed for skipped bars (would require bygone channel state). Exit scan covers the skipped bars (pure price data, safe). User can `Home` + Play to see entries unfold bar-by-bar.
- **Backward scrub** — signals with `time > playhead` are pruned; an open trade with `entryTime > playhead` is dropped.
- **Idempotent** — repeated calls with the same playhead return the same state.

**State resets** (caller-managed, mirroring the channels tracker):
- Timeframe change
- Range change (start or end)
- Dataset change
- Strategy-enabled toggle (off → on or on → off)

---

## 6. Signature change

```ts
// src/engine/priceActionBeta.ts
export function runPriceActionBeta(
  candles: ReadonlyArray<Candle>,
  liveSupportChannels: ReadonlyArray<ChannelMeta>, // status='live', kind='support'
  ema21ByTime: Map<number, number>,
  prevState: PABState,
): PABState
```

Caller (`TradingResearchSandbox.tsx`) filters `channelsMeta` to live support channels, holds the `PABState` in a ref, and passes the EMA(21) map it computes in a dedicated memo (independent of the chart overlay's user-configurable length).

`PABState.signals` is the existing `Signal[]` shape: alternating `sell` (entry) + `buy` (synthetic exit at SL or TP price/time). The existing `computeStats` in `portfolio.ts` pairs them into closed trades — no portfolio-model changes required.

---

## 7. Constants (file-level, tunable in code; no UI knob in v1)

```ts
const STOP_BUFFER_PCT = 0.0002
const RR = 3
const PROXIMITY_PCT = TOUCH_PCT  // 0.0006, imported from trendlines.ts
const EMA_LENGTH = 21
```

---

## 8. Telemetry — `[strategy]` log channel

For fine-tuning, the strategy emits `console.log` lines that the Electron main process forwards to `session.log` (agent bridge).

**Requires a one-line edit** to `electron/main.cjs`: extend the filter regex to include `[strategy]` alongside `[draw]`, `[replay]`, `[channels]`. Note: `electron/main.cjs` does NOT hot-reload — `npm run electron:dev` must be restarted once after the edit.

**Event vocabulary:**

| Event | When | Fields |
|---|---|---|
| `[strategy] entry label=PAB-1 ch=S1 close=... rail=... ema=... SL=... TP=... R=...` | A short is opened. | `label` = sequential `PAB-N`, `ch` = channel label, `rail` = upper rail at bar time |
| `[strategy] exit label=PAB-1 reason=stop\|target price=... bars=K` | The short closes via SL or TP. `bars` = bars between entry and exit. | |
| `[strategy] skip-armed ch=S1 close=... rail=... reason=already-short` | Conditions fire on a channel while a position is already open. Throttle: at most once per (channel, bar) so the log doesn't flood. | |

Telemetry is informational — it never affects strategy output.

---

## 9. UI — no new components in v1

- Entry/exit markers render via existing `Signal[]` → chart-marker pipeline. No change.
- Portfolio panel updates via existing `computeStats`. No change.
- RightPanels strategy summary updates automatically. No change.

**Deferred to v2 (out of scope here):** SL/TP horizontal price lines overlaid on the chart while a trade is open. When we want this, it goes through `/huashu-design` for the visual treatment and through a separate spec.

---

## 10. Out of scope (explicit YAGNI)

- Tuning UI for the four constants (`STOP_BUFFER_PCT`, `RR`, `PROXIMITY_PCT`, `EMA_LENGTH`).
- Multi-TF confirmation.
- RSI / volume / time-of-session filters.
- Trail stops, break-even moves, partial closes.
- Structural exit (closing the position when the channel itself breaks while we're in the trade) — position runs to SL or TP regardless.
- Optimistic / coin-flip variants of the same-bar SL+TP collision rule.
- Fingerprint-based channel identity for trade attribution (we use `(kind, startTime)` like the rest of the tracker).

---

## 11. Verification plan

Since there is no test harness in this repo (HANDOFF §8), verification is manual via the Electron window plus `session.log`:

1. `npx tsc --noEmit` — type-clean.
2. Restart `npm run electron:dev` (because `electron/main.cjs` changed).
3. Load a replay range containing at least one well-defined rising support channel from the existing dataset (e.g., the 2026-05-21 window the sandbox defaults to).
4. Walk forward bar-by-bar (Right-arrow). Expected:
   - `[strategy] entry` lands in `session.log` only when all four conditions visibly hold on the chart.
   - Chart shows a sell-arrow marker at the entry bar and a buy-arrow marker at the exit bar.
   - Portfolio panel shows a closed trade with PnL matching `(entry − exit) * 100 * lotSize`.
   - No second entry fires on the same channel until the first is closed.
5. Find a case where the channel freezes or price closes below EMA21 while armed — confirm no entry fires.

---

## 12. Open questions

None. All design decisions confirmed in brainstorming (typo `rsa` → `EMA21`, stop = entry-high + buffer, TP = fixed 3R, proximity = `TOUCH_PCT`, wick = strict upper > body, one-at-a-time concurrency, per-bar re-eval handles arm cancel, pessimistic same-bar collision).
