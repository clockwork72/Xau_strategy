# Price Action Beta — Short Setup v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the empty `runPriceActionBeta` stub with the support-channel top-rail rejection short strategy from the spec, wire it into the sandbox with the channels + EMA(21) inputs it now needs, and extend the agent-bridge log filter to capture `[strategy]` events.

**Architecture:** Pure strategy function. Inputs: visible candles, live support-channel metas, EMA(21) lookup map. Output: existing `Signal[]` shape with paired sell (entry) + buy (synthetic exit at SL or TP). The existing `portfolio.ts` pairs them into closed trades unchanged. The sandbox computes the new inputs in dedicated memos and passes them in.

**Tech Stack:** TypeScript, React, lightweight-charts v4, Electron. No test framework (per HANDOFF §8 — verification is `npx tsc --noEmit` + manual Electron-window inspection + `session.log`).

**TDD note:** This repo has no test harness. We substitute the spec's verification plan (HANDOFF-style manual replay + log inspection) for unit tests. Every code task ends with `npx tsc --noEmit` and a commit; the final task is a manual verification pass.

**Spec:** `docs/superpowers/specs/2026-05-24-price-action-beta-short-setup-design.md`

---

## Task 1: Implement the strategy in `priceActionBeta.ts`

**Files:**
- Modify: `src/engine/priceActionBeta.ts` (currently a 14-line stub)

The whole file gets rewritten. Existing import-from-`./strategy` for the `Signal` type stays.

- [ ] **Step 1: Replace the file with the full implementation**

```ts
import type { Candle } from '../types'
import type { Signal } from './strategy'
import { TOUCH_PCT, extendChannelToTime, type ChannelMeta } from './trendlines'

// Tuning constants — kept file-level per spec §7 (no UI knob in v1).
const STOP_BUFFER_PCT = 0.0002  // ~$0.90 on $4500 gold above the entry candle's high
const RR = 3                    // fixed 1:3 risk-reward

interface OpenShort {
  entryIdx: number
  entryPrice: number
  sl: number
  tp: number
  label: string
  channelLabel: string
}

function isUpperWickRejection(c: Candle): boolean {
  const body = Math.abs(c.close - c.open)
  const upperWick = c.high - Math.max(c.open, c.close)
  return upperWick > body
}

function upperRailAt(meta: ChannelMeta, t: number): number {
  return extendChannelToTime(meta.channel, t).upperEnd
}

// Price Action Beta — short setups from rejections off the top rail of live,
// rising support channels while price is still above EMA(21). 1:3 RR with the
// stop pinned to the entry candle's high. One open position at a time; the
// exit scan is intrabar-pessimistic (stop wins on same-bar SL+TP collision).
//
// Output is paired sell+buy Signals — portfolio.ts pairs them unchanged.
export function runPriceActionBeta(
  candles: ReadonlyArray<Candle>,
  liveSupportChannels: ReadonlyArray<ChannelMeta>,
  ema21ByTime: Map<number, number>,
): Signal[] {
  if (candles.length === 0) return []

  const midPrice = candles[Math.floor(candles.length / 2)].close
  const eps = midPrice * TOUCH_PCT
  const stopBuffer = midPrice * STOP_BUFFER_PCT

  const signals: Signal[] = []
  let open: OpenShort | null = null
  let tradeCount = 0

  for (let i = 0; i < candles.length; i++) {
    const bar = candles[i]
    const t = bar.time as number

    if (open) {
      if (i > open.entryIdx) {
        if (bar.high >= open.sl) {
          signals.push({ time: bar.time, side: 'buy', price: open.sl, label: open.label })
          console.log(
            `[strategy] exit label=${open.label} reason=stop price=${open.sl.toFixed(2)} bars=${i - open.entryIdx}`,
          )
          open = null
          continue
        }
        if (bar.low <= open.tp) {
          signals.push({ time: bar.time, side: 'buy', price: open.tp, label: open.label })
          console.log(
            `[strategy] exit label=${open.label} reason=target price=${open.tp.toFixed(2)} bars=${i - open.entryIdx}`,
          )
          open = null
          continue
        }
      }
      // Still open after the exit scan: log skip-armed for any channel that
      // would have triggered this bar. Per spec: at most once per (channel, bar).
      if (open) {
        const ema = ema21ByTime.get(t)
        if (ema !== undefined && bar.close > ema && isUpperWickRejection(bar)) {
          for (const meta of liveSupportChannels) {
            if (t < meta.channel.startTime) continue
            const rail = upperRailAt(meta, t)
            if (Math.abs(bar.close - rail) <= eps) {
              console.log(
                `[strategy] skip-armed ch=${meta.label} close=${bar.close.toFixed(2)} rail=${rail.toFixed(2)} reason=already-short`,
              )
            }
          }
        }
        continue
      }
    }

    // Flat: evaluate entry conditions.
    const ema = ema21ByTime.get(t)
    if (ema === undefined) continue
    if (bar.close <= ema) continue
    if (!isUpperWickRejection(bar)) continue

    for (const meta of liveSupportChannels) {
      if (t < meta.channel.startTime) continue
      const rail = upperRailAt(meta, t)
      if (Math.abs(bar.close - rail) > eps) continue

      tradeCount += 1
      const label = `PAB-${tradeCount}`
      const sl = bar.high + stopBuffer
      const r = sl - bar.close
      const tp = bar.close - RR * r

      signals.push({ time: bar.time, side: 'sell', price: bar.close, label })
      console.log(
        `[strategy] entry label=${label} ch=${meta.label} close=${bar.close.toFixed(2)} rail=${rail.toFixed(2)} ema=${ema.toFixed(2)} SL=${sl.toFixed(2)} TP=${tp.toFixed(2)} R=${r.toFixed(2)}`,
      )

      open = { entryIdx: i, entryPrice: bar.close, sl, tp, label, channelLabel: meta.label }
      break // first matching channel wins
    }
  }

  return signals
}
```

