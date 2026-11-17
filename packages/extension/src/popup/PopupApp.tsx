import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  CreditCard,
  Dices,
  ExternalLink,
  KeyRound,
  Lock,
  MailCheck,
  MapPin,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  Shield,
  Sun,
  X,
} from 'lucide-react';
import {
  generatePassword,
  generateTotp,
  type DecryptedEmailPayload,
} from '@nonepwd/core';
import { formatCardDisplay, formatCardExpiry } from '../filler';
import {
  applyDocumentTheme,
  loadThemePreference,
  nextThemePreference,
  saveThemePreference,
  type ThemePreference,
} from '../theme';
import type { ExtendedVaultItem } from '../types';

interface PopupState {
  unlocked: boolean;
  prefs: { serverUrl?: string; email?: string; secretKey?: string };
  items: ExtendedVaultItem[];
  emails: Array<DecryptedEmailPayload & { id: string }>;
  aliasDomain: string;
}

interface LoginMatch {
  item: ExtendedVaultItem;
  totpCode: string | null;
  totpRemaining: number;
}

type PopupTab = 'all' | 'cards' | 'identities' | 'generator';

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

export const PopupApp: React.FC<{ initialTheme?: ThemePreference }> = ({
  initialTheme = 'light',
}) => {
  const [themePref, setThemePref] = useState<ThemePreference>(initialTheme);
  const [state, setState] = useState<PopupState | null>(null);
  const [tabUrl, setTabUrl] = useState('');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [matchedLogins, setMatchedLogins] = useState<LoginMatch[]>([]);
  const [latestOtpEmail, setLatestOtpEmail] = useState<
    (DecryptedEmailPayload & { id: string }) | null
  >(null);

  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8787');
  const [secretKey, setSecretKey] = useState('');
  const [masterPassword, setMasterPassword] = useState('');
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<PopupTab>('all');
  const [activeRowIdx, setActiveRowIdx] = useState<number>(-1);
  const [generatedPass, setGeneratedPass] = useState(() => generatePassword({ length: 20 }));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void loadThemePreference().then((stored) => {
      setThemePref(stored);
      applyDocumentTheme(stored);
    });
  }, []);

  useEffect(() => {
    applyDocumentTheme(themePref);
    if (themePref !== 'system' || typeof window === 'undefined' || !window.matchMedia) {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => applyDocumentTheme('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [themePref]);

  const handleCycleTheme = async () => {
    const next = nextThemePreference(themePref);
    setThemePref(next);
    applyDocumentTheme(next);
    await saveThemePreference(next);
  };

  const loadAll = useCallback(async () => {
    const res = (await chrome.runtime.sendMessage({ type: 'NONEPWD_GET_STATE' })) as {
      ok: boolean;
    } & PopupState;
    if (res.ok) {
      setState(res);
      if (res.prefs.serverUrl) setServerUrl(res.prefs.serverUrl);
      if (res.prefs.secretKey) setSecretKey(res.prefs.secretKey);
    }

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTabInfo = tabs[0];
    if (activeTabInfo?.url) {
      setTabUrl(activeTabInfo.url);
      setTabId(activeTabInfo.id);
      const q = (await chrome.runtime.sendMessage({
        type: 'NONEPWD_QUERY_TAB',
        url: activeTabInfo.url,
        tabId: activeTabInfo.id,
      })) as {
        ok: boolean;
        logins: LoginMatch[];
        latestOtpEmail: (DecryptedEmailPayload & { id: string }) | null;
      };
      if (q.ok) {
        setMatchedLogins(q.logins);
        setLatestOtpEmail(q.latestOtpEmail);
      }
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // Live 1s countdown for matched 2FA codes
  const hasTotpMatches = matchedLogins.some((m) => Boolean(m.item.totp));
  useEffect(() => {
    if (!state?.unlocked || !hasTotpMatches) return;
    const timer = setInterval(() => {
      void Promise.all(
        matchedLogins.map(async (entry) => {
          if (!entry.item.totp) return entry;
          try {
            const res = await generateTotp(entry.item.totp);
            return { ...entry, totpCode: res.code, totpRemaining: res.remainingSeconds };
          } catch {
            return entry;
          }
        })
      ).then(setMatchedLogins);
    }, 1000);
    return () => clearInterval(timer);
  }, [state?.unlocked, hasTotpMatches, matchedLogins]);

  const copyValue = async (id: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopiedId(id);
    setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1200);
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'NONEPWD_UNLOCK',
        serverUrl,
        secretKey,
        masterPassword,
      })) as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(res.error || '解锁失败');
      setMasterPassword('');
      await loadAll();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleLock = async () => {
    await chrome.runtime.sendMessage({ type: 'NONEPWD_LOCK' });
    await loadAll();
  };

  const handleFillLogin = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_FROM_POPUP', item });
      window.close();
    },
    [tabId]
  );

  const handleFillOtp = useCallback(
    async (code: string) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_OTP_FROM_POPUP', code });
      window.close();
    },
    [tabId]
  );

  const handleFillCard = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_CARD_FROM_POPUP', item });
      window.close();
    },
    [tabId]
  );

  const handleFillCvv = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_CVV_FROM_POPUP', item });
      window.close();
    },
    [tabId]
  );

  const handleFillIdentity = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_IDENTITY_FROM_POPUP', item });
      window.close();
    },
    [tabId]
  );

  const cardItems = useMemo(
    () => (state?.items ?? []).filter((i) => i.category === 'card' && Boolean(i.card)),
    [state?.items]
  );

  const identityItems = useMemo(
    () => (state?.items ?? []).filter((i) => i.category === 'identity' && Boolean(i.identity)),
    [state?.items]
  );

  const filteredSearchItems = useMemo(() => {
    const items = state?.items ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return items.filter((i) => i.category !== 'card' && i.category !== 'identity').slice(0, 8);
    return items
      .filter((i) => {
        const cardDigits = i.card?.number?.slice(-4) ?? '';
        const idText = [
          i.identity?.fullName,
          i.identity?.address1,
          i.identity?.city,
          i.identity?.phone,
          i.identity?.email,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();
        return (
          i.title.toLowerCase().includes(q) ||
          (i.username ?? '').toLowerCase().includes(q) ||
          i.urls.some((u) => u.toLowerCase().includes(q)) ||
          (i.card?.brand ?? '').toLowerCase().includes(q) ||
          cardDigits.includes(q) ||
          idText.includes(q)
        );
      })
      .slice(0, 12);
  }, [search, state?.items]);

  const activeListItems = useMemo(() => {
    if (search.trim()) return filteredSearchItems;
    if (activeTab === 'cards') return cardItems;
    if (activeTab === 'identities') return identityItems;
    if (activeTab === 'all') return filteredSearchItems;
    return [];
  }, [activeTab, cardItems, filteredSearchItems, identityItems, search]);

  useEffect(() => {
    setActiveRowIdx(-1);
  }, [search, activeTab]);

  // Keyboard shortcuts: Cmd/Ctrl+K focus search, ArrowUp/Down navigate, Enter execute primary action
  useEffect(() => {
    if (!state?.unlocked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }
      if (e.key === 'Escape' && search) {
        e.preventDefault();
        setSearch('');
        return;
      }
      if (activeListItems.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveRowIdx((prev) => (prev + 1) % activeListItems.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveRowIdx((prev) => (prev <= 0 ? activeListItems.length - 1 : prev - 1));
      } else if (e.key === 'Enter' && activeRowIdx >= 0 && activeRowIdx < activeListItems.length) {
        const targetEl = e.target as HTMLElement | null;
        if (targetEl?.tagName === 'BUTTON') return;
        e.preventDefault();
        const item = activeListItems[activeRowIdx];
        if (item.category === 'card' && item.card) {
          void handleFillCard(item);
        } else if (item.category === 'identity' && item.identity) {
          void handleFillIdentity(item);
        } else if (item.category === 'login') {
          void handleFillLogin(item);
        } else if (item.password) {
          void copyValue(`pw-${item.id}`, item.password);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    state?.unlocked,
    search,
    activeListItems,
    activeRowIdx,
    handleFillCard,
    handleFillIdentity,
    handleFillLogin,
  ]);

  const themeIcon =
    themePref === 'dark' ? (
      <Moon className="h-3.5 w-3.5" />
    ) : themePref === 'system' ? (
      <Monitor className="h-3.5 w-3.5" />
    ) : (
      <Sun className="h-3.5 w-3.5" />
    );

  const themeLabel =
    themePref === 'dark' ? '深色模式' : themePref === 'system' ? '跟随系统' : '浅色模式';

  if (!state) {
    return (
      <div className="flex h-[480px] items-center justify-center bg-background text-xs text-muted-foreground">
        正在加载 nonepwd...
      </div>
    );
  }

  if (!state.unlocked) {
    return (
      <div className="flex min-h-[480px] flex-col justify-between bg-background p-5 text-foreground">
        <div>
          <div className="mb-5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground">
                <Shield className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-semibold tracking-tight text-foreground">解锁 nonepwd</h1>
                <p className="text-[11px] text-muted-foreground">零知识自建密码库</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void handleCycleTheme()}
              title={`切换主题（当前：${themeLabel}）`}
              aria-label={`切换主题（当前：${themeLabel}）`}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {themeIcon}
              <span>{themePref === 'system' ? '系统' : themePref === 'dark' ? '深色' : '浅色'}</span>
            </button>
          </div>

          {err && (
            <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-600 dark:text-rose-400">
              {err}
            </div>
          )}

          <form onSubmit={handleUnlock} className="space-y-3">
            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                服务端地址
              </label>
              <input
                type="url"
                required
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground outline-none transition-colors focus:border-ring"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">
                Secret Key (NP3-...)
              </label>
              <input
                type="text"
                required
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="NP3-XXXXXX-..."
                className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring"
              />
            </div>

            <div>
              <label className="mb-1 block text-[11px] font-medium text-muted-foreground">主密码</label>
              <input
                type="password"
                required
                autoFocus
                value={masterPassword}
                onChange={(e) => setMasterPassword(e.target.value)}
                placeholder="输入主密码解锁"
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-ring"
              />
            </div>

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
            >
              <KeyRound className="h-3.5 w-3.5" />
              <span>{busy ? '正在解锁...' : '解锁密码库'}</span>
            </button>
          </form>
        </div>

        <div className="border-t border-border pt-3 text-center font-mono text-[10px] text-muted-foreground">
          End-to-End Encrypted · Local Vault Session
        </div>
      </div>
    );
  }

  const hostname = getHostname(tabUrl);

  return (
    <div className="flex h-[500px] flex-col bg-background text-foreground">
      {/* Top Bar */}
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-border px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Shield className="h-3.5 w-3.5 shrink-0 text-foreground" />
          <span className="font-mono text-xs font-semibold tracking-tight text-foreground">
            nonepwd
          </span>
          {hostname && (
            <span className="max-w-[130px] truncate rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {hostname}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() =>
              void chrome.runtime.sendMessage({ type: 'NONEPWD_SYNC' }).then(() => loadAll())
            }
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="立即同步"
            aria-label="立即同步"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void chrome.tabs.create({ url: `${serverUrl.replace(/\/+$/, '')}/vault` })}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="打开 Web 管理台"
            aria-label="打开 Web 管理台"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleCycleTheme()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title={`主题：${themeLabel}（点击切换）`}
            aria-label={`主题：${themeLabel}`}
          >
            {themeIcon}
          </button>
          <button
            type="button"
            onClick={() => void handleLock()}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            title="锁定"
            aria-label="锁定"
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="shrink-0 space-y-2.5 border-b border-border p-3">
          {/* Live Email OTP Banner */}
          {latestOtpEmail?.otpCode && (
            <div className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1 text-[10px] font-medium text-muted-foreground">
                  <MailCheck className="h-3 w-3 shrink-0" />
                  <span className="truncate">邮箱验证码 · {latestOtpEmail.senderDomain}</span>
                </div>
                <div className="font-mono text-base font-semibold tracking-widest text-foreground">
                  {latestOtpEmail.otpCode}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => void handleFillOtp(latestOtpEmail.otpCode!)}
                  className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                >
                  填入
                </button>
                <button
                  type="button"
                  onClick={() => void copyValue('email-otp', latestOtpEmail.otpCode!)}
                  className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-muted"
                  title="复制验证码"
                >
                  {copiedId === 'email-otp' ? (
                    <Check className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Current Site Matches (Highest Priority) */}
          <div>
            <div className="mb-1.5 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              <span>当前站点匹配</span>
              <span className="font-mono">{matchedLogins.length}</span>
            </div>

            {matchedLogins.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border px-3 py-2.5 text-center text-[11px] text-muted-foreground">
                当前网页暂无匹配账号，可在下方搜索或切换卡片/地址填充
              </div>
            ) : (
              <div className="max-h-[144px] space-y-1.5 overflow-y-auto">
                {matchedLogins.map(({ item, totpCode, totpRemaining }) => (
                  <div
                    key={item.id}
                    className="rounded-lg border border-border bg-card p-2.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <div className="truncate text-xs font-medium text-foreground">
                          {item.title}
                        </div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {item.username || item.emailAlias || '无用户名'}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleFillLogin(item)}
                        className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                      >
                        填充
                      </button>
                    </div>

                    {totpCode && (
                      <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-semibold tracking-wider text-foreground">
                            {totpCode}
                          </span>
                          <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                            {totpRemaining}s
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleFillOtp(totpCode)}
                            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
                          >
                            填 2FA
                          </button>
                          <button
                            type="button"
                            onClick={() => void copyValue(`totp-${item.id}`, totpCode)}
                            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            {copiedId === `totp-${item.id}` ? '已复制' : '复制'}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Search Bar */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchInputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索账号、卡片、地址... (⌘K)"
              className="w-full rounded-lg border border-input bg-background py-1.5 pl-8 pr-7 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-ring"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="清除搜索"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        {/* Compact Section Tabs */}
        {!search.trim() && (
          <div className="grid shrink-0 grid-cols-4 border-b border-border bg-card/50 text-[11px]">
            {(
              [
                { id: 'all', label: '条目' },
                { id: 'cards', label: `卡片${cardItems.length ? ` ${cardItems.length}` : ''}` },
                {
                  id: 'identities',
                  label: `地址${identityItems.length ? ` ${identityItems.length}` : ''}`,
                },
                { id: 'generator', label: '生成' },
              ] as const
            ).map((t) => {
              const active = activeTab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setActiveTab(t.id)}
                  className={`border-b-2 py-2 font-medium transition-colors ${
                    active
                      ? 'border-foreground text-foreground'
                      : 'border-transparent text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
        )}

        {/* Tab Body */}
        <div className="flex-1 overflow-y-auto p-3">
          {!search.trim() && activeTab === 'generator' ? (
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-card p-3">
                <div className="mb-2 flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>20 位高强度随机密码</span>
                  <button
                    type="button"
                    onClick={() => setGeneratedPass(generatePassword({ length: 20 }))}
                    className="inline-flex items-center gap-1 text-foreground hover:underline"
                  >
                    <Dices className="h-3 w-3" />
                    换一个
                  </button>
                </div>
                <code className="block break-all rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground">
                  {generatedPass}
                </code>
                <button
                  type="button"
                  onClick={() => void copyValue('gen-pass', generatedPass)}
                  className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-md bg-primary py-1.5 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                >
                  {copiedId === 'gen-pass' ? (
                    <>
                      <Check className="h-3.5 w-3.5" />
                      已复制到剪贴板
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      复制密码
                    </>
                  )}
                </button>
              </div>
            </div>
          ) : !search.trim() && activeTab === 'cards' ? (
            <section aria-label="卡片">
              <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <span>卡片</span>
                <span className="font-mono">{cardItems.length}</span>
              </div>
              {cardItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
                  <CreditCard className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground/70" />
                  暂无保存的卡片，请在 Web 管理台添加
                </div>
              ) : (
                <div className="space-y-1.5">
                  {cardItems.map((it, idx) => {
                    const { label } = formatCardDisplay(it.card, it.title);
                    const exp = formatCardExpiry(it.card?.expMonth, it.card?.expYear);
                    const sub = [it.title, it.card?.cardholderName, exp].filter(Boolean).join(' · ');
                    return (
                      <div
                        key={it.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 ${
                          idx === activeRowIdx
                            ? 'border-ring bg-muted'
                            : 'border-border bg-card'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate font-mono text-xs font-medium text-foreground">
                            {label}
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void handleFillCard(it)}
                            className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                          >
                            填充
                          </button>
                          {it.card?.cvv && (
                            <button
                              type="button"
                              onClick={() => void handleFillCvv(it)}
                              title="点击单独填入安全码 (CVV)"
                              className="rounded-md border border-border bg-background px-2 py-1 font-mono text-[10px] font-medium text-foreground transition-colors hover:bg-muted"
                            >
                              填 CVV
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : !search.trim() && activeTab === 'identities' ? (
            <section aria-label="地址">
              <div className="mb-2 flex items-center justify-between text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                <span>地址</span>
                <span className="font-mono">{identityItems.length}</span>
              </div>
              {identityItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
                  <MapPin className="mx-auto mb-1.5 h-4 w-4 text-muted-foreground/70" />
                  暂无保存的地址 / 身份信息
                </div>
              ) : (
                <div className="space-y-1.5">
                  {identityItems.map((it, idx) => {
                    const id = it.identity!;
                    const title =
                      id.fullName ||
                      [id.firstName, id.lastName].filter(Boolean).join(' ') ||
                      it.title;
                    const sub =
                      [id.address1, id.city, id.phone || id.email].filter(Boolean).join(' · ') ||
                      it.title;
                    return (
                      <div
                        key={it.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 ${
                          idx === activeRowIdx
                            ? 'border-ring bg-muted'
                            : 'border-border bg-card'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="truncate text-xs font-medium text-foreground">{title}</div>
                          <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleFillIdentity(it)}
                          className="shrink-0 rounded-md bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                        >
                          填充
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          ) : (
            <div className="space-y-1.5">
              {activeListItems.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-[11px] text-muted-foreground">
                  {search.trim() ? '没有找到匹配的条目' : '密码库暂无条目'}
                </div>
              ) : (
                activeListItems.map((it, idx) => {
                  const isCard = it.category === 'card' && it.card;
                  const isIdentity = it.category === 'identity' && it.identity;
                  const title = isCard
                    ? formatCardDisplay(it.card, it.title).label
                    : isIdentity
                      ? it.identity?.fullName || it.title
                      : it.title;
                  const sub = isCard
                    ? [it.title, it.card?.cardholderName].filter(Boolean).join(' · ')
                    : isIdentity
                      ? [it.identity?.address1, it.identity?.city, it.identity?.phone]
                          .filter(Boolean)
                          .join(' · ')
                      : it.username || it.emailAlias || '';

                  return (
                    <div
                      key={it.id}
                      className={`flex items-center justify-between gap-2 rounded-lg border px-2.5 py-2 text-xs transition-colors ${
                        idx === activeRowIdx
                          ? 'border-ring bg-muted'
                          : 'border-border bg-card/60 hover:bg-card'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="truncate font-medium text-foreground">{title}</div>
                        {sub && (
                          <div className="truncate text-[10px] text-muted-foreground">{sub}</div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        {isCard && (
                          <>
                            <button
                              type="button"
                              onClick={() => void handleFillCard(it)}
                              className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground"
                            >
                              填充
                            </button>
                            {it.card?.cvv && (
                              <button
                                type="button"
                                onClick={() => void handleFillCvv(it)}
                                className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] text-foreground hover:bg-muted"
                              >
                                CVV
                              </button>
                            )}
                          </>
                        )}
                        {isIdentity && (
                          <button
                            type="button"
                            onClick={() => void handleFillIdentity(it)}
                            className="rounded bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground"
                          >
                            填充
                          </button>
                        )}
                        {it.category === 'login' && (
                          <button
                            type="button"
                            onClick={() => void handleFillLogin(it)}
                            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted"
                          >
                            填充
                          </button>
                        )}
                        {it.password && (
                          <button
                            type="button"
                            onClick={() => void copyValue(`pw-${it.id}`, it.password!)}
                            className="rounded border border-border bg-background px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-muted hover:text-foreground"
                          >
                            {copiedId === `pw-${it.id}` ? '已复制' : '密码'}
                          </button>
                        )}
                        {it.totp && (
                          <button
                            type="button"
                            onClick={async () => {
                              const res = await generateTotp(it.totp!);
                              await copyValue(`otp-${it.id}`, res.code);
                            }}
                            className="rounded border border-border bg-background px-2 py-0.5 font-mono text-[10px] text-foreground hover:bg-muted"
                          >
                            {copiedId === `otp-${it.id}` ? '已复制' : '2FA'}
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
