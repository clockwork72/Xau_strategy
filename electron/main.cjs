const { app, BrowserWindow, Menu, shell } = require('electron')
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

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0b0d10',
    title: 'XAU Research Sandbox',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())

  // Open external links in the OS browser instead of inside the app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // Tail tracked renderer messages into session.log
  mainWindow.webContents.on('console-message', (_e, _level, message) => {
    if (message.startsWith('[draw]') || message.startsWith('[replay]')) {
      appendLog(`[${new Date().toISOString()}] ${message}`)
    }
  })

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

// Hide the default menu bar.
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
