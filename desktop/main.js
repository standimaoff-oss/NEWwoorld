const { app, BrowserWindow } = require('electron');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 800, minHeight: 480,
    backgroundColor: '#101614', autoHideMenuBar: true,
    title: '京华里 · Новый Китай',
    webPreferences: { nodeIntegration: false, contextIsolation: true, webgl: true },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'app', 'index.html'), { query: { quality: 'high' } });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
