import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, otherTheme, readTheme, saveTheme, themeSwitchLabel } from '../src/web/theme';

const storageWith = (value: string | null) => () => ({ getItem: () => value, setItem: () => undefined });
const denied = () => {
  throw new Error('SecurityError: storage is disabled');
};

describe('theme preference', () => {
  it('defaults to dark', () => {
    expect(DEFAULT_THEME).toBe('dark');
    expect(readTheme(storageWith(null))).toBe('dark');
  });

  it('restores a saved choice', () => {
    expect(readTheme(storageWith('light'))).toBe('light');
    expect(readTheme(storageWith('dark'))).toBe('dark');
  });

  it('falls back to dark when the saved value is unknown or the storage cannot be read', () => {
    expect(readTheme(storageWith('sepia'))).toBe('dark');
    expect(readTheme(denied)).toBe('dark');
    expect(
      readTheme(() => ({
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => undefined,
      })),
    ).toBe('dark');
  });

  it('saves a choice, and does not fail when the storage refuses it', () => {
    const saved = new Map<string, string>();
    saveTheme('light', () => ({ getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => void saved.set(k, v) }));
    expect(saved.get('theme')).toBe('light');

    expect(() => saveTheme('light', denied)).not.toThrow();
  });

  it('labels the switch with the theme it switches to', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
    expect(themeSwitchLabel('dark')).toBe('Light mode');
    expect(themeSwitchLabel('light')).toBe('Dark mode');
  });
});
