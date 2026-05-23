const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  setTheme: (mode) => ipcRenderer.invoke('set-theme', mode),
})
