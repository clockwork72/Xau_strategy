import { theme, fonts } from '../theme'
import type { DrawTool } from '../engine/drawing'

interface Props {
  activeTool: DrawTool
  onActiveToolChange: (t: DrawTool) => void
  snapEnabled: boolean
  onSnapEnabledChange: (v: boolean) => void
  lineCount: number
  onClearAll: () => void
}

export default function DrawToolbar({
  activeTool,
  onActiveToolChange,
  snapEnabled,
  onSnapEnabledChange,
  lineCount,
  onClearAll,
}: Props) {
  return (
    <div style={toolbarStyle} onMouseDown={(e) => e.stopPropagation()}>
      <ToolButton
        active={activeTool === 'cursor'}
        onClick={() => onActiveToolChange('cursor')}
        title="Cursor"
        hotkey="V"
        icon={
          <path
            d="M3 2 L3 13 L6 10 L8.5 15 L10 14.3 L7.5 9.5 L12 9 Z"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        }
      />
      <ToolButton
        active={activeTool === 'trendline'}
        onClick={() => onActiveToolChange('trendline')}
        title="Trendline"
        hotkey="T"
        icon={
          <g fill="none" stroke="currentColor" strokeWidth={1.5}>
            <line x1="2.5" y1="14.5" x2="15.5" y2="3.5" strokeLinecap="round" />
            <circle cx="2.5" cy="14.5" r="1.3" fill="currentColor" />
            <circle cx="15.5" cy="3.5" r="1.3" fill="currentColor" />
          </g>
        }
      />
      <ToolButton
        active={activeTool === 'horizontal'}
        onClick={() => onActiveToolChange('horizontal')}
        title="Horizontal"
        hotkey="H"
        icon={
          <line
            x1="2"
            y1="9"
            x2="16"
            y2="9"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        }
      />

      <div style={separatorStyle} />

      <ToolButton
        active={snapEnabled}
        onClick={() => onSnapEnabledChange(!snapEnabled)}
        title={snapEnabled ? 'Snap on' : 'Snap off'}
        hotkey="S"
        toggleColor={theme.accent}
        icon={
          <g fill="none" stroke="currentColor" strokeWidth={1.5}>
            <path d="M5 3 L5 9 A4 4 0 0 0 13 9 L13 3" strokeLinecap="round" />
            <line x1="3" y1="3" x2="6" y2="3" strokeLinecap="round" />
            <line x1="12" y1="3" x2="15" y2="3" strokeLinecap="round" />
          </g>
        }
      />

      <div style={separatorStyle} />

      <ToolButton
        active={false}
        onClick={onClearAll}
        title={lineCount > 0 ? `Clear all (${lineCount})` : 'Clear all'}
        disabled={lineCount === 0}
        icon={
          <g fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 5 L15 5 M6 5 L6 3 L12 3 L12 5 M5 5 L6 15 L12 15 L13 5" />
          </g>
        }
      />
    </div>
  )
}

function ToolButton({
  active,
  onClick,
  icon,
  title,
  hotkey,
  toggleColor,
  disabled,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  title: string
  hotkey?: string
  toggleColor?: string
  disabled?: boolean
}) {
  const activeColor = toggleColor ?? theme.warn
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={hotkey ? `${title} (${hotkey})` : title}
      style={{
        ...buttonStyle,
        color: disabled ? theme.textInactive : active ? activeColor : theme.textMuted,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
      onMouseEnter={(e) => {
        if (disabled) return
        e.currentTarget.style.background = active ? 'rgba(255,255,255,0.04)' : 'rgba(255,255,255,0.03)'
        e.currentTarget.style.color = active ? activeColor : theme.text
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = disabled ? theme.textInactive : active ? activeColor : theme.textMuted
      }}
    >
      {active && !disabled && <span style={activeBarStyle(activeColor)} />}
      <svg width={16} height={16} viewBox="0 0 18 18">{icon}</svg>
    </button>
  )
}

const toolbarStyle: React.CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 10,
  width: 32,
  background: 'rgba(17, 20, 26, 0.92)',
  backdropFilter: 'blur(6px)',
  WebkitBackdropFilter: 'blur(6px)',
  border: `1px solid ${theme.border}`,
  borderRadius: 5,
  padding: '4px 0',
  display: 'flex',
  flexDirection: 'column',
  zIndex: 5,
  boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
  fontFamily: fonts.sans,
}

const buttonStyle: React.CSSProperties = {
  appearance: 'none',
  background: 'transparent',
  border: 'none',
  width: 32,
  height: 28,
  padding: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  position: 'relative',
  transition: 'color 100ms, background 100ms',
}

const separatorStyle: React.CSSProperties = {
  height: 1,
  margin: '4px 6px',
  background: theme.border,
}

const activeBarStyle = (color: string): React.CSSProperties => ({
  position: 'absolute',
  left: 0,
  top: 5,
  bottom: 5,
  width: 2,
  background: color,
  borderRadius: 1,
})
