// Theme tokens. DOM styling uses these CSS-variable refs — they auto-update
// when `document.documentElement.dataset.theme` flips between 'dark' and
// 'light' (see index.css for the palette definitions).
//
// Chart code that calls lightweight-charts APIs must NOT use these vars
// (the chart library does not resolve CSS vars). Use `palettes[mode]` for
// explicit hex strings — the parent owns themeMode state and re-applies
// chart options on switch.
export const theme = {
  bg: 'var(--theme-bg)',
  panel: 'var(--theme-panel)',
  surface: 'var(--theme-surface)',
  border: 'var(--theme-border)',
  borderStrong: 'var(--theme-border-strong)',
  text: 'var(--theme-text)',
  textMuted: 'var(--theme-text-muted)',
  textInactive: 'var(--theme-text-inactive)',
  accent: 'var(--theme-accent)',
  accentDim: 'var(--theme-accent-dim)',
  up: 'var(--theme-up)',
  down: 'var(--theme-down)',
  warn: 'var(--theme-warn)',
  longBg: 'var(--theme-long-bg)',
  shortBg: 'var(--theme-short-bg)',
}

export type ThemeMode = 'dark' | 'light'

export const palettes: Record<ThemeMode, Record<keyof typeof theme, string>> = {
  dark: {
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
  },
  light: {
    bg: '#f5f6f8',
    panel: '#ffffff',
    surface: '#eef0f3',
    border: '#e2e5ea',
    borderStrong: '#cdd2dc',
    text: '#0e1117',
    textMuted: '#5a626f',
    textInactive: '#9099a8',
    accent: '#2563eb',
    accentDim: '#bfd0ff',
    up: '#26a69a',
    down: '#ef5350',
    warn: '#b8860b',
    longBg: 'rgba(38, 166, 154, 0.08)',
    shortBg: 'rgba(239, 83, 80, 0.08)',
  },
}

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

// Width reserved for the Windows 11 title-bar overlay buttons (min/max/close)
// on the right of the TopBar. Used as right-padding so content doesn't slide
// under the OS-drawn controls.
export const TITLE_BAR_CONTROLS_WIDTH = 140
