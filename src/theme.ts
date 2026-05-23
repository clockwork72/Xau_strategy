// Single source of truth for visual tokens. Keep narrow — do not invent new hues.
export const theme = {
  bg: '#0b0d10',
  panel: '#11141a',
  surface: '#181c24',
  border: '#1f242d',
  borderStrong: '#2a3140',
  text: '#d6d8de',
  textMuted: '#7a8290',
  textInactive: '#545b66',
  accent: '#4f8bff',
  accentDim: '#1f3a6e',
  up: '#26a69a',
  down: '#ef5350',
  warn: '#f5c518',
  longBg: 'rgba(38, 166, 154, 0.10)',
  shortBg: 'rgba(239, 83, 80, 0.10)',
} as const

export const fonts = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  mono: '"JetBrains Mono", "Roboto Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const

export const sizes = {
  topbar: 44,
  statusbar: 22,
  leftNav: 190,
  rightPanels: 280,
} as const
