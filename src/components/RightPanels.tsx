import { useEffect, useRef, useState } from 'react'
import { theme, fonts, sizes } from '../theme'
import type { Candle, Timeframe } from '../types'
import type { StrategyStats } from '../engine/portfolio'
import type { ChannelMeta } from '../engine/trendlines'
import { DISPLAY_TZ_LABEL, formatCrosshair } from '../util/time'

interface Props {
  timeframe: Timeframe
  hovered: Candle | null
  stats: StrategyStats
  strategyEnabled: boolean
  lotSize: number
  onLotSizeChange: (n: number) => void
  startingBalance: number
  onStartingBalanceChange: (n: number) => void
  markPrice: number | null
  channelsMeta: ChannelMeta[]
  showResistance: boolean
  showSupport: boolean
  onToggleChannelKind: (kind: 'resistance' | 'support') => void
  hiddenChannelLabels: ReadonlySet<string>
  onToggleChannelLabelHidden: (label: string) => void
  onClearHiddenChannelLabels: () => void
}

export default function RightPanels({
  timeframe,
  hovered,
  stats,
  strategyEnabled,
  lotSize,
  onLotSizeChange,
  startingBalance,
  onStartingBalanceChange,
  markPrice,
  channelsMeta,
  showResistance,
  showSupport,
  onToggleChannelKind,
  hiddenChannelLabels,
  onToggleChannelLabelHidden,
  onClearHiddenChannelLabels,
}: Props) {
  return (
    <aside
      style={{
        width: sizes.rightPanels,
        background: theme.panel,
        borderLeft: `1px solid ${theme.border}`,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'auto',
        fontFamily: fonts.sans,
      }}
    >
      <StrategySummary
        stats={stats}
        enabled={strategyEnabled}
        lotSize={lotSize}
        onLotSizeChange={onLotSizeChange}
        startingBalance={startingBalance}
        onStartingBalanceChange={onStartingBalanceChange}
        markPrice={markPrice}
      />
      <ChannelsList
        channels={channelsMeta}
        showResistance={showResistance}
        showSupport={showSupport}
        onToggleKind={onToggleChannelKind}
        hiddenLabels={hiddenChannelLabels}
        onToggleLabelHidden={onToggleChannelLabelHidden}
        onClearHiddenLabels={onClearHiddenChannelLabels}
      />
      <BarInspector hovered={hovered} />
      <Notes timeframe={timeframe} />
    </aside>
  )
}

