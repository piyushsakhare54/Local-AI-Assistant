const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  saveSummaryPdf: (html, fileName) => ipcRenderer.invoke('save-summary-pdf', html, fileName),
});
