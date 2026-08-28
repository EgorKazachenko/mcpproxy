import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SandboxMode } from '@mcpproxy/contracts';

/**
 * Конфиг демона. Отдельный файл, а не поле манифеста: в замороженной схеме места нет, и
 * заводить его там было бы неверно и по смыслу — режим песочницы и список разрешённых
 * бинарей описывают **установку**, а не рецепт, и подписывать их хэшем рецепта не за что.
 *
 * **Полей ровно два, и это уже, чем предполагалось.** Из пяти ручек, которые доки называли
 * «константами демона», три оказались не нашими: `strictAllowlist: true` прибит внутри E3
 * (`packages/core/src/exec/modes/seatbelt.ts:71`), grace-период — `DEFAULT_GRACE_MS` там же,
 * а `allowLocalBinding` в ядре не существует ни одной строкой. Ручка, которую конфиг
 * объявляет, но никто не читает, хуже отсутствующей: она врёт о том, чем можно управлять.
 */
export interface DaemonConfig {
  /**
   * Режим выбирает вызывающий, а не манифест (R4 E3): в замороженной схеме поля под него нет.
   * `none` — это baseline-режим для замера ASR в E8, а не «выключить лишнее».
   */
  readonly sandboxMode: SandboxMode;
  /**
   * Список абсолютных путей, разрешённых как `exec[0]` (A4). Пуст по умолчанию, и это
   * fail-closed: пустой список запрещает и голое имя, и абсолютный путь, оставляя рабочим
   * только путь вниз от каталога манифеста. Смысл списка — снять PATH hijack, а список,
   * который по умолчанию разрешает всё, его бы не снимал.
   */
  readonly binaryAllowlist: readonly string[];
}

export const DEFAULT_CONFIG: DaemonConfig = {
  sandboxMode: 'seatbelt',
  binaryAllowlist: [],
};

export const CONFIG_FILE = 'mcpproxyd.json';

export function configPath(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const home = env.MCPPROXY_HOME;
  return join(home === undefined || home === '' ? join(homedir(), '.mcpproxy') : home, CONFIG_FILE);
}

export type ParseConfigResult =
  | { readonly ok: true; readonly config: DaemonConfig }
  | { readonly ok: false; readonly problems: readonly string[] };

const MODES: Record<SandboxMode, true> = { none: true, seatbelt: true, container: true };

/**
 * Разбор строгий и без починки умолчаниями: неизвестный ключ, неверный тип и неизвестный
 * режим — отказ, а не «возьмём дефолт». Конфиг решает, под какой песочницей исполняется
 * чужой код; опечатка в `sandboxMode`, молча превращённая в `seatbelt`, читалась бы как
 * успех и в тот день, когда автор хотел `none`, и в тот, когда наоборот.
 */
export function parseConfig(text: string): ParseConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`конфиг не разбирается как JSON: ${(error as Error).message}`] };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problems: ['конфиг не является объектом'] };
  }

  const problems: string[] = [];
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (key !== 'sandboxMode' && key !== 'binaryAllowlist') problems.push(`неизвестный ключ ${JSON.stringify(key)}`);
  }

  let sandboxMode = DEFAULT_CONFIG.sandboxMode;
  if (source.sandboxMode !== undefined) {
    const mode = source.sandboxMode;
    if (typeof mode !== 'string' || !Object.hasOwn(MODES, mode)) {
      problems.push(`sandboxMode не является режимом песочницы: ${JSON.stringify(mode)}`);
    } else {
      sandboxMode = mode as SandboxMode;
    }
  }

  let binaryAllowlist: readonly string[] = DEFAULT_CONFIG.binaryAllowlist;
  if (source.binaryAllowlist !== undefined) {
    const list = source.binaryAllowlist;
    if (!Array.isArray(list) || list.some((one) => typeof one !== 'string')) {
      problems.push('binaryAllowlist не является списком строк');
    } else if (list.some((one: string) => !one.startsWith('/'))) {
      problems.push('binaryAllowlist содержит не абсолютный путь: относительный путь в этом списке не имеет смысла');
    } else {
      binaryAllowlist = [...(list as string[])];
    }
  }

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { sandboxMode, binaryAllowlist } };
}

export type LoadConfigResult = ParseConfigResult | { readonly ok: true; readonly config: DaemonConfig; readonly absent: true };

/** Отсутствие файла — это дефолты. Присутствие нечитаемого или неразбираемого — отказ. */
export function loadConfig(path: string): LoadConfigResult {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { ok: true, config: DEFAULT_CONFIG, absent: true };
    return { ok: false, problems: [`конфиг не читается (${code ?? 'неизвестно'}): ${path}`] };
  }
  return parseConfig(text);
}
