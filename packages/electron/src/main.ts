import { app, BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const createWindow = () => {
  const win = new BrowserWindow({
    width: 800,
    height: 600
  })

  const devServerUrl = process.env.VITE_DEV_SERVER_URL

  if (devServerUrl) {
    void win.loadURL(devServerUrl)
  } else {
    const rendererHtml = join(dirname(fileURLToPath(import.meta.url)), 'renderer', 'index.html')
    void win.loadFile(rendererHtml)
  }
}

app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
