import { contextBridge } from 'electron';

declare const MCPPROXY_OBSERVE: boolean;

/**
 * Мост наружу. Пока пуст по содержанию, но форма уже та, которой останется: один замороженный
 * объект с именованными методами. `ipcRenderer` через него не проходит ни целиком, ни
 * отдельным методом — граница IPC заводится следующей задачей и ляжет сюда же.
 */
contextBridge.exposeInMainWorld('mcpproxy', Object.freeze({}));

/**
 * Наблюдение за фактически применёнными флагами — только под флагом сборки.
 *
 * Требование просит читать настройки **созданного окна**, а не фабрики: вызов вида
 * `new BrowserWindow({ webPreferences: { ...webPreferencesFor(...), sandbox: false } })`
 * прошёл бы юнит фабрики целиком.
 *
 * Читается `process.sandboxed`, а не настройки окна: публичного API для чтения применённых
 * `webPreferences` у `WebContents` нет вовсе — я предполагал обратное, и тайпчек это отверг.
 * Замена оказалась строго сильнее: `process.sandboxed` показывает **эффект** флага в самом
 * процессе рендерера, а не то, что было запрошено при создании. Ослабление на месте вызова
 * поэтому видно, даже если фабрика вернула верные значения.
 *
 * Изнутри главного мира страницы этого не увидеть: при `contextIsolation` и
 * `nodeIntegration: false` узловых глобалей там нет **независимо** от песочницы. Поэтому
 * наблюдатель живёт в preload, который в песочничном процессе всё равно исполняется.
 *
 * В отгружаемой сборке флаг равен лжи, и бандлер вырезает и объект, и ветку.
 */
if (MCPPROXY_OBSERVE) {
  contextBridge.exposeInMainWorld(
    '__mcpproxyObserve',
    Object.freeze({
      sandboxed: process.sandboxed === true,
      contextIsolated: process.contextIsolated === true,
    }),
  );
}
