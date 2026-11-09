// Ponte mínima para a tela de configuração. O player web não usa nada daqui.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sbPlayer', {
  current: () => ipcRenderer.invoke('setup:current'),
  save: (server) => ipcRenderer.invoke('setup:save', server),
  cancel: () => ipcRenderer.invoke('setup:cancel')
});
