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

const SEO_META: Record<Locale, { title: string; description: string }> = {
  zh: {
    title: 'nonepwd — 免费自建密码管理器 · 1Password 零订阅平替与实时验证码',
    description:
      '源码公开、个人免费自建的零知识密码管理器（1Password / Bitwarden 零订阅费平替）。纯 Rust 加密核心，内置 2FA 验证器、多邮箱实时接码、域名别名与 op:// 兼容 CLI，支持 macOS、iOS、Android 与浏览器扩展。',
  },
  en: {
    title: 'nonepwd — Free Self-Hosted Password Manager & 1Password Alternative',
    description:
      'Free self-hosted, source-available password manager and 1Password alternative. Pure-Rust zero-knowledge AES-256-GCM vault with 2FA TOTP authenticator, live email OTPs, masked aliases, op:// compatible CLI, macOS, iOS, Android, and browser extension.',
  },
};

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = SEO_META[locale].title;
  const descEl = document.querySelector('meta[name="description"]');
  if (descEl) {
    descEl.setAttribute('content', SEO_META[locale].description);
  }
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
