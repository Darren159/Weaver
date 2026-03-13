import { app, BrowserWindow, ipcMain, screen, shell, Tray } from 'electron';
import * as path from 'path';
import { createTray } from './tray';

const PANEL_WIDTH = 440;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

function createWindow(): BrowserWindow {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  const w = new BrowserWindow({
    width: PANEL_WIDTH,
    height,
    x: width - PANEL_WIDTH,
    y: 0,
    frame: false,
    transparent: false,
    resizable: true,
    minimizable: true,
    skipTaskbar: false,
    alwaysOnTop: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Prevent closing — hide instead. Real quit via tray menu.
  w.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      w.hide();
    }
  });

  // Open external links in the system browser
  w.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    w.loadURL('http://localhost:5174');
  } else {
    w.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return w;
}

app.whenReady().then(() => {
  // Hide from dock on macOS — tray only
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  win = createWindow();
  // Keep a strong reference or Electron can GC the tray on Windows.
  tray = createTray(win, () => { quitting = true; app.quit(); });

  // Show the panel on first launch
  win.once('ready-to-show', () => win?.show());
});

app.on('before-quit', () => { quitting = true; });

// Keep the app running even when all windows are closed (tray app)
app.on('window-all-closed', (e: Event) => {
  if (process.platform !== 'darwin') { e.preventDefault(); }
});

// ── IPC handlers ─────────────────────────────────────────────────────────────

ipcMain.on('hide-window', () => win?.hide());
ipcMain.on('minimize-window', () => win?.minimize());

ipcMain.handle('get-config', () => ({
  bridgePort: Number(process.env.WEAVER_BRIDGE_PORT ?? 8765),
  backendUrl: process.env.WEAVER_BACKEND_URL ?? 'http://localhost:8000',
}));
