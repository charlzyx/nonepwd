export type ThemePreference = 'light' | 'dark' | 'system';

export const THEME_STORAGE_KEY = 'theme';

export function normalizeThemePreference(value: unknown): ThemePreference {
  if (value === 'dark' || value === 'system' || value === 'light') {
    return value;
  }
  return 'light';
}

export function resolveIsDark(pref: ThemePreference): boolean {
  if (pref === 'dark') return true;
  if (pref === 'light') return false;
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

export function applyDocumentTheme(pref: ThemePreference, doc: Document = document): boolean {
  const isDark = resolveIsDark(pref);
  doc.documentElement.classList.toggle('dark', isDark);
  doc.documentElement.dataset.theme = pref;
  return isDark;
}

export async function loadThemePreference(): Promise<ThemePreference> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const res = await chrome.storage.local.get(THEME_STORAGE_KEY);
      return normalizeThemePreference(res[THEME_STORAGE_KEY]);
    }
  } catch {
    // ignore storage errors
  }
  return 'light';
}

export async function saveThemePreference(pref: ThemePreference): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [THEME_STORAGE_KEY]: pref });
    }
  } catch {
    // ignore storage errors
  }
}

export function nextThemePreference(pref: ThemePreference): ThemePreference {
  if (pref === 'light') return 'dark';
  if (pref === 'dark') return 'system';
  return 'light';
}
