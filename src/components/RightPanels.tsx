import { useEffect, useRef, useState } from 'react'
import { theme, fonts, sizes } from '../theme'
import type { Candle, Timeframe } from '../types'
import type { ClosedTrade, StrategyStats } from '../engine/portfolio'
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
  markTime: number | null
  onZoomToTrade: (from: number, to: number) => void
  zoomSensitivity: number
  onZoomSensitivityChange: (n: number) => void
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
  markTime,
  onZoomToTrade,
  zoomSensitivity,
  onZoomSensitivityChange,
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
        markTime={markTime}
        onZoomToTrade={onZoomToTrade}
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
      <SettingsSection
        zoomSensitivity={zoomSensitivity}
        onZoomSensitivityChange={onZoomSensitivityChange}
      />
    </aside>
  )
}

// ---------- Strategy Summary ----------
// Direction A — minimal lines + summary:
//  LIVE trade card (only when an open trade has SL/TP)
//  one-line stats row + equity row
//  closed trades list (compact, one row per trade)
//  settings (lot size, balance)
function StrategySummary({
  stats,
  enabled,
  lotSize,
  onLotSizeChange,
  startingBalance,
  onStartingBalanceChange,
  markPrice,
  markTime,
  onZoomToTrade,
}: {
  stats: StrategyStats
  enabled: boolean
  lotSize: number
  onLotSizeChange: (n: number) => void
  startingBalance: number
  onStartingBalanceChange: (n: number) => void
  markPrice: number | null
  markTime: number | null
  onZoomToTrade: (from: number, to: number) => void
}) {
  const equityDelta = stats.equity - startingBalance
  const equityPct = startingBalance > 0 ? (equityDelta / startingBalance) * 100 : 0
  const equityColor = equityDelta > 0 ? theme.up : equityDelta < 0 ? theme.down : theme.text
  const exposureOz = lotSize * 100
  const open = stats.openTrade
  const hasOpenWithLevels = !!(open && open.sl !== undefined && open.tp !== undefined)

  return (
    <Panel label="Strategy" extra={enabled ? 'Price Action Beta' : 'OFF'}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {hasOpenWithLevels && open && (
          <LiveTradeCard
            open={open}
            markPrice={markPrice}
            unrealizedPnl={stats.unrealizedPnl}
            onZoom={
              markTime !== null
                ? () => onZoomToTrade(open.entryTime as number, markTime)
                : undefined
            }
          />
        )}

        {/* one-line summary: closed count · W/L · winrate */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            fontFamily: fonts.mono,
            fontSize: 11,
            color: theme.text,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>{stats.totalTrades} closed</span>
          {stats.totalTrades > 0 && (
            <>
              <span style={{ color: theme.textInactive }}>·</span>
              <span style={{ color: theme.up }}>{stats.wins}W</span>
              <span style={{ color: theme.textInactive }}>/</span>
              <span style={{ color: theme.down }}>{stats.losses}L</span>
              {stats.winRate !== null && (
                <>
                  <span style={{ color: theme.textInactive }}>·</span>
                  <span style={{ color: theme.text }}>
                    {(stats.winRate * 100).toFixed(0)}% win
                  </span>
                </>
              )}
            </>
          )}
        </div>

        {/* realized + equity */}
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            gap: 10,
            fontFamily: fonts.mono,
            fontSize: 11,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span style={{ color: pnlColor(stats.realizedPnl) ?? theme.textInactive }}>
            {formatSignedMoney(stats.realizedPnl)} realized
          </span>
          <span style={{ color: theme.textInactive }}>·</span>
          <span style={{ color: equityColor }}>
            {formatMoney(stats.equity)} {formatSignedPct(equityPct)}
          </span>
        </div>

        {/* max drawdown */}
        {stats.totalTrades > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              fontFamily: fonts.mono,
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span style={{ color: theme.textInactive }}>max DD</span>
            <span style={{ color: stats.maxDrawdown > 0 ? theme.down : theme.textInactive }}>
              {stats.maxDrawdown > 0
                ? `−${formatMoney(stats.maxDrawdown)}`
                : '$0.00'}
            </span>
            {startingBalance > 0 && stats.maxDrawdown > 0 && (
              <span style={{ color: theme.textInactive }}>
                ({((stats.maxDrawdown / startingBalance) * 100).toFixed(1)}%)
              </span>
            )}
          </div>
        )}

        {stats.closedTrades.length > 0 && (
          <>
            <Hairline />
            <ClosedTradesList trades={stats.closedTrades} onZoomToTrade={onZoomToTrade} />
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

function LiveTradeCard({
  open,
  markPrice,
  unrealizedPnl,
  onZoom,
}: {
  open: NonNullable<StrategyStats['openTrade']>
  markPrice: number | null
  unrealizedPnl: number
  onZoom?: () => void
}) {
  // open.sl / open.tp are guaranteed by the caller (`hasOpenWithLevels`),
  // but TS doesn't carry that narrowing across the prop boundary.
  const sl = open.sl as number
  const tp = open.tp as number
  const rDist = Math.abs(sl - open.entryPrice)
  const rOf = (price: number) =>
    rDist > 0
      ? (open.side === 'short' ? open.entryPrice - price : price - open.entryPrice) / rDist
      : 0
  const slR = rOf(sl) // -1 by construction
  const tpR = rOf(tp) // +3 in PAB v1
  const nowR = markPrice !== null && rDist > 0 ? rOf(markPrice) : null
  const sideColor = open.side === 'short' ? theme.down : theme.up

  return (
    <div
      onClick={onZoom}
      title={onZoom ? 'Zoom to live trade' : undefined}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '8px 10px',
        border: `1px solid ${theme.border}`,
        borderLeft: `2px solid ${theme.accent}`,
        background: theme.bg,
        fontFamily: fonts.mono,
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
        cursor: onZoom ? 'pointer' : 'default',
        transition: 'background 120ms',
      }}
      onMouseEnter={(e) => { if (onZoom) e.currentTarget.style.background = theme.surface }}
      onMouseLeave={(e) => { e.currentTarget.style.background = theme.bg }}
    >
      {/* header: LIVE pill · label · side · channel */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-block',
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: theme.accent,
          }}
        />
        <span style={{ color: theme.accent, fontSize: 9, letterSpacing: 1.4, fontWeight: 600 }}>
          LIVE
        </span>
        <span style={{ color: theme.text }}>{open.label ?? ''}</span>
        <span style={{ color: sideColor, fontWeight: 600 }}>{open.side.toUpperCase()}</span>
        {open.channelLabel && (
          <span style={{ color: theme.textInactive }}>ch={open.channelLabel}</span>
        )}
      </div>
      {/* entry / SL / TP / now grid — kept simple per mockup */}
      <LiveRow k="entry" v={`$${open.entryPrice.toFixed(2)}`} />
      <LiveRow k="SL" v={`$${sl.toFixed(2)}`} r={slR} accent={theme.down} />
      <LiveRow k="TP" v={`$${tp.toFixed(2)}`} r={tpR} accent={theme.up} />
      <LiveRow
        k="now"
        v={markPrice !== null ? formatSignedMoney(unrealizedPnl) : '—'}
        r={nowR}
        accent={pnlColor(unrealizedPnl)}
      />
    </div>
  )
}

function LiveRow({
  k,
  v,
  r,
  accent,
}: {
  k: string
  v: string
  r?: number | null
  accent?: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
      <span style={{ color: theme.textInactive, width: 36 }}>{k}</span>
      <span style={{ color: accent ?? theme.text, fontWeight: 500 }}>{v}</span>
      {r !== undefined && r !== null && (
        <span style={{ color: theme.textInactive, marginLeft: 'auto' }}>
          {r >= 0 ? '+' : ''}
          {r.toFixed(r === Math.trunc(r) ? 0 : 1)}R
        </span>
      )}
    </div>
  )
}

function ClosedTradesList({
  trades,
  onZoomToTrade,
}: {
  trades: ReadonlyArray<ClosedTrade>
  onZoomToTrade: (from: number, to: number) => void
}) {
  // Newest at the top — easier to spot most recent trade.
  const reversed = [...trades].reverse()
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div
        style={{
          fontSize: 9,
          letterSpacing: 1.2,
          color: theme.textInactive,
          fontFamily: fonts.mono,
          textTransform: 'uppercase',
          marginBottom: 2,
        }}
      >
        Closed ({trades.length})
      </div>
      {reversed.map((t) => (
        <ClosedTradeRow
          key={`${t.entryTime}-${t.exitTime}`}
          trade={t}
          onZoom={() => onZoomToTrade(t.entryTime as number, t.exitTime as number)}
        />
      ))}
    </div>
  )
}

