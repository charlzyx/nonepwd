import { useCallback, useEffect, useState } from 'react';

export type Locale = 'zh' | 'en';

const LOCALE_STORAGE_KEY = 'nonepwd.locale';
const LOCALE_CHANGE_EVENT = 'nonepwd-locale-change';

function parseExplicitLocale(raw: string | null | undefined): Locale | null {
  if (!raw) return null;
  const val = raw.trim().toLowerCase();
  if (val === 'zh' || val.startsWith('zh-')) return 'zh';
  if (val === 'en' || val.startsWith('en-')) return 'en';
  return null;
}

export function detectInitialLocale(): Locale {
  if (typeof window !== 'undefined') {
    try {
      const fromQuery = parseExplicitLocale(new URLSearchParams(window.location.search).get('lang'));
      if (fromQuery) return fromQuery;
    } catch {
      // ignore invalid URL search
    }
    try {
      const saved = parseExplicitLocale(localStorage.getItem(LOCALE_STORAGE_KEY));
      if (saved) return saved;
    } catch {
      // ignore storage errors
    }
    if (typeof navigator !== 'undefined') {
      const candidates =
        Array.isArray(navigator.languages) && navigator.languages.length > 0
          ? navigator.languages
          : [navigator.language];
      for (const lang of candidates) {
        const parsed = parseExplicitLocale(lang);
        if (parsed) return parsed;
      }
    }
  }
  return 'en';
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title =
    locale === 'zh'
      ? 'nonepwd — 私有化零知识密码库与实时验证码引擎'
      : 'nonepwd — Self-Hosted Zero-Knowledge Vault & Live OTP Engine';
}

export function useLocale() {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const initial = detectInitialLocale();
    applyDocumentLocale(initial);
    return initial;
  });

  useEffect(() => {
    applyDocumentLocale(locale);
  }, [locale]);

  useEffect(() => {
    const onLocaleChange = () => {
      const next = detectInitialLocale();
      applyDocumentLocale(next);
      setLocaleState(next);
    };
    window.addEventListener(LOCALE_CHANGE_EVENT, onLocaleChange);
    window.addEventListener('storage', onLocaleChange);
    return () => {
      window.removeEventListener(LOCALE_CHANGE_EVENT, onLocaleChange);
      window.removeEventListener('storage', onLocaleChange);
    };
  }, []);

  const setLocale = useCallback((next: Locale) => {
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next);
    } catch {
      // ignore storage errors
    }
    applyDocumentLocale(next);
    setLocaleState(next);
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(LOCALE_CHANGE_EVENT));
    }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocale(locale === 'zh' ? 'en' : 'zh');
  }, [locale, setLocale]);

  return {
    locale,
    isZh: locale === 'zh',
    setLocale,
    toggleLocale,
  };
}
