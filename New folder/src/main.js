const { app, BrowserWindow, ipcMain, shell, session } = require('electron');
const path = require('node:path');

app.setName('Hadex Setup');
app.setPath('userData', path.join(app.getPath('appData'), 'HadexSetup'));

const WINDOW = { width: 560, height: 460 };
const BROWSER_PARTITION = 'persist:hadex-private-browser';

// Auto-fit: loaded pages are zoomed (shrunk) to fit inside the window
// instead of scrolling. The window itself never grows.
// 0.25 is the minimum zoom factor Chromium allows.
const FIT_MIN_ZOOM = 0.25;

let installerWindow;
let chromiumWindow;
let browserSession;

const GUEST_METRICS_JS = `(async () => {
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const de = document.documentElement, b = document.body;
  return {
    w: Math.max(de.scrollWidth, b ? b.scrollWidth : 0),
    h: Math.max(de.scrollHeight, b ? b.scrollHeight : 0)
  };
})()`;

// Zooms the page inside `win` so its full content fits the window (no scroll).
function attachAutoFit(win) {
  let resizeTimer = null;
  const apply = () => {
    if (win.isDestroyed()) return;
    const contents = win.webContents;
    contents.setZoomFactor(1); // measure at natural size first, then shrink
    contents.executeJavaScript(GUEST_METRICS_JS, true).then(metrics => {
      if (win.isDestroyed() || !metrics) return;
      const size = win.getContentSize();
      let factor = 1;
      if (metrics.w > 0) factor = Math.min(factor, size.width / metrics.w);
      if (metrics.h > 0) factor = Math.min(factor, size.height / metrics.h);
      factor = Math.min(1, Math.max(FIT_MIN_ZOOM, factor));
      contents.setZoomFactor(factor);
    }).catch(() => {});
  };
  const schedule = () => [0, 300, 800].forEach(delay =>
    setTimeout(() => { if (!win.isDestroyed()) apply(); }, delay));
  win.webContents.on('dom-ready', schedule);
  win.webContents.on('did-navigate', schedule);
  win.webContents.on('did-navigate-in-page', schedule);
  win.on('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(schedule, 150);
  });
}

function routeNewWindow(contents, parentWindow) {
  contents.setWindowOpenHandler(({ url }) => {
    if (
      url.startsWith('https://accounts.google.com/') ||
      url.startsWith('https://myaccount.google.com/')
    ) {
      // Open Google authentication in a separate Electron window using
      // the exact same persistent Hadex browser session/cookies.
      // Same compact size as the other Hadex windows; the page shrinks
      // to fit inside instead of the window growing.
      const authWindow = new BrowserWindow({
        ...WINDOW,
        title: 'ورود به حساب Google — Hadex',
        autoHideMenuBar: true,
        center: true,
        resizable: false,
        parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
        webPreferences: {
          session: browserSession,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      });
      attachAutoFit(authWindow);
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
