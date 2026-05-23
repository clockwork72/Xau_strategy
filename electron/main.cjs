const { app, BrowserWindow, Menu, ipcMain, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'
const DEV_URL = process.env.VITE_DEV_URL || 'http://localhost:5173'

// Bridge for the agent: capture renderer console.log lines prefixed with
// [draw] or [replay] into a fresh file on every session start.
const LOG_PATH = path.join(__dirname, '..', 'session.log')
function clearLog() {
  try { fs.writeFileSync(LOG_PATH, '') } catch (_) { /* ignore */ }
}
function appendLog(line) {
  try { fs.appendFileSync(LOG_PATH, line + '\n') } catch (_) { /* ignore */ }
}

// ---- titleBarOverlay palette (must mirror src/theme.ts palettes) ----
const OVERLAY_COLORS = {
  dark:  { color: '#11141a', symbolColor: '#d6d8de' },
  light: { color: '#ffffff', symbolColor: '#0e1117' },
}
const TITLE_BAR_HEIGHT = 44

// ---- window state persistence (bounds + last theme) ----
const STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')
const DEFAULT_BOUNDS = { width: 1500, height: 950 }

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf-8')
    const s = JSON.parse(raw)
    return {
      bounds: typeof s.bounds === 'object' && s.bounds ? s.bounds : DEFAULT_BOUNDS,
      maximized: !!s.maximized,
      theme: s.theme === 'light' ? 'light' : 'dark',
    }
  } catch {
    return { bounds: DEFAULT_BOUNDS, maximized: false, theme: 'dark' }
  }
}
function saveState(state) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2)) } catch (_) { /* ignore */ }
}

let mainWindow = null
let cachedState = null

function createWindow() {
  cachedState = loadState()
  const b = cachedState.bounds

  mainWindow = new BrowserWindow({
    x: typeof b.x === 'number' ? b.x : undefined,
    y: typeof b.y === 'number' ? b.y : undefined,
    width: b.width || DEFAULT_BOUNDS.width,
    height: b.height || DEFAULT_BOUNDS.height,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: cachedState.theme === 'light' ? '#f5f6f8' : '#0b0d10',
    title: 'XAU Research Sandbox',
    autoHideMenuBar: true,
    show: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...OVERLAY_COLORS[cachedState.theme],
      height: TITLE_BAR_HEIGHT,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  if (cachedState.maximized) mainWindow.maximize()
  mainWindow.once('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (
      message.startsWith('[draw]') ||
      message.startsWith('[replay]') ||
      message.startsWith('[channels]')
    ) {
      appendLog(`[${new Date().toISOString()}] ${message}`)
    }
  })

  // ---- persist bounds on change (debounced via 'close' is enough) ----
  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const maximized = mainWindow.isMaximized()
    cachedState.maximized = maximized
    if (!maximized) cachedState.bounds = mainWindow.getBounds()
    saveState(cachedState)
  }
  mainWindow.on('resize', persistBounds)
  mainWindow.on('move', persistBounds)
  mainWindow.on('maximize', persistBounds)
  mainWindow.on('unmaximize', persistBounds)
  mainWindow.on('close', persistBounds)

  if (isDev) {
    mainWindow.loadURL(DEV_URL)
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---- IPC: renderer asks main to recolor the title bar overlay ----
ipcMain.handle('set-theme', (_e, mode) => {
  const theme = mode === 'light' ? 'light' : 'dark'
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    mainWindow.setTitleBarOverlay({
      ...OVERLAY_COLORS[theme],
      height: TITLE_BAR_HEIGHT,
    })
  } catch (_) { /* older Electron — ignore */ }
  if (cachedState) {
    cachedState.theme = theme
    saveState(cachedState)
  }
})

Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  clearLog()
  appendLog(`=== session start ${new Date().toISOString()} ===`)
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
