import { BrowserWindow } from 'electron';
import { join } from 'node:path';

export type WindowRole = 'main';

/**
 * Настройки безопасности окна — данными, а не в месте вызова.
 *
 * Инвариант И8 требует четырёх флагов, и смысл этой функции в том, что их можно прочитать
 * тестом, не запуская Electron. Путь к preload приходит входом: композиция с резолвом
 * раскладки сборки сделала бы функцию зависимой от рантайма и обнулила бы это свойство.
 *
 * `spellcheck: false` — не косметика: проверка орфографии включена по умолчанию и тянет
 * словари из главного процесса по сети, то есть мимо CSP рендерера. Приложению безопасности
 * она не нужна ни при каком раскладе.
 */
export function webPreferencesFor(role: WindowRole, preload: string): Electron.WebPreferences {
  void role;
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
    preload,
  };
}

/**
 * Единственное место, где создаётся окно.
 *
 * Утверждение о четырёх флагах имеет силу ровно постольку, поскольку других мест создания
 * нет: иначе вызывающий ослабил бы их спредом, и тест фабрики остался бы зелёным. Страж в
 * смоуке сканирует исходники именно на это.
 *
 * Адрес приходит аргументом, а не берётся из константы схемы: схему заводит следующая задача,
 * и ссылка на неё сделала бы этот модуль некомпилируемым.
 */
export function createWindow(role: WindowRole, url: string): BrowserWindow {
  const preload = join(__dirname, '../preload/index.cjs');
  const icon = join(__dirname, '../../assets/logo.svg');
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    icon,
    webPreferences: webPreferencesFor(role, preload),
  });
  window.once('ready-to-show', () => window.show());
  void window.loadURL(url);
  return window;
}
