const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');

app.setName('Hadex Setup');
app.setPath('userData', path.join(app.getPath('appData'), 'HadexSetup'));

const WINDOW = { width: 600, height: 650 };
const GOOGLE_SIGNIN_URL =
  'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fwww.google.com%2F&hl=en&flowName=WebLiteSignIn&flowEntry=ServiceLogin';

let installerWindow;

function findChromeExecutable() {
  const candidates = [
    path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe')
  ];

  return candidates.find(candidate => candidate && fs.existsSync(candidate));
}

function openGoogleChrome() {
  const chromePath = findChromeExecutable();
  if (!chromePath) {
    return {
      ok: false,
      message: 'Google Chrome در مسیرهای استاندارد ویندوز پیدا نشد.'
    };
  }

  const profilePath = path.join(app.getPath('userData'), 'ChromeProfile');
  fs.mkdirSync(profilePath, { recursive: true });

  return new Promise(resolve => {
    const chrome = spawn(chromePath, [
      '--new-window',
      `--user-data-dir=${profilePath}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--window-size=${WINDOW.width},${WINDOW.height}`,
      GOOGLE_SIGNIN_URL
    ], {
      detached: true,
      stdio: 'ignore'
    });

    chrome.once('error', error => {
      resolve({
        ok: false,
        message: `اجرای Google Chrome ناموفق بود: ${error.message}`
      });
    });

    chrome.once('spawn', () => {
      chrome.unref();
      moveInstallerBehindChrome();

      resolve({
        ok: true,
        message: 'Google Chrome اجرا شد؛ پنجره نصب باز می‌ماند.'
      });
    });
  });
}

function moveInstallerBehindChrome() {
  if (!installerWindow || installerWindow.isDestroyed()) return;

  const handleBuffer = installerWindow.getNativeWindowHandle();
  const installerHandle = handleBuffer.length >= 8
    ? handleBuffer.readBigUInt64LE(0).toString()
    : String(handleBuffer.readUInt32LE(0));

  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class WindowOrder {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
$installer = [IntPtr]::new([Int64]${installerHandle})
$chromeWindow = [IntPtr]::Zero
for ($i = 0; $i -lt 60; $i++) {
  $chromeWindow = (Get-Process chrome -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Sort-Object StartTime -Descending |
    Select-Object -First 1).MainWindowHandle
  if ($chromeWindow -ne [IntPtr]::Zero) { break }
  Start-Sleep -Milliseconds 100
}
if ($chromeWindow -ne [IntPtr]::Zero) {
  [WindowOrder]::SetWindowPos($installer, [IntPtr]::new(1), 0, 0, 0, 0, 0x0013) | Out-Null
  [WindowOrder]::SetForegroundWindow([IntPtr]$chromeWindow) | Out-Null
}
`;

  const orderProcess = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    script
  ], { detached: true, stdio: 'ignore' });
  orderProcess.unref();
}

function createInstallerWindow() {
  installerWindow = new BrowserWindow({
    ...WINDOW,
    minWidth: WINDOW.width,
    maxWidth: WINDOW.width,
    minHeight: WINDOW.height,
    maxHeight: WINDOW.height,
    center: true,
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
  });
}

ipcMain.handle('show-installer', () => {
  if (!installerWindow || installerWindow.isDestroyed()) return false;
  installerWindow.show();
  installerWindow.focus();
  return true;
});

ipcMain.handle('toggle-view', () => openGoogleChrome());

ipcMain.handle('start-install', () => openGoogleChrome());

app.whenReady().then(createInstallerWindow);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createInstallerWindow();
});

app.on('window-all-closed', () => app.quit());