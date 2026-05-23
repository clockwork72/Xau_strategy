import { useLayoutEffect } from 'react'
import { theme, fonts, sizes } from '../theme'
import type { Timeframe } from '../types'
import SegmentedToggle from './SegmentedToggle'
import { formatCrosshair } from '../util/time'

interface Props {
  timeframe: Timeframe
  onTimeframeChange: (tf: Timeframe) => void
  status: { kind: 'loading' | 'real' | 'mock' | 'error'; text: string }
  replayPlaying: boolean
  onReplayPlayPause: () => void
  onReplayStep: (delta: number) => void
  onReplayReset: () => void
  onReplayScrub: (idx: number) => void
  replayPlayhead: number
  replayMax: number
  replaySpeed: number
  onReplaySpeedChange: (v: number) => void
  replayNowSec?: number
}

const STATUS_DOT: Record<Props['status']['kind'], string> = {
  loading: theme.warn,
  real: theme.up,
  mock: theme.warn,
  error: theme.down,
}

const SPEED_OPTIONS = [
  { value: 1, label: '1×' },
  { value: 4, label: '4×' },
  { value: 10, label: '10×' },
  { value: 60, label: '60×' },
] as const

// Scrubber chrome can't be set via inline style (pseudo-elements). Inject once.
const SCRUBBER_STYLE_ID = 'xau-scrubber-styles'
const SCRUBBER_CSS = `
.xau-scrubber {
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  height: 16px;
  margin: 0;
  cursor: pointer;
}
.xau-scrubber:disabled { cursor: default; opacity: 0.4; }
.xau-scrubber:focus { outline: none; }
.xau-scrubber::-webkit-slider-runnable-track {
  height: 3px;
  background: ${theme.surface};
  border-radius: 2px;
}
.xau-scrubber::-moz-range-track {
  height: 3px;
  background: ${theme.surface};
  border-radius: 2px;
}
.xau-scrubber::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 12px;
  height: 12px;
  background: ${theme.text};
  border: 2px solid ${theme.panel};
  border-radius: 50%;
  margin-top: -4.5px;
  transition: transform 120ms ease, background 120ms ease;
}
.xau-scrubber::-moz-range-thumb {
  width: 12px;
  height: 12px;
  background: ${theme.text};
  border: 2px solid ${theme.panel};
  border-radius: 50%;
  cursor: pointer;
  transition: transform 120ms ease;
}
.xau-scrubber:hover:not(:disabled)::-webkit-slider-thumb { transform: scale(1.18); }
.xau-scrubber:hover:not(:disabled)::-moz-range-thumb { transform: scale(1.18); }
.xau-scrubber:active:not(:disabled)::-webkit-slider-thumb { transform: scale(1.3); background: ${theme.warn}; }
.xau-scrubber:active:not(:disabled)::-moz-range-thumb { transform: scale(1.3); background: ${theme.warn}; }
`

