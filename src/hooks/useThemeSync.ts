import { useCallback, useEffect, useState } from 'react'
import { palettes, type ThemeMode } from '../theme'

export interface ThemeState {
  themeMode: ThemeMode
  setThemeMode: React.Dispatch<React.SetStateAction<ThemeMode>>
  toggleTheme: () => void
  colors: (typeof palettes)[ThemeMode]
}

/**
 * Theme mode state + side-effects that don't touch chart instances:
 *   - <html data-theme="…"> attribute (drives CSS variables)
 *   - localStorage persistence under 'xau:theme'
 *   - Electron title-bar overlay color via window.electronAPI.setTheme
 *
 * Chart-side re-applyOptions calls live with the chart instances (different
 * lifecycle: tied to chart creation, not theme state). main.tsx reads the
 * localStorage value before React renders, so first paint is correct.
 */
export function useThemeSync(): ThemeState {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => {
    if (typeof window === 'undefined') return 'dark'
    return localStorage.getItem('xau:theme') === 'light' ? 'light' : 'dark'
  })

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode
    try {
      localStorage.setItem('xau:theme', themeMode)
    } catch {
      /* noop */
    }
    window.electronAPI?.setTheme(themeMode).catch(() => {
      /* not in electron */
    })
  }, [themeMode])

  const toggleTheme = useCallback(
    () => setThemeMode((m) => (m === 'dark' ? 'light' : 'dark')),
    [],
  )

  return { themeMode, setThemeMode, toggleTheme, colors: palettes[themeMode] }
}
