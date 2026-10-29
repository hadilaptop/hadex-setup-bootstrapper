const { app, BrowserWindow, shell, session } = require('electron');
const path = require('node:path');

// Keep the DevTools Protocol endpoint restricted to this computer.
app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
app.commandLine.appendSwitch('remote-debugging-port', '9223');

let browserSession;

function routeNewWindow(contents, parentWindow) {
  contents.setWindowOpenHandler(({ url }) => {
    // Keep Google authentication inside Hadex so it can reuse the same cookies.
    if (
      url.startsWith('https://accounts.google.com/') ||
      url.startsWith('https://myaccount.google.com/')
    ) {
      const authWindow = new BrowserWindow({
        width: 520,
        height: 720,
        minWidth: 420,
        minHeight: 560,
        title: 'Google Sign-In — Hadex Chromium',
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
      authWindow.loadURL(url).catch(() => {});
    } else if (url.startsWith('https://') || url.startsWith('http://')) {
      // Preserve the existing behavior for ordinary external links.
      shell.openExternal(url);
    }

    return { action: 'deny' };
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title: 'Hadex Chromium',
    backgroundColor: '#f4f6f8',
    autoHideMenuBar: true,
    webPreferences: {
      session: browserSession,
      webviewTag: true,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  // Handle OAuth popups from the main page (including the OpenAI login page).
  routeNewWindow(win.webContents, win);

  // A webview is a separate WebContents; give its popups the same session too.
  win.webContents.on('did-attach-webview', (_event, guestContents) => {
    routeNewWindow(guestContents, win);
  });

  win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(() => {
  // Electron only allows retrieving a Session after app is ready.
  browserSession = session.fromPartition('persist:hadex-browser');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});