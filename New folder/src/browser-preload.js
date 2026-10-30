const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('hadexBrowser', {
  showInstaller: () => ipcRenderer.invoke('show-installer')
});
