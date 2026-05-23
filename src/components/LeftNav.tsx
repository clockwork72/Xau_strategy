import { useEffect, useRef, useState } from 'react'
import { theme, fonts, sizes } from '../theme'
import type { Timeframe } from '../types'
import { parseCasaLocalToUtcSec } from '../util/time'

interface Props {
  timeframe: Timeframe
  onTimeframeChange: (tf: Timeframe) => void
  onRangeJump: (fromSec: number, toSec: number) => void
  onRangeFit: () => void
  initialRangeStart?: string
  initialRangeEnd?: string
  emaEnabled: boolean
  onEmaEnabledChange: (v: boolean) => void
  emaLength: number
  onEmaLengthChange: (n: number) => void
  sessionsEnabled: boolean
  onSessionsEnabledChange: (v: boolean) => void
  trendlineEnabled: boolean
  onTrendlineEnabledChange: (v: boolean) => void
  drawModeEnabled: boolean
  onDrawModeEnabledChange: (v: boolean) => void
  drawnLineCount: number
  onClearDrawnLines: () => void
  strategyEnabled: boolean
  onStrategyEnabledChange: (v: boolean) => void
  signalCount: number
}

export default function LeftNav({
  timeframe,
  onTimeframeChange,
  onRangeJump,
  onRangeFit,
  initialRangeStart,
  initialRangeEnd,
  emaEnabled,
  onEmaEnabledChange,
  emaLength,
  onEmaLengthChange,
  sessionsEnabled,
  onSessionsEnabledChange,
  trendlineEnabled,
  onTrendlineEnabledChange,
  drawModeEnabled,
  onDrawModeEnabledChange,
  drawnLineCount,
  onClearDrawnLines,
  strategyEnabled,
  onStrategyEnabledChange,
  signalCount,
}: Props) {
  return (
    <aside
      style={{
        width: sizes.leftNav,
        background: theme.panel,
        borderRight: `1px solid ${theme.border}`,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: fonts.sans,
        overflow: 'auto',
      }}
    >
      <Section label="Instrument">
        <InstrumentRow symbol="XAUUSD.sml" />
      </Section>

      <Section label="Timeframe">
        {(['1m', '5m'] as const).map((tf) => (
          <TimeframeRow
            key={tf}
            active={timeframe === tf}
            onClick={() => onTimeframeChange(tf)}
            label={tf === '1m' ? '1-Minute' : '5-Minute'}
            badge={tf.toUpperCase()}
          />
        ))}
      </Section>

      <Section label="Range (Casa)">
        <RangePicker
          onApply={onRangeJump}
          onFit={onRangeFit}
          initialStart={initialRangeStart}
          initialEnd={initialRangeEnd}
        />
      </Section>

      <Section label="Indicators">
        <EmaRow
          enabled={emaEnabled}
          length={emaLength}
          onEnabledChange={onEmaEnabledChange}
          onLengthChange={onEmaLengthChange}
        />
        <SessionsRow enabled={sessionsEnabled} onChange={onSessionsEnabledChange} />
        <SimpleToggleRow
          label="Trendline"
          enabled={trendlineEnabled}
          onChange={onTrendlineEnabledChange}
        />
        <DrawRow
          enabled={drawModeEnabled}
          onChange={onDrawModeEnabledChange}
          count={drawnLineCount}
          onClear={onClearDrawnLines}
        />
      </Section>

      <Section label="Strategy">
        <StrategyRow
          enabled={strategyEnabled}
          onChange={onStrategyEnabledChange}
          signalCount={signalCount}
        />
      </Section>
    </aside>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 12px 10px 12px', borderBottom: `1px solid ${theme.border}` }}>
      <div
        style={{
          fontSize: 10,
          color: theme.textInactive,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          marginBottom: 8,
          fontFamily: fonts.mono,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>{children}</div>
    </div>
  )
}

function InstrumentRow({ symbol }: { symbol: string }) {
  return (
    <div style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 12, color: theme.text, fontFamily: fonts.mono, letterSpacing: 0.3 }}>
        {symbol}
      </span>
    </div>
  )
}

