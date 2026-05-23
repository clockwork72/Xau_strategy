import { useLayoutEffect, useRef, useState } from 'react'
import { theme, fonts } from '../theme'

interface Option<T extends string | number> {
  value: T
  label: string
}

interface Props<T extends string | number> {
  options: ReadonlyArray<Option<T>>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
  size?: 'sm' | 'md'
}

export default function SegmentedToggle<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
}: Props<T>) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [indicator, setIndicator] = useState({ left: 0, width: 0 })

  useLayoutEffect(() => {
    const c = containerRef.current
    if (!c) return
    const active = c.querySelector<HTMLButtonElement>(`button[data-value="${value}"]`)
    if (!active) return
    const cRect = c.getBoundingClientRect()
    const aRect = active.getBoundingClientRect()
    setIndicator({ left: aRect.left - cRect.left, width: aRect.width })
  }, [value, options])

  const padY = size === 'sm' ? 4 : 6
  const padX = size === 'sm' ? 10 : 14
  const fontSize = size === 'sm' ? 11 : 12

  return (
    <div
      ref={containerRef}
      role="tablist"
      aria-label={ariaLabel}
      style={{
        position: 'relative',
        display: 'inline-flex',
        background: '#0e1117',
        border: `1px solid ${theme.border}`,
        borderRadius: 8,
        padding: 2,
        fontFamily: fonts.sans,
      }}
    >
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          left: indicator.left,
          width: indicator.width,
          height: `calc(100% - 4px)`,
          background: theme.accent,
          borderRadius: 6,
          transition: 'left 180ms cubic-bezier(0.4, 0, 0.2, 1), width 180ms cubic-bezier(0.4, 0, 0.2, 1)',
          pointerEvents: 'none',
        }}
      />
      {options.map((o) => (
        <button
          key={o.value}
          data-value={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          style={{
            position: 'relative',
            zIndex: 1,
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            color: value === o.value ? '#fff' : theme.textMuted,
            padding: `${padY}px ${padX}px`,
            fontSize,
            fontWeight: 500,
            cursor: 'pointer',
            transition: 'color 180ms',
            fontFamily: 'inherit',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
