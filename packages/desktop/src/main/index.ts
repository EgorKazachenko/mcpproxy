import { app } from 'electron';
import { cspModeFrom } from './csp.js';
import { APP_ORIGIN, bundleRootFor, handleAppScheme, registerAppScheme } from './protocol.js';
import { createWindow } from './window.js';

const mode = cspModeFrom(process.env['NODE_ENV']);
const devUrl = process.env['ELECTRON_RENDERER_URL'];

// WHY: регистрация схемы обязана произойти ДО whenReady, а обработчик — после. Перепутанный
// порядок — самый частый способ сломать ровно эту связку.
registerAppScheme();

/**
 * Одна точка на весь процесс. Обработчики, привешенные к конкретному окну, не покрыли бы
 * второе окно, которое придёт вместе с апрувами.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (navigation) => navigation.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(() => {
  handleAppScheme(bundleRootFor(app.getAppPath()), mode);
  createWindow('main', devUrl ?? APP_ORIGIN);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