function TimeframeRow({
  active,
  label,
  badge,
  onClick,
}: {
  active: boolean
  label: string
  badge: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        appearance: 'none',
        background: active ? theme.surface : 'transparent',
        border: 'none',
        color: active ? theme.text : theme.textMuted,
        padding: '6px 8px',
        fontSize: 12,
        fontFamily: 'inherit',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderRadius: 5,
        transition: 'background 120ms',
      }}
    >
      <span>{label}</span>
      <span style={{ fontSize: 10, fontFamily: fonts.mono, color: theme.textInactive, letterSpacing: 0.6 }}>
        {badge}
      </span>
    </button>
  )
}

function StrategyRow({
  enabled,
  onChange,
  signalCount,
}: {
  enabled: boolean
  onChange: (v: boolean) => void
  signalCount: number
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        cursor: 'pointer',
        borderRadius: 5,
        fontSize: 11,
        color: theme.text,
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0, accentColor: theme.textMuted, cursor: 'pointer' }}
      />
      <span
        style={{
          flex: 1,
          color: enabled ? theme.text : theme.textMuted,
          fontFamily: fonts.mono,
          letterSpacing: 0.4,
        }}
      >
        Signals
      </span>
      <span
        style={{
          fontSize: 10,
          fontFamily: fonts.mono,
          color: theme.textInactive,
          letterSpacing: 0.4,
        }}
      >
        {enabled ? signalCount : '—'}
      </span>
    </label>
  )
}

function DrawRow({
  enabled,
  onChange,
  count,
  onClear,
}: {
  enabled: boolean
  onChange: (v: boolean) => void
  count: number
  onClear: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 8px',
        borderRadius: 5,
        fontSize: 11,
        color: theme.text,
      }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => onChange(e.target.checked)}
          style={{ margin: 0, accentColor: theme.warn, cursor: 'pointer' }}
        />
        <span
          style={{
            color: enabled ? theme.text : theme.textMuted,
            fontFamily: fonts.mono,
            letterSpacing: 0.4,
          }}
        >
          Draw
        </span>
      </label>
      <span
        style={{
          fontSize: 10,
          fontFamily: fonts.mono,
          color: theme.textInactive,
        }}
      >
        {count}
      </span>
      <button
        onClick={onClear}
        disabled={count === 0}
        style={{
          appearance: 'none',
          background: 'transparent',
          border: `1px solid ${theme.border}`,
          color: count === 0 ? theme.textInactive : theme.textMuted,
          padding: '2px 6px',
          fontSize: 9.5,
          fontFamily: fonts.mono,
          letterSpacing: 0.4,
          borderRadius: 3,
          cursor: count === 0 ? 'default' : 'pointer',
          opacity: count === 0 ? 0.45 : 1,
        }}
      >
        Clear
      </button>
    </div>
  )
}

function SimpleToggleRow({
  label,
  enabled,
  onChange,
}: {
  label: string
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        cursor: 'pointer',
        borderRadius: 5,
        fontSize: 11,
        color: theme.text,
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0, accentColor: theme.textMuted, cursor: 'pointer' }}
      />
      <span
        style={{
          flex: 1,
          color: enabled ? theme.text : theme.textMuted,
          fontFamily: fonts.mono,
          letterSpacing: 0.4,
        }}
      >
        {label}
      </span>
    </label>
  )
}

function SessionsRow({
  enabled,
  onChange,
}: {
  enabled: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        cursor: 'pointer',
        borderRadius: 5,
        fontSize: 11,
        color: theme.text,
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{ margin: 0, accentColor: theme.textMuted, cursor: 'pointer' }}
      />
      <span
        style={{
          flex: 1,
          color: enabled ? theme.text : theme.textMuted,
          fontFamily: fonts.mono,
          letterSpacing: 0.4,
        }}
      >
        Sessions
      </span>
    </label>
  )
}

