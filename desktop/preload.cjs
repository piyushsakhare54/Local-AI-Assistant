const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  saveSummaryPdf: (html, fileName) => ipcRenderer.invoke('save-summary-pdf', html, fileName),
  listScreenSources: () => ipcRenderer.invoke('list-screen-sources'),
  captureScreen: (sourceId) => ipcRenderer.invoke('capture-screen', sourceId),
});
