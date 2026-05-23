import { useEffect, useState } from 'react'
import { theme, fonts, sizes } from '../theme'
import type { Candle } from '../types'
import { DISPLAY_TZ_LABEL, formatClock } from '../util/time'

interface Props {
  symbol: string
  totalBars: number
  hovered: Candle | null
}

export default function StatusBar({ symbol, totalBars, hovered }: Props) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  return (
    <footer
      style={{
        height: sizes.statusbar,
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '0 14px',
        background: theme.panel,
        borderTop: `1px solid ${theme.border}`,
        fontFamily: fonts.mono,
        fontSize: 10,
        color: theme.textMuted,
        letterSpacing: 0.3,
        userSelect: 'none',
      }}
    >
      <Item label={DISPLAY_TZ_LABEL} value={formatClock(now)} />
      <Sep />
      <Item label="SYMBOL" value={symbol} />
      <Sep />
      <Item label="BARS" value={totalBars.toLocaleString()} />
      <Sep />
      <Item
        label="HOVER"
        value={
          hovered === null
            ? '—'
            : `${hovered.close.toFixed(3)}  Δ ${(hovered.close - hovered.open).toFixed(3)}`
        }
      />
      <div style={{ flex: 1 }} />
    </footer>
  )
}

function Item({
  label,
  value,
  valueColor,
}: {
  label: string
  value: string
  valueColor?: string
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6 }}>
      <span style={{ color: theme.textInactive }}>{label}</span>
      <span style={{ color: valueColor ?? theme.text, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </span>
  )
}

function Sep() {
  return <span style={{ color: theme.border }}>·</span>
}
