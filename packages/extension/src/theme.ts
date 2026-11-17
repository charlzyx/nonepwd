export type ThemePreference = 'light' | 'dark' | 'system';
export type PersistedPopupTab = 'site' | '2fa' | 'autofill' | 'generator';
export type UnlockDuration = 'session' | '3h' | '24h' | '7d';

export const THEME_STORAGE_KEY = 'theme';
export const INLINE_BADGE_HIDDEN_KEY = 'nonepwd_hide_inline_badge';
export const POPUP_ACTIVE_TAB_KEY = 'nonepwd_popup_active_tab';
export const UNLOCK_DURATION_KEY = 'nonepwd_unlock_duration';

export function unlockDurationToMs(dur: UnlockDuration): number | null {
  switch (dur) {
    case '3h':
      return 3 * 3600_000;
    case '24h':
      return 24 * 3600_000;
    case '7d':
      return 7 * 86400_000;
    default:
      return null;
  }
}

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

export async function loadInlineBadgeHidden(): Promise<boolean> {
  try {
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (storage) {
      const res = await storage.get(INLINE_BADGE_HIDDEN_KEY);
      return Boolean(res[INLINE_BADGE_HIDDEN_KEY]);
    }
  } catch {
    // ignore storage errors
  }
  return false;
}

export async function saveInlineBadgeHidden(hidden: boolean): Promise<void> {
  try {
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (storage) {
      await storage.set({ [INLINE_BADGE_HIDDEN_KEY]: hidden });
    }
  } catch {
    // ignore storage errors
  }
}

export async function loadPopupActiveTab(): Promise<PersistedPopupTab | null> {
  try {
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (storage) {
      const res = await storage.get(POPUP_ACTIVE_TAB_KEY);
      const val = res[POPUP_ACTIVE_TAB_KEY];
      if (val === 'site' || val === '2fa' || val === 'autofill' || val === 'generator') {
        return val;
      }
    }
  } catch {
    // ignore storage errors
  }
  return null;
}

export async function savePopupActiveTab(tab: PersistedPopupTab): Promise<void> {
  try {
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (storage) {
      await storage.set({ [POPUP_ACTIVE_TAB_KEY]: tab });
    }
  } catch {
    // ignore storage errors
  }
}

export async function loadUnlockDuration(): Promise<UnlockDuration> {
  try {
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (storage) {
      const res = await storage.get(UNLOCK_DURATION_KEY);
      const val = res[UNLOCK_DURATION_KEY];
      if (val === 'session' || val === '3h' || val === '24h' || val === '7d') {
        return val;
      }
    }
  } catch {
    // ignore storage errors
  }
  return '24h';
}

export async function saveUnlockDuration(dur: UnlockDuration): Promise<void> {
  try {
    const storage = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.local;
    if (storage) {
      await storage.set({ [UNLOCK_DURATION_KEY]: dur });
    }
  } catch {
    // ignore storage errors
  }
}