- [ ] **Step 2: Type-check**

```bash
npx tsc --noEmit
```

Expected output: clean. If TS complains about `Signal.label` being optional vs required, note that `Signal` already declares `label?: string` — leaving it as a string assignment is fine.

If it complains about `ChannelMeta` exports from `trendlines.ts`: verify that `ChannelMeta` is exported with `export interface ChannelMeta { ... }` (it is, per the read of `trendlines.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/engine/priceActionBeta.ts
git commit -m "price action beta: implement short setup off support top rail"
```

Note: signed commits, no co-author trailer (per HANDOFF §7 commit conventions).

---

## Task 2: Wire the new inputs into the sandbox

**Files:**
- Modify: `src/components/TradingResearchSandbox.tsx` (around line 1037 for the strategy call, and add a new memo near the existing EMA memo around line 587)

The current call is `runPriceActionBeta(visibleCandles)`. New shape requires `(visibleCandles, liveSupportChannels, ema21ByTime)`.

- [ ] **Step 1: Add a dedicated EMA(21) memo for the strategy**

Why dedicated: the existing `computeEma(visibleCandles, emaLength)` near line 587 is inside the chart-series effect and uses the user-configurable `emaLength`. The strategy always needs EMA(21) regardless of the user's overlay setting.

Insert this memo near the strategy signals memo (around line 1035, just before the existing `const signals = useMemo(...)`):

```ts
  // EMA(21) lookup map for the strategy. Independent of the chart overlay's
  // user-configurable emaLength so the strategy stays deterministic when the
  // user changes the displayed EMA length.
  const ema21ByTime = useMemo(() => {
    const map = new Map<number, number>()
    for (const p of computeEma(visibleCandles, 21)) map.set(p.time as number, p.value)
    return map
  }, [visibleCandles])
```

- [ ] **Step 2: Add a live-support filter memo**

Insert this right after the `ema21ByTime` memo:

```ts
  // Only live support channels feed the strategy (spec §2 condition 1).
  const liveSupportChannels = useMemo(
    () => channelsMeta.filter((m) => m.status === 'live' && m.channel.kind === 'support'),
    [channelsMeta],
  )
```

- [ ] **Step 3: Update the strategy call**

Find this line (currently around 1037):

```ts
    () => (strategyEnabled ? runPriceActionBeta(visibleCandles) : []),
    [visibleCandles, strategyEnabled],
```

Replace with:

```ts
    () => (strategyEnabled ? runPriceActionBeta(visibleCandles, liveSupportChannels, ema21ByTime) : []),
    [visibleCandles, strategyEnabled, liveSupportChannels, ema21ByTime],
```

- [ ] **Step 4: Type-check**

```bash
npx tsc --noEmit
```

Expected: clean. If TS complains that `computeEma` returns `LinePoint` with `time: number` and we're casting to number — that's already the type, no cast needed; remove `as number` if it warns.

- [ ] **Step 5: Commit**

```bash
git add src/components/TradingResearchSandbox.tsx
git commit -m "sandbox: feed live support channels and EMA21 map into strategy"
```

---

## Task 3: Add `[strategy]` to the agent-bridge log filter

**Files:**
- Modify: `electron/main.cjs:85-93` (the `console-message` handler)

- [ ] **Step 1: Extend the filter regex**

Find this block in `electron/main.cjs`:

```js
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (
      message.startsWith('[draw]') ||
      message.startsWith('[replay]') ||
      message.startsWith('[channels]')
    ) {
      appendLog(`[${new Date().toISOString()}] ${message}`)
    }
  })
```

Replace with:

```js
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (
      message.startsWith('[draw]') ||
      message.startsWith('[replay]') ||
      message.startsWith('[channels]') ||
      message.startsWith('[strategy]')
    ) {
      appendLog(`[${new Date().toISOString()}] ${message}`)
    }
  })
```

Also update the comment at line 8 to reflect the new prefix list. Find:

```js
// Bridge for the agent: capture renderer console.log lines prefixed with
// [draw] or [replay] into a fresh file on every session start.
```

Replace with:

```js
// Bridge for the agent: capture renderer console.log lines prefixed with
// [draw], [replay], [channels], or [strategy] into a fresh file on every session start.
```

- [ ] **Step 2: Commit**

```bash
git add electron/main.cjs
git commit -m "electron: forward [strategy] console lines to session.log"
```

No type-check needed — `electron/main.cjs` is JS.

---

## Task 4: Manual verification

**Files:** none modified — this is the verification pass per spec §11.

- [ ] **Step 1: Stop any running `electron:dev` and restart**

Required because `electron/main.cjs` changed and does NOT hot-reload (HANDOFF §1).

```bash
# kill the current electron:dev (Ctrl+C in its terminal, or close the window)
npm run electron:dev
```

- [ ] **Step 2: Load the default range (2026-05-21 00:00 → 20:00 Casa)**

Already the default per `TradingResearchSandbox.tsx:45-49`. Should load on app open.

- [ ] **Step 3: Confirm `session.log` is freshly cleared**

```bash
head -1 "C:/Users/asus/Desktop/Xau_Algo/session.log"
```

Expected: line starting with `=== session start <ISO timestamp> ===`.

- [ ] **Step 4: Walk forward bar-by-bar from start (Home, then Right-arrow repeatedly)**

Press `Home` to jump to bar 0, then press Right-arrow to step forward one bar at a time. Watch the chart for sell arrows (entries) and buy arrows (exits).

- [ ] **Step 5: Confirm an entry log lands when an arrow appears**

When you see a sell arrow on the chart, check `session.log` for a matching line:

```bash
tail -20 "C:/Users/asus/Desktop/Xau_Algo/session.log" | grep '\[strategy\]'
```

Expected: a line like `[strategy] entry label=PAB-1 ch=S? close=... rail=... ema=... SL=... TP=... R=...`

Verify visually:
- `close` matches the bar's close on the chart.
- `rail` is at or just above `close` (proximity).
- `ema` is below `close` (filter passed).
- `SL > close`, `TP < close`, `R = SL - close`, `TP = close - 3*R` (within rounding).
- The bar has a visible upper wick larger than its body.

- [ ] **Step 6: Confirm the exit log lands when the buy arrow appears**

Step forward until the position closes. Expected log line: `[strategy] exit label=PAB-1 reason=stop|target price=... bars=K`. Verify:
- `price` equals SL or TP from the entry log.
- The buy arrow on the chart sits at the bar where `bar.high >= SL` or `bar.low <= TP` first held.

- [ ] **Step 7: Confirm portfolio panel reflects the closed trade**

Look at RightPanels strategy summary. Expected: 1 closed trade, PnL = `(entry - exit) * 100 * lotSize` (lotSize default 0.01 → $1 per $1 price move). Sign matches reason (positive for `reason=target`, negative for `reason=stop`).

- [ ] **Step 8: Confirm no second entry fires on the same channel while the first trade is open**

Between the entry and exit arrows of trade `PAB-1`, no `[strategy] entry` lines should appear in `session.log`. If the same channel keeps offering setups, you should see `[strategy] skip-armed ch=<label> ...` lines instead.

- [ ] **Step 9: Confirm the cancel-by-re-eval path**

Scrub forward to a section where price closes below EMA21 OR a support channel freezes. After that point, no new `[strategy] entry` line for that channel until conditions are restored. (No code path to debug — if logs are absent, the per-bar re-evaluation is doing its job.)

- [ ] **Step 10: Type-check the whole project once more**

```bash
npx tsc --noEmit
```

Expected: clean.

---

## Self-Review

**Spec coverage check (against `2026-05-24-price-action-beta-short-setup-design.md`):**

| Spec section | Covered by |
|---|---|
| §2 entry conditions (4 rules) | Task 1, Step 1 — `isUpperWickRejection`, `bar.close > ema`, proximity check, channel-range check |
| §3 risk model | Task 1, Step 1 — `sl = bar.high + stopBuffer`, `tp = close - RR * r` |
| §4 exit scan (pessimistic) | Task 1, Step 1 — `bar.high >= sl` checked before `bar.low <= tp` inside same loop iteration |
| §5 one-at-a-time concurrency | Task 1, Step 1 — `if (open) { ... continue }` skips entry path |
| §6 signature change | Task 1 (signature) + Task 2 (caller wiring) |
| §7 file-level constants | Task 1, Step 1 — `STOP_BUFFER_PCT`, `RR` declared at top of file |
| §8 telemetry vocabulary | Task 1, Step 1 (`entry`, `exit`, `skip-armed`) + Task 3 (filter forwards them) |
| §9 no new UI | Tasks 1–4 touch only engine, sandbox call site, and electron main — no component changes |
| §10 YAGNI list | Nothing in plan adds anything from that list |
| §11 verification plan | Task 4 (all 10 steps map to spec §11 items) |

**Placeholder scan:** no TBDs, no "handle edge cases", no "similar to Task N". Every code step shows the full code block to insert. ✓

**Type consistency:** `runPriceActionBeta` signature is `(candles, liveSupportChannels, ema21ByTime)` in Task 1 and the call site in Task 2 matches. `ChannelMeta` field accesses (`.status`, `.channel.kind`, `.channel.startTime`, `.label`) all match the definitions in `trendlines.ts`. ✓

**TDD substitution:** documented in the header — no test harness exists; verification = `tsc --noEmit` + manual replay + `session.log`. Honest to the project's actual workflow. ✓
