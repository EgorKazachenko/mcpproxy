import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, dialog } from 'electron';
import { denied, ok, type Result } from '../shared/result.js';
import type { UiReply, UiRequest } from '../shared/channel.js';
import type { TrackMarks } from './player.js';
import { createPlayer, type Player } from './player.js';
import { readTrace } from './trace.js';
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

let player: Player | null = null;

/**
 * Обработчик запросов рендерера.
 *
 * `hello` отвечает состоянием и повторяет уже отданные события: рендерер подписывается
 * позже, чем main начинает работу, и без повтора первая отрисовка показала бы пустой список
 * при непустом трейсе.
 */
const run = (request: UiRequest): Result<UiReply> => {
  if (player === null) return denied('bad-payload', 'проигрыватель ещё не готов');

  if (request.kind === 'hello') {
    player.replay();
    return ok({ kind: 'state', state: player.state() });
  }

  player.apply(request.command);
  return ok({ kind: 'accepted' });
};

async function loadPlayer(): Promise<void> {
  const fixtures = join(app.getAppPath(), 'fixtures');
  const trace = readTrace(await readFile(join(fixtures, 'demo.jsonl'), 'utf8'));
  if (!trace.ok) throw new Error(`демо-трейс не читается: ${trace.error.message}`);

  const marks = JSON.parse(await readFile(join(fixtures, 'marks.json'), 'utf8')) as TrackMarks;
  player = createPlayer(trace.value, marks, (event) => dispatch.send(event));
}

/**
 * Отказ старта обязан быть слышен.
 *
 * Без `catch` любой из двух входов — нечитаемый `demo.jsonl` или битый `marks.json`, который
 * `JSON.parse` роняет без обёртки, — давал непойманный reject: окно не создавалось НИКОГДА,
 * а на macOS процесс при этом оставался жив. Снаружи это неотличимо от зависшего приложения,
 * и смоук падал по таймауту ожидания окна, а не с причиной. `readTrace` специально возвращает
 * конверт, «чтобы не упасть», — и терять его тут же было бы прямым отрицанием этого решения.
 *
 * Код выхода ненулевой: тихая смерть с нулём читается запускающим как штатное завершение.
 */
app
  .whenReady()
  .then(async () => {
    handleAppScheme(bundleRootFor(app.getAppPath()), mode);
    registerIpc(run, allowedOrigins);
    await loadPlayer();

    const window = createWindow('main', devUrl ?? APP_ORIGIN);
    dispatch.register(window.webContents);
    // WHY: закрытие окна снимает таймер проигрывателя. На darwin `window-all-closed` процесс
    // не гасит, поэтому без этого интервал продолжал бы тикать в приложение без единого окна.
    window.on('closed', () => player?.stop());
  })
  // WHY: именно `.catch`, а не второй аргумент `.then`. Второй аргумент ловит отказ САМОГО
  // `whenReady()`, который не отказывает никогда, и не ловит бросок из тела обработчика —
  // то есть ровно тот случай, ради которого написан: нечитаемый трейс и битый `marks.json`.
  // Первая редакция этой правки была именно такой и не чинила ничего.
  .catch((cause: unknown) => {
    // `showErrorBox` работает и до готовности окна, и в упакованном `.app`, запущенном без
    // терминала, где `stderr` читать некому. Пишем оба: один — человеку, второй — запускающему.
    process.stderr.write(`mcpproxy: приложение не стартовало — ${String(cause)}\n`);
    dialog.showErrorBox('mcpproxy не стартовал', String(cause));
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
