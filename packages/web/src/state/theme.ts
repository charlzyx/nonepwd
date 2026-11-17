import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'nonepwd.theme';
const THEME_CHANGE_EVENT = 'nonepwd-theme-change';

function readCurrentDark(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
}

export function useTheme() {
  const [isDark, setIsDark] = useState<boolean>(readCurrentDark);

  useEffect(() => {
    const onThemeChange = () => {
      setIsDark(readCurrentDark());
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);
    window.addEventListener('storage', onThemeChange);
    return () => {
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      window.removeEventListener('storage', onThemeChange);
    };
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    const dark = mode === 'dark';
    if (typeof document !== 'undefined') {
      document.documentElement.classList.toggle('dark', dark);
      document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    }
    try {
      localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // ignore storage errors
    }
    setIsDark(dark);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    }
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(readCurrentDark() ? 'light' : 'dark');
  }, [setTheme]);

  return { isDark, setTheme, toggleTheme };
}
