const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('hadex', {
  toggleView: () => ipcRenderer.invoke('toggle-view'),
  startInstall: () => ipcRenderer.invoke('start-install')
});