function ClosedTradeRow({ trade, onZoom }: { trade: ClosedTrade; onZoom: () => void }) {
  const isWin = trade.pnl > 0
  const rText =
    trade.rMultiple !== undefined && Number.isFinite(trade.rMultiple)
      ? `${trade.rMultiple >= 0 ? '+' : ''}${trade.rMultiple.toFixed(1)}R`
      : null
  const durMin = Math.max(0, Math.round(((trade.exitTime as number) - (trade.entryTime as number)) / 60))
  const reasonText = trade.reason ?? '—'
  return (
    <button
      onClick={onZoom}
      title="Zoom to trade"
      style={{
        appearance: 'none',
        background: 'transparent',
        border: 'none',
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '3px 4px',
        fontFamily: fonts.mono,
        fontSize: 10,
        fontVariantNumeric: 'tabular-nums',
        color: theme.text,
        cursor: 'pointer',
        textAlign: 'left',
        borderRadius: 4,
        transition: 'background 120ms',
        width: '100%',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = theme.surface }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent' }}
    >
      <span style={{ minWidth: 44 }}>{trade.label ?? '—'}</span>
      {rText && (
        <span style={{ color: isWin ? theme.up : theme.down, minWidth: 38, fontWeight: 500 }}>
          {rText}
        </span>
      )}
      <span
        style={{
          color: isWin ? theme.up : trade.pnl < 0 ? theme.down : theme.textInactive,
          minWidth: 52,
          fontWeight: 500,
        }}
      >
        {formatSignedMoney(trade.pnl)}
      </span>
      {trade.channelLabel && (
        <span style={{ color: theme.textInactive, minWidth: 28 }}>{trade.channelLabel}</span>
      )}
      <span style={{ color: theme.textInactive }}>{reasonText}</span>
      <span style={{ flex: 1 }} />
      <span style={{ color: theme.textInactive }}>{durMin}m</span>
    </button>
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

// ---------- Settings ----------
// Sandbox-wide chart settings. Right now: just zoom sensitivity. The live
// value is mirrored into a ref in the sandbox so the wheel handler picks it
// up immediately without re-creating the chart. Persisted to localStorage
// in the sandbox under `xau:zoom-sensitivity`.
function SettingsSection({
  zoomSensitivity,
  onZoomSensitivityChange,
}: {
  zoomSensitivity: number
  onZoomSensitivityChange: (n: number) => void
}) {
  return (
    <Panel label="Settings">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <SliderRow
          label="ZOOM SENSITIVITY"
          value={zoomSensitivity}
          min={1.1}
          max={2.5}
          step={0.05}
          precision={2}
          suffix="×"
          onChange={onZoomSensitivityChange}
          hint="per mouse-wheel notch · 1.10 ≈ default LWC · 1.40 default · 2.50 aggressive"
        />
      </div>
    </Panel>
  )
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  precision,
  suffix,
  hint,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  precision: number
  suffix?: string
  hint?: string
  onChange: (n: number) => void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ flex: 1, color: theme.textInactive, fontSize: 10, letterSpacing: 0.5 }}>
          {label}
        </span>
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 11,
            color: theme.text,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value.toFixed(precision)}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          width: '100%',
          accentColor: theme.accent,
          cursor: 'pointer',
        }}
      />
      {hint && (
        <span
          style={{
            fontFamily: fonts.mono,
            fontSize: 9,
            color: theme.textInactive,
            lineHeight: 1.4,
          }}
        >
          {hint}
        </span>
      )}
    </div>
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
