export {}

declare global {
  interface Window {
    electronAPI?: {
      setTheme: (mode: 'dark' | 'light') => Promise<void>
    }
  }
}
