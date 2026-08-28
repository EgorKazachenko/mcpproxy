import { app } from 'electron';
import { createWindow } from './window.js';

/** Адрес dev-сервера. В следующей задаче рядом появится схема `app://` для собранной сборки. */
const DEV_URL = process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost:5173';

app.whenReady().then(() => {
  createWindow('main', DEV_URL);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
