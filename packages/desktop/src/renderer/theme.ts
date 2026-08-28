export type ThemeName = 'dark' | 'light';

/**
 * Явный выбор побеждает системный в обе стороны.
 *
 * Дизайн-система объявляет три состояния: атрибут на корне перекрывает `prefers-color-scheme`,
 * а его отсутствие отдаёт решение системе. Здесь только запись атрибута — вся раскраска уже
 * приехала с CSS пакета.
 */
export function applyTheme(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme);
}

export function currentTheme(): ThemeName {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark' || explicit === 'light') return explicit;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