function RangePicker({
  onApply,
  onFit,
  initialStart,
  initialEnd,
}: {
  onApply: (fromSec: number, toSec: number) => void
  onFit: () => void
  initialStart?: string
  initialEnd?: string
}) {
  const [start, setStart] = useState(initialStart ?? '')
  const [end, setEnd] = useState(initialEnd ?? '')
  const startSec = start ? parseCasaLocalToUtcSec(start) : null
  const endSec = end ? parseCasaLocalToUtcSec(end) : null
  const startInvalid = start.length > 0 && startSec === null
  const endInvalid = end.length > 0 && endSec === null
  const orderInvalid = startSec !== null && endSec !== null && startSec >= endSec
  const canApply = startSec !== null && endSec !== null && !orderInvalid

  const apply = () => {
    if (canApply) onApply(startSec!, endSec!)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <RangeInput
        label="Start"
        value={start}
        invalid={startInvalid}
        onChange={setStart}
        onSubmit={apply}
      />
      <RangeInput
        label="End"
        value={end}
        invalid={endInvalid || orderInvalid}
        onChange={setEnd}
        onSubmit={apply}
      />
      <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
        <button
          onClick={apply}
          disabled={!canApply}
          style={{ ...rangeBtn, flex: 1, opacity: canApply ? 1 : 0.45, cursor: canApply ? 'pointer' : 'default' }}
        >
          Apply
        </button>
        <button onClick={onFit} style={{ ...rangeBtn, flex: 1 }}>
          Fit
        </button>
      </div>
      {orderInvalid && (
        <span style={{ fontSize: 9, color: theme.down, fontFamily: fonts.mono }}>
          end must be after start
        </span>
      )}
    </div>
  )
}

function RangeInput({
  label,
  value,
  invalid,
  onChange,
  onSubmit,
}: {
  label: string
  value: string
  invalid: boolean
  onChange: (v: string) => void
  onSubmit: () => void
}) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          width: 32,
          fontSize: 9,
          color: theme.textInactive,
          letterSpacing: 0.8,
          textTransform: 'uppercase',
          fontFamily: fonts.mono,
        }}
      >
        {label}
      </span>
      <input
        type="text"
        value={value}
        placeholder="2026-05-21 00:00"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
        }}
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          background: theme.surface,
          color: theme.text,
          border: `1px solid ${invalid ? theme.down : theme.border}`,
          borderRadius: 4,
          padding: '4px 6px',
          fontSize: 10.5,
          fontFamily: fonts.mono,
          letterSpacing: 0.3,
          outline: 'none',
        }}
      />
    </label>
  )
}

function EmaRow({
  enabled,
  length,
  onEnabledChange,
  onLengthChange,
}: {
  enabled: boolean
  length: number
  onEnabledChange: (v: boolean) => void
  onLengthChange: (n: number) => void
}) {
  const [draft, setDraft] = useState(String(length))
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(String(length))
  }, [length])
  const commit = (raw: string) => {
    const n = parseInt(raw, 10)
    if (Number.isFinite(n)) {
      const clamped = Math.min(300, Math.max(2, n))
      onLengthChange(clamped)
      setDraft(String(clamped))
    } else {
      setDraft(String(length))
    }
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '5px 8px',
        borderRadius: 5,
        fontSize: 11,
        color: theme.text,
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) => onEnabledChange(e.target.checked)}
        style={{ margin: 0, accentColor: theme.warn, cursor: 'pointer' }}
      />
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: enabled ? theme.warn : 'transparent',
          border: `1px solid ${theme.warn}`,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          color: enabled ? theme.text : theme.textMuted,
          fontFamily: fonts.mono,
          letterSpacing: 0.4,
        }}
      >
        EMA
      </span>
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        style={{
          width: 38,
          background: theme.surface,
          color: theme.text,
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          padding: '2px 5px',
          fontSize: 10.5,
          fontFamily: fonts.mono,
          textAlign: 'right',
          outline: 'none',
        }}
      />
    </div>
  )
}

const rangeBtn: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: `1px solid ${theme.border}`,
  color: theme.text,
  padding: '5px 8px',
  fontSize: 11,
  fontFamily: 'inherit',
  textAlign: 'center',
  borderRadius: 5,
  transition: 'border-color 120ms, color 120ms, background 120ms',
}