// ---------- Strategy Summary ----------
function StrategySummary({
  stats,
  enabled,
  lotSize,
  onLotSizeChange,
  startingBalance,
  onStartingBalanceChange,
  markPrice,
}: {
  stats: StrategyStats
  enabled: boolean
  lotSize: number
  onLotSizeChange: (n: number) => void
  startingBalance: number
  onStartingBalanceChange: (n: number) => void
  markPrice: number | null
}) {
  const equityDelta = stats.equity - startingBalance
  const equityPct = startingBalance > 0 ? (equityDelta / startingBalance) * 100 : 0
  const equityColor = equityDelta > 0 ? theme.up : equityDelta < 0 ? theme.down : theme.text
  const exposureOz = lotSize * 100

  return (
    <Panel label="Strategy" extra={enabled ? 'Price Action Beta' : 'OFF'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {/* equity hero */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span
            style={{
              fontSize: 9,
              letterSpacing: 1,
              color: theme.textInactive,
              fontFamily: fonts.mono,
              textTransform: 'uppercase',
            }}
          >
            Equity
          </span>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 22,
                fontWeight: 600,
                color: equityColor,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: -0.3,
              }}
            >
              {formatMoney(stats.equity)}
            </span>
            <span
              style={{
                fontFamily: fonts.mono,
                fontSize: 11,
                color: equityColor,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {formatSignedPct(equityPct)}
            </span>
          </div>
        </div>

        {/* PnL split */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Row
            k="REALIZED"
            v={formatSignedMoney(stats.realizedPnl)}
            color={pnlColor(stats.realizedPnl)}
          />
          <Row
            k="OPEN"
            v={formatSignedMoney(stats.unrealizedPnl)}
            color={pnlColor(stats.unrealizedPnl)}
            muted={stats.openTrade === null}
          />
        </div>

        <Hairline />

        {/* trade stats */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Row k="TRADES" v={stats.totalTrades.toString()} />
          <Row
            k="WIN RATE"
            v={
              stats.winRate === null
                ? '—'
                : `${(stats.winRate * 100).toFixed(0)}%  ·  ${stats.wins}W/${stats.losses}L`
            }
          />
          <Row
            k="AVG W/L"
            v={
              stats.totalTrades === 0
                ? '—'
                : `${formatSignedMoney(stats.avgWin)} / ${formatSignedMoney(stats.avgLoss)}`
            }
            muted={stats.totalTrades === 0}
          />
        </div>

        {/* open position card */}
        {stats.openTrade && markPrice !== null && (
          <>
            <Hairline />
            <PositionCard
              side={stats.openTrade.side}
              entryPrice={stats.openTrade.entryPrice}
              markPrice={markPrice}
              unrealizedPnl={stats.unrealizedPnl}
              exposureOz={exposureOz}
            />
          </>
        )}

        <Hairline />

        {/* settings — lot size & starting balance */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <NumberInputRow
            label="LOT SIZE"
            value={lotSize}
            min={0.01}
            max={100}
            step={0.01}
            precision={2}
            suffix={`${exposureOz.toFixed(2).replace(/\.00$/, '')} oz`}
            onCommit={onLotSizeChange}
          />
          <NumberInputRow
            label="BALANCE"
            value={startingBalance}
            min={1}
            max={1_000_000}
            step={1}
            precision={2}
            prefix="$"
            onCommit={onStartingBalanceChange}
          />
        </div>
      </div>
    </Panel>
  )
}

function PositionCard({
  side,
  entryPrice,
  markPrice,
  unrealizedPnl,
  exposureOz,
}: {
  side: 'long' | 'short'
  entryPrice: number
  markPrice: number
  unrealizedPnl: number
  exposureOz: number
}) {
  const sideColor = side === 'long' ? theme.up : theme.down
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontFamily: fonts.mono,
          fontSize: 11,
        }}
      >
        <span
          style={{
            color: sideColor,
            fontWeight: 600,
            letterSpacing: 0.6,
          }}
        >
          {side.toUpperCase()}
        </span>
        <span style={{ color: theme.textMuted }}>·</span>
        <span style={{ color: theme.text, fontVariantNumeric: 'tabular-nums' }}>
          {exposureOz.toFixed(2).replace(/\.00$/, '')} oz
        </span>
        <span style={{ flex: 1 }} />
        <span
          style={{
            color: pnlColor(unrealizedPnl),
            fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatSignedMoney(unrealizedPnl)}
        </span>
      </div>
      <div
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: theme.textInactive,
          letterSpacing: 0.3,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        @ {entryPrice.toFixed(3)} → {markPrice.toFixed(3)}
      </div>
    </div>
  )
}

function NumberInputRow({
  label,
  value,
  min,
  max,
  step,
  precision,
  prefix,
  suffix,
  onCommit,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  precision: number
  prefix?: string
  suffix?: string
  onCommit: (n: number) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState(value.toFixed(precision))
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setDraft(value.toFixed(precision))
  }, [value, precision])

  const commit = (raw: string) => {
    const n = parseFloat(raw)
    if (Number.isFinite(n)) {
      const clamped = Math.min(max, Math.max(min, n))
      onCommit(clamped)
      setDraft(clamped.toFixed(precision))
    } else {
      setDraft(value.toFixed(precision))
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ flex: 1, color: theme.textInactive, fontSize: 10, letterSpacing: 0.5 }}>
        {label}
      </span>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 4,
          padding: '2px 6px',
          gap: 3,
        }}
      >
        {prefix && (
          <span style={{ color: theme.textInactive, fontSize: 10, fontFamily: fonts.mono }}>
            {prefix}
          </span>
        )}
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value.replace(/[^0-9.]/g, ''))}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'ArrowUp') {
              e.preventDefault()
              commit(String(value + step))
            }
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              commit(String(value - step))
            }
          }}
          style={{
            width: 64,
            background: 'transparent',
            border: 'none',
            color: theme.text,
            fontFamily: fonts.mono,
            fontSize: 11,
            textAlign: 'right',
            outline: 'none',
            padding: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      </div>
      {suffix && (
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 10,
            color: theme.textInactive,
            minWidth: 44,
            textAlign: 'right',
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  )
}

function Hairline() {
  return <div style={{ height: 1, background: theme.border, margin: '4px 0' }} />
}

function pnlColor(n: number): string | undefined {
  if (n > 0) return theme.up
  if (n < 0) return theme.down
  return undefined
}

function formatMoney(n: number): string {
  const sign = n < 0 ? '-' : ''
  return `${sign}$${Math.abs(n).toFixed(2)}`
}
function formatSignedMoney(n: number): string {
  if (n === 0) return '$0.00'
  const sign = n > 0 ? '+' : '−'
  return `${sign}$${Math.abs(n).toFixed(2)}`
}
function formatSignedPct(n: number): string {
  if (!Number.isFinite(n)) return '—'
  if (n === 0) return '0.00%'
  const sign = n > 0 ? '+' : '−'
  return `${sign}${Math.abs(n).toFixed(2)}%`
}

// ---------- Channels (algo-detected) ----------
function ChannelsList({
  channels,
  showResistance,
  showSupport,
  onToggleKind,
  hiddenLabels,
  onToggleLabelHidden,
  onClearHiddenLabels,
}: {
  channels: ChannelMeta[]
  showResistance: boolean
  showSupport: boolean
  onToggleKind: (kind: 'resistance' | 'support') => void
  hiddenLabels: ReadonlySet<string>
  onToggleLabelHidden: (label: string) => void
  onClearHiddenLabels: () => void
}) {
  const resistance = channels.filter((m) => m.channel.kind === 'resistance')
  const support = channels.filter((m) => m.channel.kind === 'support')
  const enabledChannels =
    (showResistance ? resistance : []).concat(showSupport ? support : [])
  const hiddenInScope = enabledChannels.reduce(
    (n, m) => (hiddenLabels.has(m.label) ? n + 1 : n),
    0,
  )
  const visibleCount = enabledChannels.length - hiddenInScope
  const extra =
    enabledChannels.length === 0
      ? undefined
      : hiddenInScope > 0
      ? `${visibleCount} · ${hiddenInScope} hidden`
      : `${visibleCount}`

  return (
    <Panel label="Channels" extra={extra}>
      <KindSection
        label="Resistance"
        enabled={showResistance}
        channels={resistance}
        onToggle={() => onToggleKind('resistance')}
        hiddenLabels={hiddenLabels}
        onToggleLabelHidden={onToggleLabelHidden}
      />
      <KindSection
        label="Support"
        enabled={showSupport}
        channels={support}
        onToggle={() => onToggleKind('support')}
        hiddenLabels={hiddenLabels}
        onToggleLabelHidden={onToggleLabelHidden}
      />
      {hiddenInScope > 0 && (
        <button
          onClick={onClearHiddenLabels}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 'none',
            color: theme.textMuted,
            fontFamily: fonts.mono,
            fontSize: 10,
            letterSpacing: 0.5,
            padding: '6px 0 2px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = theme.text }}
          onMouseLeave={(e) => { e.currentTarget.style.color = theme.textMuted }}
        >
          show all
        </button>
      )}
    </Panel>
  )
}

function KindSection({
  label,
  enabled,
  channels,
  onToggle,
  hiddenLabels,
  onToggleLabelHidden,
}: {
  label: string
  enabled: boolean
  channels: ChannelMeta[]
  onToggle: () => void
  hiddenLabels: ReadonlySet<string>
  onToggleLabelHidden: (label: string) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <KindHeader
        label={label}
        enabled={enabled}
        count={channels.length}
        onClick={onToggle}
      />
      {enabled && channels.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', paddingBottom: 4 }}>
          {channels.map((m) => (
            <ChannelRow
              key={`${m.channel.kind}|${m.channel.startTime}`}
              meta={m}
              hidden={hiddenLabels.has(m.label)}
              onClick={() => onToggleLabelHidden(m.label)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function KindHeader({
  label,
  enabled,
  count,
  onClick,
}: {
  label: string
  enabled: boolean
  count: number
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      title={enabled ? `Hide ${label.toLowerCase()} channels` : `Show ${label.toLowerCase()} channels`}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 2px',
        cursor: 'pointer',
        textAlign: 'left',
        borderRadius: 4,
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span
        style={{
          width: 10, height: 10, borderRadius: '50%',
          background: enabled ? theme.accent : 'transparent',
          border: `1.5px solid ${theme.accent}`,
          boxSizing: 'border-box',
          flexShrink: 0,
        }}
      />
      <span
        style={{
          flex: 1,
          fontFamily: fonts.mono,
          fontSize: 11,
          color: enabled ? theme.text : theme.textMuted,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 10,
          color: enabled ? theme.textInactive : theme.textMuted,
          fontVariantNumeric: 'tabular-nums',
          minWidth: 14,
          textAlign: 'right',
        }}
      >
        {enabled ? (count || '—') : 'off'}
      </span>
    </button>
  )
}

function ChannelRow({
  meta,
  hidden,
  onClick,
}: {
  meta: ChannelMeta
  hidden: boolean
  onClick: () => void
}) {
  const { label, channel, status } = meta
  const isBroken = status === 'broken'
  const opacity = hidden ? 0.35 : isBroken ? 0.7 : 1
  return (
    <button
      onClick={onClick}
      title={hidden ? `Show ${label}` : `Hide ${label}`}
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '3px 4px 3px 20px',
        cursor: 'pointer',
        textAlign: 'left',
        borderRadius: 4,
        opacity,
        transition: 'opacity 120ms, background 120ms',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: 11,
          color: theme.accent,
          letterSpacing: 0.4,
          minWidth: 26,
          fontVariantNumeric: 'tabular-nums',
          textDecoration: hidden ? 'line-through' : 'none',
        }}
      >
        {label}
      </span>
      <StatusPill broken={isBroken} />
      <span style={{ flex: 1 }} />
      <span
        style={{
          fontSize: 10,
          color: theme.textInactive,
          fontFamily: fonts.mono,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {channel.touches}t
      </span>
    </button>
  )
}

function StatusPill({ broken }: { broken: boolean }) {
  return (
    <span
      style={{
        fontFamily: fonts.mono,
        fontSize: 9,
        letterSpacing: 0.6,
        padding: '1px 5px',
        borderRadius: 3,
        background: broken ? 'transparent' : theme.accent,
        color: broken ? theme.textMuted : theme.panel,
        border: broken ? `1px solid ${theme.textMuted}` : `1px solid ${theme.accent}`,
        textTransform: 'uppercase',
      }}
    >
      {broken ? 'broken' : 'live'}
    </span>
  )
}

// ---------- Bar Inspector ----------
function BarInspector({ hovered }: { hovered: Candle | null }) {
  const c = hovered
  return (
    <Panel label="Bar Inspector" minHeight={150}>
      {c === null ? (
        <Placeholder text="— hover a bar" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontFamily: fonts.mono, fontSize: 11 }}>
          <Row k={`TIME · ${DISPLAY_TZ_LABEL}`} v={formatCrosshair(c.time as number)} />
          <Row k="OPEN" v={c.open.toFixed(3)} />
          <Row
            k="HIGH"
            v={c.high.toFixed(3)}
            color={c.close > c.open ? theme.up : undefined}
          />
          <Row
            k="LOW"
            v={c.low.toFixed(3)}
            color={c.close < c.open ? theme.down : undefined}
          />
          <Row k="CLOSE" v={c.close.toFixed(3)} bold />
          <Row k="RANGE" v={(c.high - c.low).toFixed(3)} muted />
          <Row k="DELTA" v={(c.close - c.open).toFixed(3)} color={c.close > c.open ? theme.up : theme.down} />
          <Row k="TICKVOL" v={c.tickVolume.toLocaleString()} muted />
          {/* body-position bar */}
          <div style={{ marginTop: 4, height: 4, background: theme.surface, borderRadius: 2, position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                left: `${bodyLeftPct(c)}%`,
                width: `${bodyWidthPct(c)}%`,
                top: 0,
                bottom: 0,
                background: c.close >= c.open ? theme.up : theme.down,
                borderRadius: 2,
              }}
            />
          </div>
        </div>
      )}
    </Panel>
  )
}

function bodyLeftPct(c: Candle) {
  const rng = c.high - c.low
  if (rng <= 0) return 0
  return (Math.min(c.open, c.close) - c.low) / rng * 100
}
function bodyWidthPct(c: Candle) {
  const rng = c.high - c.low
  if (rng <= 0) return 100
  return Math.max(1, Math.abs(c.close - c.open) / rng * 100)
}

// ---------- Notes ----------
function Notes({ timeframe }: { timeframe: Timeframe }) {
  const key = `xau-sbx-notes-${timeframe}`
  const [val, setVal] = useState<string>('')

  useEffect(() => {
    try {
      setVal(localStorage.getItem(key) ?? '')
    } catch {
      setVal('')
    }
  }, [key])

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(key, val)
      } catch {
        /* ignore */
      }
    }, 300)
    return () => clearTimeout(t)
  }, [val, key])

  return (
    <Panel label="Notes" extra={timeframe} flex={1}>
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        style={{
          width: '100%',
          height: '100%',
          minHeight: 120,
          background: theme.surface,
          border: `1px solid ${theme.border}`,
          borderRadius: 5,
          color: theme.text,
          fontFamily: fonts.sans,
          fontSize: 11,
          padding: 8,
          resize: 'none',
          outline: 'none',
        }}
      />
    </Panel>
  )
}

// ---------- shared bits ----------
function Panel({
  label,
  extra,
  children,
  minHeight,
  flex,
}: {
  label: string
  extra?: string
  children: React.ReactNode
  minHeight?: number
  flex?: number
}) {
  return (
    <section
      style={{
        display: 'flex',
        flexDirection: 'column',
        borderBottom: `1px solid ${theme.border}`,
        minHeight,
        flex,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          fontFamily: fonts.mono,
          fontSize: 10,
          letterSpacing: 1.2,
          color: theme.text,
          background: 'transparent',
        }}
      >
        <span style={{ textTransform: 'uppercase' }}>{label}</span>
        {extra && <span style={{ color: theme.textInactive }}>{extra}</span>}
      </header>
      <div
        style={{
          padding: '0 12px 12px 12px',
          overflow: 'hidden',
          flex: flex ? 1 : undefined,
          minHeight: 0,
        }}
      >
        {children}
      </div>
    </section>
  )
}

function Row({
  k,
  v,
  bold,
  muted,
  color,
}: {
  k: string
  v: string
  bold?: boolean
  muted?: boolean
  color?: string
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
      <span style={{ color: theme.textInactive, fontSize: 10, letterSpacing: 0.5 }}>{k}</span>
      <span
        style={{
          color: color ?? (muted ? theme.textInactive : theme.text),
          fontWeight: bold ? 600 : 400,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {v}
      </span>
    </div>
  )
}

function Placeholder({ text }: { text: string }) {
  return (
    <div
      style={{
        color: theme.textInactive,
        fontSize: 11,
        fontFamily: fonts.mono,
        padding: '6px 0',
      }}
    >
      {text}
    </div>
  )
}