export default function TopBar(p: Props) {
  useLayoutEffect(() => {
    if (document.getElementById(SCRUBBER_STYLE_ID)) return
    const el = document.createElement('style')
    el.id = SCRUBBER_STYLE_ID
    el.textContent = SCRUBBER_CSS
    document.head.appendChild(el)
  }, [])

  const disabled = p.replayMax <= 0
  const safePlayhead = Math.min(p.replayPlayhead, Math.max(0, p.replayMax))

  // Split "YYYY-MM-DD HH:MM" → ["YYYY-MM-DD", "HH:MM"]
  const fullStamp = p.replayNowSec !== undefined ? formatCrosshair(p.replayNowSec) : null
  const [datePart, timePart] = fullStamp ? fullStamp.split(' ') : [null, null]
  const shortDate = datePart ? formatShortDate(datePart) : null

  return (
    <header
      style={{
        height: sizes.topbar,
        display: 'flex',
        alignItems: 'stretch',
        padding: '0 14px',
        background: theme.panel,
        borderBottom: `1px solid ${theme.border}`,
        gap: 14,
        fontFamily: fonts.sans,
        userSelect: 'none',
      }}
    >
      {/* brand */}
      <Group>
        <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.4 }}>XAU·SBX</span>
      </Group>

      {/* timeframe */}
      <Group>
        <SegmentedToggle<Timeframe>
          size="sm"
          options={[
            { value: '1m', label: '1m' },
            { value: '5m', label: '5m' },
          ]}
          value={p.timeframe}
          onChange={p.onTimeframeChange}
          ariaLabel="Timeframe"
        />
      </Group>

      <Divider />

      {/* transport — Play is the hero */}
      <Group gap={2}>
        <IconBtn
          ariaLabel="Reset to start (Home)"
          onClick={p.onReplayReset}
          disabled={disabled}
        >
          <SkipBackIcon />
        </IconBtn>
        <IconBtn
          ariaLabel="Step back (←)"
          onClick={() => p.onReplayStep(-1)}
          disabled={disabled}
        >
          <StepBackIcon />
        </IconBtn>
        <IconBtn
          ariaLabel={p.replayPlaying ? 'Pause (Space)' : 'Play (Space)'}
          onClick={p.onReplayPlayPause}
          disabled={disabled}
          variant="hero"
          active={p.replayPlaying}
        >
          {p.replayPlaying ? <PauseIcon /> : <PlayIcon />}
        </IconBtn>
        <IconBtn
          ariaLabel="Step forward (→)"
          onClick={() => p.onReplayStep(1)}
          disabled={disabled}
        >
          <StepForwardIcon />
        </IconBtn>
      </Group>

      {/* speed — sliding-indicator pill, mirrors timeframe */}
      <Group>
        <SegmentedToggle<number>
          size="sm"
          options={SPEED_OPTIONS as unknown as ReadonlyArray<{ value: number; label: string }>}
          value={p.replaySpeed}
          onChange={p.onReplaySpeedChange}
          ariaLabel="Replay speed"
        />
      </Group>

      <Divider />

      {/* scrubber takes remaining width */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flex: 1,
          minWidth: 0,
        }}
      >
        <input
          type="range"
          className="xau-scrubber"
          min={0}
          max={Math.max(0, p.replayMax)}
          step={1}
          value={safePlayhead}
          onChange={(e) => p.onReplayScrub(parseInt(e.target.value, 10))}
          disabled={disabled}
          style={{ flex: 1, minWidth: 0 }}
          aria-label="Replay playhead"
        />

        {/* timecode block — hero is the time, subtitle is index + date */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            justifyContent: 'center',
            lineHeight: 1.1,
            minWidth: 96,
            flexShrink: 0,
          }}
        >
          <span
            style={{
              fontSize: 13,
              fontFamily: fonts.mono,
              color: timePart ? theme.text : theme.textInactive,
              letterSpacing: 0.6,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {timePart ?? '— : —'}
          </span>
          <span
            style={{
              fontSize: 9,
              fontFamily: fonts.mono,
              color: theme.textInactive,
              letterSpacing: 0.6,
              marginTop: 2,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {safePlayhead}/{Math.max(0, p.replayMax)}
            {shortDate ? ` · ${shortDate}` : ''}
          </span>
        </div>
      </div>

      <Divider />

      {/* load status */}
      <Group>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 10,
            fontFamily: fonts.mono,
            letterSpacing: 0.5,
            color: theme.textMuted,
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: STATUS_DOT[p.status.kind],
            }}
          />
          {p.status.text}
        </div>
      </Group>
    </header>
  )
}

// --------------------------------------------------------------------
function Group({ children, gap = 8 }: { children: React.ReactNode; gap?: number }) {
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap,
        flexShrink: 0,
      }}
    >
      {children}
    </div>
  )
}

function Divider() {
  return (
    <span
      style={{
        width: 1,
        alignSelf: 'center',
        height: 22,
        background: theme.border,
        flexShrink: 0,
      }}
    />
  )
}

function IconBtn({
  children,
  onClick,
  disabled,
  ariaLabel,
  variant,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  disabled?: boolean
  ariaLabel: string
  variant?: 'hero'
  active?: boolean
}) {
  const isHero = variant === 'hero'
  const size = isHero ? 30 : 26
  const heroActive = isHero && active
  const bg = heroActive ? theme.text : isHero ? theme.surface : 'transparent'
  const fg = disabled
    ? theme.textInactive
    : heroActive
    ? theme.panel
    : isHero
    ? theme.text
    : theme.textMuted
  const border = heroActive
    ? theme.text
    : isHero
    ? theme.borderStrong
    : 'transparent'

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={ariaLabel}
      title={ariaLabel}
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        appearance: 'none',
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 6,
        color: fg,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'background 140ms ease, color 140ms ease, border-color 140ms ease',
        padding: 0,
      }}
      onMouseEnter={(e) => {
        if (disabled || heroActive) return
        if (!isHero) {
          e.currentTarget.style.color = theme.text
        } else {
          e.currentTarget.style.borderColor = theme.text
        }
      }}
      onMouseLeave={(e) => {
        if (disabled || heroActive) return
        if (!isHero) {
          e.currentTarget.style.color = theme.textMuted
        } else {
          e.currentTarget.style.borderColor = theme.borderStrong
        }
      }}
    >
      {children}
    </button>
  )
}

// --------------------------------------------------------------------
// Transport glyphs — filled monochrome SVGs, currentColor for theming.

function SkipBackIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="2" height="14" rx="0.5" />
      <path d="M20 5 10 12l10 7z" />
    </svg>
  )
}

function StepBackIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18 5 8 12l10 7z" />
    </svg>
  )
}

function StepForwardIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M6 5l10 7-10 7z" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M7 4.5v15l13-7.5z" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" />
      <rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  )
}

// --------------------------------------------------------------------
function formatShortDate(yyyymmdd: string): string {
  // "2026-05-21" → "21 May"
  const m = yyyymmdd.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return yyyymmdd
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const monthIdx = parseInt(m[2], 10) - 1
  return `${m[3]} ${months[monthIdx] ?? m[2]}`
}
