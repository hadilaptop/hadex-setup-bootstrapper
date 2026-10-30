const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');

app.setName('Hadex Setup');
app.setPath('userData', path.join(app.getPath('appData'), 'HadexSetup'));

const WINDOW = { width: 560, height: 460 };
const BROWSER_PARTITION = 'persist:hadex-private-browser';

let installerWindow;
let chromiumWindow;
let browserSession;

function routeNewWindow(contents, parentWindow) {
  contents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith('https://accounts.google.com/') ||
      url.startsWith('https://myaccount.google.com/')
    ) {
      // Open Google authentication in a separate Electron window using
      // the exact same persistent Hadex browser session/cookies.
      const authWindow = new BrowserWindow({
        width: 520,
        height: 700,
        minWidth: 420,
        minHeight: 560,
        title: 'ورود به حساب Google — Hadex',
        autoHideMenuBar: true,
        parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
        webPreferences: {
          session: browserSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      });
      routeNewWindow(authWindow.webContents, authWindow);
      authWindow.loadURL(url).catch(error => {
        console.error('[Hadex] Google sign-in popup failed:', error);
      });
    } else if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
}

function createWindows() {
  const sharedBounds = { ...WINDOW, x: 160, y: 120 };

  chromiumWindow = new BrowserWindow({
    ...sharedBounds,
    minWidth: WINDOW.width,
    maxWidth: WINDOW.width,
    minHeight: WINDOW.height,
    maxHeight: WINDOW.height,
    show: true,
    title: 'Hadex Chromium',
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      webviewTag: true,
      preload: path.join(__dirname, 'browser-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  routeNewWindow(chromiumWindow.webContents, chromiumWindow);
  chromiumWindow.webContents.on('did-attach-webview', (_event, guestContents) => {
    routeNewWindow(guestContents, chromiumWindow);
  });
  chromiumWindow.loadFile(path.join(__dirname, 'browser.html'));

  installerWindow = new BrowserWindow({
    ...sharedBounds,
    minWidth: WINDOW.width,
    maxWidth: WINDOW.width,
    minHeight: WINDOW.height,
    maxHeight: WINDOW.height,
    show: true,
    title: 'Hadex Setup',
    backgroundColor: '#10141d',
    autoHideMenuBar: true,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  installerWindow.loadFile(path.join(__dirname, 'installer.html'));

  installerWindow.on('closed', () => {
    installerWindow = null;
    if (chromiumWindow && !chromiumWindow.isDestroyed()) chromiumWindow.close();
  });
  chromiumWindow.on('closed', () => {
    chromiumWindow = null;
    if (installerWindow && !installerWindow.isDestroyed()) installerWindow.close();
  });

  installerWindow.show();
  installerWindow.focus();
}

ipcMain.handle('show-installer', () => {
  if (!installerWindow || installerWindow.isDestroyed()) return false;
  installerWindow.show();
  installerWindow.focus();
  return true;
});

ipcMain.handle('toggle-view', () => {
  if (!installerWindow || !chromiumWindow) return false;
  if (installerWindow.isFocused()) {
    chromiumWindow.show();
    chromiumWindow.focus();
  } else {
    installerWindow.show();
    installerWindow.focus();
  }
  return true;
});

ipcMain.handle('start-install', async () => {
  if (!chromiumWindow || chromiumWindow.isDestroyed()) {
    return { ok: false, message: 'پنجره Chromium اختصاصی Hadex در دسترس نیست.' };
  }
  chromiumWindow.show();
  chromiumWindow.focus();
  return { ok: true, message: 'مرورگر اختصاصی Hadex آماده است.' };
});

app.whenReady().then(() => {
  browserSession = session.fromPartition(BROWSER_PARTITION);
  createWindows();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindows();
});
app.on('window-all-closed', () => app.quit());
