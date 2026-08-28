import { app } from 'electron';
import { ok, type Result } from '../shared/result.js';
import type { UiReply, UiRequest } from '../shared/channel.js';
import { cspModeFrom } from './csp.js';
import { createDispatch } from './dispatch.js';
import { registerIpc } from './ipc.js';
import { APP_ORIGIN, bundleRootFor, handleAppScheme, registerAppScheme } from './protocol.js';
import { createWindow } from './window.js';

const mode = cspModeFrom(process.env['NODE_ENV']);
const devUrl = process.env['ELECTRON_RENDERER_URL'];

/**
 * Множество принимаемых origin. В разработке рендерер грузится с dev-сервера, и жёсткая
 * сверка с единственной константой отклоняла бы там каждое сообщение.
 */
const allowedOrigins = new Set<string>([APP_ORIGIN]);
if (devUrl !== undefined) allowedOrigins.add(new URL(devUrl).origin);

// WHY: регистрация схемы обязана произойти ДО whenReady, а обработчик — после. Перепутанный
// порядок — самый частый способ сломать ровно эту связку.
registerAppScheme();

const dispatch = createDispatch();

/**
 * Одна точка на весь процесс. Обработчики, привешенные к конкретному окну, не покрыли бы
 * второе окно, которое придёт вместе с апрувами.
 */
app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (navigation) => navigation.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

/** Пока проигрывателя нет, обработчик подтверждает приём. Он появится следующей задачей. */
const run = (request: UiRequest): Result<UiReply> => {
  void request;
  return ok({ kind: 'accepted' });
};

app.whenReady().then(() => {
  handleAppScheme(bundleRootFor(app.getAppPath()), mode);
  registerIpc(run, allowedOrigins);

  const window = createWindow('main', devUrl ?? APP_ORIGIN);
  dispatch.register(window.webContents);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
