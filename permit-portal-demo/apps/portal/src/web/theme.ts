// The colour theme: dark by default, light on request, remembered in this browser. index.html applies a saved
// light choice before the first paint with the same storage key, so the page does not flash dark first.

export type Theme = 'dark' | 'light';

export const DEFAULT_THEME: Theme = 'dark';
const STORAGE_KEY = 'theme';

type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;
// Reaching localStorage can itself throw (storage disabled, or a sandboxed frame), so callers pass a getter.
const browserStorage = (): ThemeStorage => localStorage;

/** The saved theme, or dark when there is none, it is unreadable, or the storage refuses to be read. */
export function readTheme(storage: () => ThemeStorage = browserStorage): Theme {
  try {
    return storage().getItem(STORAGE_KEY) === 'light' ? 'light' : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Remembers the choice; a storage that refuses it only means the choice lasts until the page reloads. */
export function saveTheme(theme: Theme, storage: () => ThemeStorage = browserStorage): void {
  try {
    storage().setItem(STORAGE_KEY, theme);
  } catch {
    /* private window or storage disabled */
  }
}

export const otherTheme = (theme: Theme): Theme => (theme === 'dark' ? 'light' : 'dark');

/** The switch names the theme it switches to. */
export const themeSwitchLabel = (theme: Theme) => (otherTheme(theme) === 'light' ? 'Light mode' : 'Dark mode');

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}
