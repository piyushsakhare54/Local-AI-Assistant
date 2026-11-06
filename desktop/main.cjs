const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  session,
  shell,
} = require('electron');
const { writeFile } = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

function isTrustedAppUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin === 'http://127.0.0.1:5173') return true;
    return url.protocol === 'file:'
      && path.resolve(fileURLToPath(url)) === path.resolve(__dirname, 'dist', 'index.html');
  } catch {
    return false;
  }
}

ipcMain.handle('save-summary-pdf', async (event, html, fileName) => {
  if (!isTrustedAppUrl(event.senderFrame.url)) {
    throw new Error('PDF export is only available from the local desktop app.');
  }
  if (typeof html !== 'string' || html.length === 0 || html.length > 5_000_000) {
    throw new Error('The PDF document is empty or too large to export.');
  }
  if (typeof fileName !== 'string') {
    throw new Error('A valid PDF filename is required.');
  }

  const safeFileName = `${path.basename(fileName, '.pdf').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 100) || 'conversation-summary'}.pdf`;
  const parent = BrowserWindow.fromWebContents(event.sender);
  const saveOptions = {
    title: 'Save conversation summary',
    defaultPath: path.join(app.getPath('documents'), safeFileName),
    filters: [{ name: 'PDF document', extensions: ['pdf'] }],
  };
  const { canceled, filePath } = parent
    ? await dialog.showSaveDialog(parent, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (canceled || !filePath) return { saved: false };

  const pdfWindow = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  try {
    await pdfWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const pdf = await pdfWindow.webContents.printToPDF({
      displayHeaderFooter: true,
      footerTemplate: '<div style="width:100%;margin:0 18mm;color:#667366;font:8px Arial;text-align:right"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      headerTemplate: '<div></div>',
      pageSize: 'A4',
      printBackground: true,
    });
    await writeFile(filePath, pdf);
    return { saved: true, filePath };
  } finally {
    pdfWindow.close();
  }
});

ipcMain.handle('list-screen-sources', async (event) => {
  if (!isTrustedAppUrl(event.senderFrame.url)) {
    throw new Error('Screen capture is only available from the local desktop app.');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 },
  });
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: `data:image/jpeg;base64,${source.thumbnail.toJPEG(65).toString('base64')}`,
  }));
});

ipcMain.handle('capture-screen', async (event, sourceId) => {
  if (!isTrustedAppUrl(event.senderFrame.url)) {
    throw new Error('Screen capture is only available from the local desktop app.');
  }
  if (typeof sourceId !== 'string' || sourceId.length > 200) {
    throw new Error('Select a valid screen before capturing.');
  }
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1600, height: 900 },
  });
  const source = sources.find((candidate) => candidate.id === sourceId);
  if (!source) throw new Error('The selected screen is no longer available.');
  return { imageBase64: source.thumbnail.toJPEG(75).toString('base64') };
});

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    backgroundColor: '#101311',
    title: 'Local AI Conversation Assistant',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://ollama.com/download/windows') void shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.VITE_DEV_SERVER_URL) window.loadURL(process.env.VITE_DEV_SERVER_URL);
  else window.loadFile(path.join(__dirname, 'dist', 'index.html'));
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = new URL(webContents.getURL());
    const localOrigin = url.protocol === 'file:' || url.origin === 'http://127.0.0.1:5173';
    callback(permission === 'media' && localOrigin);
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
