/**
 * Токены. Источник истины для TS и для CSS — `scripts/generate-css.mjs`
 * генерирует `dist/css/tokens.css` отсюда, чтобы значения не разъезжались.
 */

import { amber, blue, green, neutral, red, violet } from './palette.js';

/* ── Типографика ────────────────────────────────────────────────────────── */

export const font = {
  /** Интерфейс. Системный стек первым — на macOS это SF, родной для Opera One. */
  sans: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`,
  /**
   * argv, пути, хэши, вывод процесса. Моноширинный — обязателен, а не украшение:
   * пользователь глазами сверяет аргументы команды, и пропорциональный шрифт
   * скрывает разницу между `-​-flag` и `--flаg` с кириллической «а».
   */
  mono: `"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace`,
} as const;

export const fontSize = {
  xs: '0.6875rem', // 11 — бейджи, подписи стадий
  sm: '0.8125rem', // 13 — плотные таблицы, таймлайн
  md: '0.875rem', //  14 — основной интерфейс
  lg: '1rem', //      16 — заголовки панелей
  xl: '1.25rem', //   20 — заголовки экранов
  '2xl': '1.75rem', //28 — модалка апрува
} as const;

export const fontWeight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const lineHeight = {
  tight: '1.25',
  normal: '1.5',
  relaxed: '1.7',
} as const;

/** Разрядка для микро-лейблов в верхнем регистре (стадии, тиры риска). */
export const letterSpacing = {
  tight: '-0.01em',
  normal: '0',
  wide: '0.04em',
  eyebrow: '0.08em',
} as const;

/* ── Пространство ───────────────────────────────────────────────────────── */

export const space = {
  0: '0',
  1: '2px',
  2: '4px',
  3: '6px',
  4: '8px',
  5: '12px',
  6: '16px',
  7: '20px',
  8: '24px',
  9: '32px',
  10: '40px',
  11: '48px',
  12: '64px',
} as const;

/** Скругления. Opera One заметно модульный и круглый — база выше среднего. */
export const radius = {
  none: '0',
  sm: '6px',
  md: '10px',
  lg: '14px',
  xl: '20px',
  full: '999px',
} as const;

/* ── Тени ───────────────────────────────────────────────────────────────── */

/**
 * Двухслойные: узкая контактная тень + широкая мягкая. Одиночная тень
 * всегда выглядит либо грязной, либо плоской.
 */
export const shadow = {
  none: 'none',
  sm: '0 1px 2px rgba(10,10,12,.06), 0 1px 3px rgba(10,10,12,.10)',
  md: '0 2px 4px rgba(10,10,12,.06), 0 4px 12px rgba(10,10,12,.10)',
  lg: '0 4px 8px rgba(10,10,12,.08), 0 12px 32px rgba(10,10,12,.14)',
  /** Модалка апрува — она обязана читаться как «всё остальное подождёт». */
  modal: '0 8px 16px rgba(10,10,12,.12), 0 32px 64px rgba(10,10,12,.28)',
} as const;

/* ── Движение ───────────────────────────────────────────────────────────── */

export const motion = {
  instant: '80ms',
  fast: '120ms',
  normal: '180ms',
  slow: '240ms',
  ease: 'cubic-bezier(.2,.8,.2,1)',
  easeIn: 'cubic-bezier(.4,0,1,1)',
} as const;

/* ── Слои ───────────────────────────────────────────────────────────────── */

export const zIndex = {
  base: 0,
  sticky: 100,
  dropdown: 200,
  overlay: 300,
  /** Апрув — поверх всего. Ниже него не может быть ничего интерактивного. */
  approval: 400,
  toast: 500,
} as const;

/* ── Темы ───────────────────────────────────────────────────────────────── */

/**
 * Тёмная — основная. Приложение живёт рядом с терминалом и смотрит на него
 * часами; светлая существует как равноправная, но проектируется второй.
 */
export interface Theme {
  readonly bg: {
    readonly app: string;
    readonly surface: string;
    readonly raised: string;
    readonly sunken: string;
    readonly overlay: string;
    readonly hover: string;
    readonly active: string;
  };
  readonly text: {
    readonly primary: string;
    readonly secondary: string;
    readonly tertiary: string;
    readonly inverse: string;
    readonly onBrand: string;
  };
  readonly border: {
    readonly subtle: string;
    readonly default: string;
    readonly strong: string;
    readonly focus: string;
  };
  readonly brand: {
    readonly base: string;
    readonly hover: string;
    readonly subtle: string;
    readonly onSubtle: string;
  };
  readonly state: {
    readonly ok: string;
    readonly okSubtle: string;
    readonly warn: string;
    readonly warnSubtle: string;
    readonly danger: string;
    readonly dangerSubtle: string;
    readonly info: string;
    readonly infoSubtle: string;
    readonly human: string;
    readonly humanSubtle: string;
  };
}

export const dark: Theme = {
  bg: {
    app: neutral[1000]!,
    surface: neutral[950]!,
    raised: neutral[900]!,
    sunken: '#070709',
    overlay: 'rgba(10,10,12,.72)',
    hover: 'rgba(255,255,255,.05)',
    active: 'rgba(255,255,255,.09)',
  },
  text: {
    primary: neutral[50]!,
    secondary: neutral[400]!,
    tertiary: neutral[500]!,
    inverse: neutral[1000]!,
    onBrand: neutral[0]!,
  },
  border: {
    subtle: 'rgba(255,255,255,.07)',
    default: 'rgba(255,255,255,.12)',
    strong: 'rgba(255,255,255,.20)',
    focus: red[500]!,
  },
  brand: {
    base: red[500]!,
    hover: red[400]!,
    subtle: 'rgba(255,27,45,.16)',
    onSubtle: red[300]!,
  },
  state: {
    ok: green[400]!,
    okSubtle: 'rgba(56,217,169,.14)',
    warn: amber[400]!,
    warnSubtle: 'rgba(255,184,77,.14)',
    danger: red[400]!,
    dangerSubtle: 'rgba(255,85,104,.16)',
    info: blue[300]!,
    infoSubtle: 'rgba(116,192,252,.14)',
    human: violet[300]!,
    humanSubtle: 'rgba(177,151,252,.14)',
  },
};

export const light: Theme = {
  bg: {
    app: neutral[50]!,
    surface: neutral[0]!,
    raised: neutral[0]!,
    sunken: neutral[100]!,
    overlay: 'rgba(28,28,33,.40)',
    hover: 'rgba(10,10,12,.04)',
    active: 'rgba(10,10,12,.07)',
  },
  text: {
    primary: neutral[900]!,
    secondary: neutral[600]!,
    tertiary: neutral[500]!,
    inverse: neutral[0]!,
    onBrand: neutral[0]!,
  },
  border: {
    subtle: 'rgba(10,10,12,.07)',
    default: 'rgba(10,10,12,.12)',
    strong: 'rgba(10,10,12,.22)',
    focus: red[600]!,
  },
  brand: {
    base: red[500]!,
    hover: red[600]!,
    subtle: red[50]!,
    onSubtle: red[700]!,
  },
  state: {
    ok: green[700]!,
    okSubtle: green[50]!,
    warn: amber[700]!,
    warnSubtle: amber[50]!,
    danger: red[700]!,
    dangerSubtle: red[50]!,
    info: blue[700]!,
    infoSubtle: blue[50]!,
    human: violet[700]!,
    humanSubtle: violet[50]!,
  },
};

export const themes = { dark, light } as const;
export type ThemeName = keyof typeof themes;
