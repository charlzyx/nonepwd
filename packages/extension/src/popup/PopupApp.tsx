import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  CreditCard,
  Dices,
  Eye,
  EyeOff,
  Globe,
  Lock,
  MailCheck,
  MapPin,
  Monitor,
  Moon,
  MoreHorizontal,
  Pin,
  RefreshCw,
  Search,
  ShieldCheck,
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
  loadInlineBadgeHidden,
  loadThemePreference,
  loadUnlockDuration,
  nextThemePreference,
  saveInlineBadgeHidden,
  saveThemePreference,
  saveUnlockDuration,
  type PersistedPopupTab,
  type ThemePreference,
  type UnlockDuration,
} from '../theme';
import type { PendingCredentialCapture } from '../capture';
import type { ExtendedVaultItem } from '../types';

interface PopupState {
  unlocked: boolean;
  expiresAt?: number | null;
  prefs: { serverUrl?: string; email?: string; secretKey?: string };
  items: ExtendedVaultItem[];
  emails: Array<DecryptedEmailPayload & { id: string }>;
  aliasDomain: string;
  pendingCapture?: PendingCredentialCapture | null;
}

interface LoginMatch {
  item: ExtendedVaultItem;
  totpCode: string | null;
  totpRemaining: number;
}

type PopupTab = PersistedPopupTab;

const isPinnedWindow =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('pinned') === '1';

function getHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function matchesHostname(item: ExtendedVaultItem, hostname: string): boolean {
  const cleanHost = hostname.trim().toLowerCase();
  if (!cleanHost) return false;
  if (item.title.toLowerCase().includes(cleanHost)) return true;
  return item.urls.some((u) => {
    try {
      const h = new URL(u.includes('://') ? u : `https://${u}`).hostname.toLowerCase();
      return h === cleanHost || cleanHost.endsWith(`.${h}`) || h.endsWith(`.${cleanHost}`);
    } catch {
      return u.toLowerCase().includes(cleanHost);
    }
  });
}

const CountdownPie: React.FC<{ remaining: number; period: number }> = ({
  remaining,
  period,
}) => {
  const safePeriod = period > 0 ? period : 30;
  const ratio = Math.max(0, Math.min(1, remaining / safePeriod));
  const urgent = remaining <= 5;
  const r = 7;
  const cx = 8;
  const cy = 8;
  const startAngle = -Math.PI / 2;
  const sweepStart = startAngle + (1 - ratio) * 2 * Math.PI;
  const x1 = cx + r * Math.cos(sweepStart);
  const y1 = cy + r * Math.sin(sweepStart);
  const x2 = cx;
  const y2 = cy - r;
  const largeArc = ratio > 0.5 ? 1 : 0;

  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 16 16"
      className={urgent ? 'text-amber-500' : 'text-muted-foreground/75'}
      aria-label={`剩余 ${remaining} 秒`}
    >
      <circle cx={cx} cy={cy} r={r} fill="currentColor" fillOpacity="0.16" />
      {ratio >= 0.999 ? (
        <circle cx={cx} cy={cy} r={r} fill="currentColor" />
      ) : ratio > 0 ? (
        <path
          d={`M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`}
          fill="currentColor"
        />
      ) : null}
    </svg>
  );
};

function formatExpiryLabel(expiresAt?: number | null): string {
  if (!expiresAt) return '仅本次浏览器会话有效';
  const diff = expiresAt - Date.now();
  if (diff <= 0) return '即将过期';
  if (diff >= 86400_000) return `免密剩余约 ${Math.ceil(diff / 86400_000)} 天`;
  if (diff >= 3600_000) return `免密剩余约 ${Math.ceil(diff / 3600_000)} 小时`;
  return `免密剩余约 ${Math.max(1, Math.ceil(diff / 60_000))} 分钟`;
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
  const [unlockDuration, setUnlockDuration] = useState<UnlockDuration>('24h');
  const [activeTab, setActiveTab] = useState<PopupTab>('2fa');
  const [tabLoaded, setTabLoaded] = useState(false);
  const [localFilter, setLocalFilter] = useState('');
  const [activeRowIdx, setActiveRowIdx] = useState<number>(-1);
  const [genLength, setGenLength] = useState<16 | 20 | 32>(20);
  const [generatedPass, setGeneratedPass] = useState(() => generatePassword({ length: 20 }));
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdvancedUnlock, setShowAdvancedUnlock] = useState(false);
  const [inlineBadgeHidden, setInlineBadgeHidden] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [totpCodes, setTotpCodes] = useState<
    Record<string, { code: string; remainingSeconds: number; period: number }>
  >({});

  const filterInputRef = useRef<HTMLInputElement>(null);
  const menuWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void loadThemePreference().then((stored) => {
      setThemePref(stored);
      applyDocumentTheme(stored);
    });
    void loadInlineBadgeHidden().then(setInlineBadgeHidden);
    void loadUnlockDuration().then(setUnlockDuration);
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

  const handleToggleInlineBadge = async () => {
    const nextHidden = !inlineBadgeHidden;
    setInlineBadgeHidden(nextHidden);
    await saveInlineBadgeHidden(nextHidden);
  };

  const selectTab = useCallback((t: PopupTab) => {
    setActiveTab(t);
    setLocalFilter('');
    setShowMenu(false);
  }, []);

  useEffect(() => {
    if (!showMenu) return;
    const onPointerDown = (e: MouseEvent) => {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    };
    window.addEventListener('mousedown', onPointerDown);
    return () => window.removeEventListener('mousedown', onPointerDown);
  }, [showMenu]);

  const loadAll = useCallback(async () => {
    let activeTabInfo: chrome.tabs.Tab | undefined;
    if (isPinnedWindow) {
      const lastFocusedTabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      activeTabInfo = lastFocusedTabs.find((t) =>
        Boolean(t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')))
      );
      if (!activeTabInfo) {
        const allActiveTabs = await chrome.tabs.query({ active: true });
        activeTabInfo = allActiveTabs.find((t) =>
          Boolean(t.url && (t.url.startsWith('http://') || t.url.startsWith('https://')))
        );
      }
    } else {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      activeTabInfo = tabs[0];
    }

    const res = (await chrome.runtime.sendMessage({
      type: 'NONEPWD_GET_STATE',
      tabId: activeTabInfo?.id,
    })) as {
      ok: boolean;
    } & PopupState;
    if (res.ok) {
      setState(res);
      if (res.prefs.serverUrl) setServerUrl(res.prefs.serverUrl);
      if (res.prefs.secretKey) setSecretKey(res.prefs.secretKey);
    }

    let loginsCount = 0;
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
        loginsCount = q.logins.length;
      }
    } else {
      setTabUrl('');
      setTabId(undefined);
      setMatchedLogins([]);
      setLatestOtpEmail(null);
    }

    return { items: res.ok ? res.items : [], loginsCount };
  }, []);

  useEffect(() => {
    void (async () => {
      await loadAll();
      setActiveTab('2fa');
      setTabLoaded(true);
    })();
  }, [loadAll]);

  useEffect(() => {
    if (!isPinnedWindow) return;
    const onFocus = () => void loadAll();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [loadAll]);

  // Live 1s countdown for matched site logins with 2FA
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
        rememberDuration: unlockDuration,
      })) as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(res.error || '解锁失败');
      setMasterPassword('');
      setActiveTab('2fa');
      await loadAll();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const handleLock = async () => {
    setShowMenu(false);
    await chrome.runtime.sendMessage({ type: 'NONEPWD_LOCK' });
    await loadAll();
  };

  const handleOpenPinnedWindow = async () => {
    await chrome.windows.create({
      url: chrome.runtime.getURL('popup.html?pinned=1'),
      type: 'popup',
      width: 386,
      height: 550,
    });
    window.close();
  };

  const handleFillLogin = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_FROM_POPUP', item });
      if (!isPinnedWindow) window.close();
    },
    [tabId]
  );

  const handleFillOtp = useCallback(
    async (code: string) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_OTP_FROM_POPUP', code });
      if (!isPinnedWindow) window.close();
    },
    [tabId]
  );

  const handleFillCard = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_CARD_FROM_POPUP', item });
      if (!isPinnedWindow) window.close();
    },
    [tabId]
  );

  const handleFillCvv = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_CVV_FROM_POPUP', item });
      if (!isPinnedWindow) window.close();
    },
    [tabId]
  );

  const handleFillIdentity = useCallback(
    async (item: ExtendedVaultItem) => {
      if (!tabId) return;
      await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_IDENTITY_FROM_POPUP', item });
      if (!isPinnedWindow) window.close();
    },
    [tabId]
  );

  const handleConfirmSaveCapture = useCallback(async () => {
    const cap = state?.pendingCapture;
    if (!cap) return;
    setBusy(true);
    setErr(null);
    try {
      const res = (await chrome.runtime.sendMessage({
        type: 'NONEPWD_CONFIRM_SAVE_CREDENTIAL',
        captureId: cap.id,
        tabId,
      })) as { ok: boolean; error?: string };
      if (!res.ok) throw new Error(res.error || '保存失败');
      await loadAll();
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [loadAll, state?.pendingCapture, tabId]);

  const handleDismissCapture = useCallback(async () => {
    const cap = state?.pendingCapture;
    if (!cap) return;
    await chrome.runtime.sendMessage({
      type: 'NONEPWD_DISMISS_SAVE_CREDENTIAL',
      captureId: cap.id,
      tabId,
    });
    await loadAll();
  }, [loadAll, state?.pendingCapture, tabId]);

  const cardItems = useMemo(
    () => (state?.items ?? []).filter((i) => i.category === 'card' && Boolean(i.card)),
    [state?.items]
  );

  const identityItems = useMemo(
    () => (state?.items ?? []).filter((i) => i.category === 'identity' && Boolean(i.identity)),
    [state?.items]
  );

  const hasAutofillTab = cardItems.length + identityItems.length > 0;
  const hostname = getHostname(tabUrl);

  const totpItems = useMemo(() => {
    const withTotp = (state?.items ?? []).filter((i) => Boolean(i.totp?.trim()));
    return [...withTotp].sort((a, b) => {
      const aMatch = matchesHostname(a, hostname) ? 0 : 1;
      const bMatch = matchesHostname(b, hostname) ? 0 : 1;
      if (aMatch !== bMatch) return aMatch - bMatch;
      if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
      return a.title.localeCompare(b.title);
    });
  }, [hostname, state?.items]);

  const filteredSiteLogins = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    if (!q || activeTab !== 'site') return matchedLogins;
    return matchedLogins.filter(
      ({ item }) =>
        item.title.toLowerCase().includes(q) ||
        (item.username ?? '').toLowerCase().includes(q) ||
        (item.emailAlias ?? '').toLowerCase().includes(q) ||
        item.urls.some((u) => u.toLowerCase().includes(q))
    );
  }, [activeTab, localFilter, matchedLogins]);

  const filteredTotpItems = useMemo(() => {
    const q = localFilter.trim().toLowerCase();
    if (!q || activeTab !== '2fa') return totpItems;
    return totpItems.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        (i.username ?? '').toLowerCase().includes(q) ||
        i.urls.some((u) => u.toLowerCase().includes(q))
    );
  }, [activeTab, localFilter, totpItems]);

  useEffect(() => {
    if (!state?.unlocked || totpItems.length === 0) {
      setTotpCodes({});
      return;
    }
    let cancelled = false;
    const refreshCodes = async () => {
      const entries = await Promise.all(
        totpItems.map(async (item) => {
          if (!item.totp) return null;
          try {
            const res = await generateTotp(item.totp);
            return [
              item.id,
              { code: res.code, remainingSeconds: res.remainingSeconds, period: res.period },
            ] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const map: Record<string, { code: string; remainingSeconds: number; period: number }> = {};
      for (const e of entries) {
        if (e) map[e[0]] = e[1];
      }
      setTotpCodes(map);
    };
    void refreshCodes();
    const timer = setInterval(() => void refreshCodes(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [state?.unlocked, totpItems]);

  useEffect(() => {
    if (tabLoaded && activeTab === 'autofill' && !hasAutofillTab) {
      setActiveTab('2fa');
    }
  }, [activeTab, hasAutofillTab, tabLoaded]);

  useEffect(() => {
    setActiveRowIdx(-1);
  }, [localFilter, activeTab]);

  const keyboardRowCount =
    activeTab === 'site'
      ? filteredSiteLogins.length
      : activeTab === '2fa'
        ? filteredTotpItems.length
        : activeTab === 'autofill'
          ? cardItems.length + identityItems.length
          : 0;

  useEffect(() => {
    if (!state?.unlocked) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && filterInputRef.current) {
        e.preventDefault();
        filterInputRef.current.focus();
        filterInputRef.current.select();
        return;
      }
      if (e.key === 'Escape' && localFilter) {
        e.preventDefault();
        setLocalFilter('');
        return;
      }
      if (keyboardRowCount === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveRowIdx((prev) => (prev + 1) % keyboardRowCount);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveRowIdx((prev) => (prev <= 0 ? keyboardRowCount - 1 : prev - 1));
      } else if (e.key === 'Enter' && activeRowIdx >= 0 && activeRowIdx < keyboardRowCount) {
        const targetEl = e.target as HTMLElement | null;
        if (targetEl?.tagName === 'BUTTON') return;
        e.preventDefault();
        if (activeTab === 'site') {
          const hit = filteredSiteLogins[activeRowIdx];
          if (hit) void handleFillLogin(hit.item);
        } else if (activeTab === '2fa') {
          const item = filteredTotpItems[activeRowIdx];
          const code = item ? totpCodes[item.id]?.code : undefined;
          if (item && code) void copyValue(`2fa-${item.id}`, code);
        } else if (activeTab === 'autofill') {
          if (activeRowIdx < cardItems.length) {
            void handleFillCard(cardItems[activeRowIdx]);
          } else {
            const idItem = identityItems[activeRowIdx - cardItems.length];
            if (idItem) void handleFillIdentity(idItem);
          }
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    state?.unlocked,
    localFilter,
    keyboardRowCount,
    activeRowIdx,
    activeTab,
    filteredSiteLogins,
    filteredTotpItems,
    totpCodes,
    cardItems,
    identityItems,
    handleFillLogin,
    handleFillCard,
    handleFillIdentity,
  ]);

  const themeIcon =
    themePref === 'dark' ? (
      <Moon className="h-3.5 w-3.5" strokeWidth={1.65} />
    ) : themePref === 'system' ? (
      <Monitor className="h-3.5 w-3.5" strokeWidth={1.65} />
    ) : (
      <Sun className="h-3.5 w-3.5" strokeWidth={1.65} />
    );

  const themeLabel =
    themePref === 'dark' ? '深色模式' : themePref === 'system' ? '跟随系统' : '浅色模式';

  const hasSavedPairing = Boolean(state?.prefs?.serverUrl && state?.prefs?.secretKey);
  const showFullUnlockConfig = !hasSavedPairing || showAdvancedUnlock;

  const renderMonogram = (item: ExtendedVaultItem) => {
    if (item.category === 'card') {
      return (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#2ec252] text-white">
          <CreditCard className="h-4 w-4" strokeWidth={1.65} />
        </div>
      );
    }
    if (item.category === 'identity') {
      return (
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#389be5] text-white">
          <MapPin className="h-4 w-4" strokeWidth={1.65} />
        </div>
      );
    }
    const letter = (item.title.trim().slice(0, 1) || 'N').toUpperCase();
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-[#878c94] text-[15px] font-medium text-white">
        {letter}
      </div>
    );
  };

  if (!state) {
    return (
      <div className="flex h-screen min-h-[520px] w-full items-center justify-center bg-background text-[13px] font-normal text-muted-foreground">
        正在加载 nonepwd...
      </div>
    );
  }

  if (!state.unlocked) {
    const durationOptions: Array<{ id: UnlockDuration; label: string }> = [
      { id: '3h', label: '3 小时' },
      { id: '24h', label: '24 小时' },
      { id: '7d', label: '7 天' },
      { id: 'session', label: '仅本次' },
    ];

    return (
      <div className="flex min-h-[520px] w-full flex-col justify-between bg-background p-6 text-foreground">
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void handleCycleTheme()}
            title={`切换主题（当前：${themeLabel}）`}
            aria-label={`切换主题（当前：${themeLabel}）`}
            className="inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-muted px-3 text-[12px] font-normal text-muted-foreground transition-colors hover:text-foreground"
          >
            {themeIcon}
            <span>{themePref === 'system' ? '系统' : themePref === 'dark' ? '深色' : '浅色'}</span>
          </button>
        </div>

        <div className="mx-auto flex w-full max-w-[312px] flex-col items-center">
          <img
            src="./icons/icon128.png"
            alt="NonePwd"
            draggable={false}
            className="mb-3 h-14 w-14 rounded-[12.5px] shadow-sm"
          />

          <h1 className="text-[19px] font-semibold tracking-tight text-foreground">NonePwd 已锁定</h1>
          <p className="mt-1 mb-5 max-w-full truncate text-[13px] font-normal text-muted-foreground">
            {state.prefs.email || (hasSavedPairing ? '输入主密码以解锁本地加密数据' : '零知识自建密码库')}
          </p>

          {state.pendingCapture && (
            <div className="mb-3 w-full rounded-[12px] bg-primary/10 px-3.5 py-2.5 text-[12px] font-medium text-primary">
              检测到 <span className="font-semibold">{state.pendingCapture.host}</span> 新登录凭据，解锁后即可一键保存
            </div>
          )}

          {err && (
            <div className="mb-3 w-full rounded-[12px] bg-rose-500/10 px-3.5 py-2.5 text-[12px] font-medium text-rose-600 dark:text-rose-400">
              {err}
            </div>
          )}

          <form onSubmit={handleUnlock} className="w-full space-y-2.5">
            {showFullUnlockConfig && (
              <>
                <input
                  type="url"
                  required
                  value={serverUrl}
                  onChange={(e) => setServerUrl(e.target.value)}
                  placeholder="服务端地址 (http://127.0.0.1:8787)"
                  className="h-10 w-full rounded-[10px] border-0 bg-input px-3.5 font-mono text-[13px] font-normal text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:bg-black/[0.085] dark:focus:bg-white/[0.12] focus:ring-0"
                />
                <input
                  type="text"
                  required
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="Secret Key (NP3-...)"
                  className="h-10 w-full rounded-[10px] border-0 bg-input px-3.5 font-mono text-[13px] font-normal text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:bg-black/[0.085] dark:focus:bg-white/[0.12] focus:ring-0"
                />
              </>
            )}

            <input
              type="password"
              required
              autoFocus
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="输入主密码"
              className="h-10 w-full rounded-[10px] border-0 bg-input px-3.5 text-[13.5px] font-normal text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:bg-black/[0.085] dark:focus:bg-white/[0.12] focus:ring-0"
            />

            <div className="space-y-1">
              <div className="flex items-center justify-between px-1 text-[11.5px] text-muted-foreground">
                <span>记住解锁状态</span>
              </div>
              <div className="flex h-8 w-full items-center gap-0.5 rounded-[9px] bg-muted p-0.5 text-[12px]">
                {durationOptions.map((opt) => {
                  const selected = unlockDuration === opt.id;
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        setUnlockDuration(opt.id);
                        void saveUnlockDuration(opt.id);
                      }}
                      className={`flex h-full flex-1 items-center justify-center rounded-[7px] transition-all ${
                        selected
                          ? 'bg-background font-medium text-foreground shadow-xs'
                          : 'font-normal text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="submit"
              disabled={busy}
              className="flex h-10 w-full items-center justify-center gap-1.5 rounded-[10px] bg-primary px-4 text-[13.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              <span>{busy ? '正在解锁...' : '解锁密码库'}</span>
            </button>
          </form>

          {hasSavedPairing && (
            <button
              type="button"
              onClick={() => setShowAdvancedUnlock((prev) => !prev)}
              className="mt-3 text-[12px] font-normal text-muted-foreground transition-colors hover:text-foreground"
            >
              {showAdvancedUnlock ? '收起设置' : '切换账号或服务器设置'}
            </button>
          )}
        </div>

        <div className="text-center font-mono text-[10.5px] text-muted-foreground/75">
          End-to-End Encrypted · Local Session
        </div>
      </div>
    );
  }

  const tabs: Array<{ id: PopupTab; label: string; dot?: boolean }> = [
    {
      id: '2fa',
      label: totpItems.length > 0 ? `验证码 ${totpItems.length}` : '验证码',
    },
    {
      id: 'site',
      label: matchedLogins.length > 0 ? `当前匹配 ${matchedLogins.length}` : '当前匹配',
      dot: Boolean(state.pendingCapture && activeTab !== 'site'),
    },
    ...(hasAutofillTab ? [{ id: 'autofill' as const, label: '卡片地址' }] : []),
    { id: 'generator', label: '生成密码' },
  ];

  const showSiteFilter = activeTab === 'site' && matchedLogins.length > 6;
  const showTotpFilter = activeTab === '2fa' && totpItems.length > 6;

  return (
    <div className="relative flex h-screen min-h-[520px] w-full flex-col bg-background text-foreground">
      {/* Top Frosted Borderless Bar */}
      <header className="relative flex h-12 shrink-0 items-center justify-between bg-background/85 px-4 backdrop-blur-md">
        <div className="flex min-w-0 items-center gap-2">
          <img
            src="./icons/icon128.png"
            alt="NonePwd"
            draggable={false}
            className="h-7 w-7 shrink-0 rounded-[6.5px]"
          />
          <span className="text-[14.5px] font-semibold tracking-tight text-foreground">
            NonePwd
          </span>
          {hostname && (
            <span className="max-w-[140px] truncate rounded-[7px] bg-muted px-2 py-0.5 font-mono text-[11px] font-normal text-muted-foreground">
              {hostname}
            </span>
          )}
        </div>
        <div ref={menuWrapRef} className="relative flex items-center gap-1.5">
          {!isPinnedWindow && (
            <button
              type="button"
              onClick={() => void handleOpenPinnedWindow()}
              className="inline-flex h-7 w-7 items-center justify-center rounded-[7px] bg-muted/65 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="独立小窗常驻（点击网页不自动关闭，适合常驻看 2FA）"
              aria-label="独立小窗常驻"
            >
              <Pin className="h-3.5 w-3.5" strokeWidth={1.65} />
            </button>
          )}
          <button
            type="button"
            onClick={() => setShowMenu((prev) => !prev)}
            className={`inline-flex h-7 w-7 items-center justify-center rounded-[7px] transition-colors ${
              showMenu
                ? 'bg-muted text-foreground'
                : 'bg-muted/65 text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
            title="更多操作与设置"
            aria-label="更多操作与设置"
          >
            <MoreHorizontal className="h-4 w-4" strokeWidth={1.65} />
          </button>

          {showMenu && (
            <div className="absolute right-0 top-9 z-50 w-52 rounded-[12px] bg-background p-1.5 shadow-lg ring-1 ring-black/8 dark:ring-white/12">
              <div className="px-2.5 py-1.5 text-[11px] font-normal text-muted-foreground">
                {formatExpiryLabel(state.expiresAt)}
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowMenu(false);
                  void chrome.runtime.sendMessage({ type: 'NONEPWD_SYNC' }).then(() => loadAll());
                }}
                className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] font-normal text-foreground transition-colors hover:bg-muted"
              >
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.65} />
                <span>立即同步数据</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleToggleInlineBadge();
                }}
                className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] font-normal text-foreground transition-colors hover:bg-muted"
              >
                {inlineBadgeHidden ? (
                  <EyeOff className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.65} />
                ) : (
                  <Eye className="h-3.5 w-3.5 text-primary" strokeWidth={1.65} />
                )}
                <span>网页悬浮图标：{inlineBadgeHidden ? '已隐藏' : '已开启'}</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  void handleCycleTheme();
                }}
                className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] font-normal text-foreground transition-colors hover:bg-muted"
              >
                {themeIcon}
                <span>外观主题：{themeLabel}</span>
              </button>
              <div className="my-1 h-px bg-border" />
              <button
                type="button"
                onClick={() => void handleLock()}
                className="flex w-full items-center gap-2 rounded-[8px] px-2.5 py-1.5 text-left text-[12.5px] font-normal text-rose-600 transition-colors hover:bg-rose-500/10 dark:text-rose-400"
              >
                <Lock className="h-3.5 w-3.5" strokeWidth={1.65} />
                <span>立即锁定密码库</span>
              </button>
            </div>
          )}
        </div>
      </header>

      {/* Full-Width 38px Concentric Segmented Tab Bar */}
      <div className="shrink-0 px-4 pb-3">
        <div className="flex h-9.5 w-full items-center gap-1 rounded-[10px] bg-muted p-1">
          {tabs.map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTab(t.id)}
                className={`flex h-full flex-1 items-center justify-center gap-1 rounded-[8px] px-2 text-[13px] transition-all ${
                  active
                    ? 'bg-background font-medium text-foreground shadow-xs'
                    : 'font-normal text-muted-foreground hover:text-foreground'
                }`}
              >
                <span className="truncate">{t.label}</span>
                {t.dot && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}
              </button>
            );
          })}
        </div>
      </div>

      {/* Single Active Tab Body */}
      <div className="flex-1 space-y-2.5 overflow-y-auto px-4 pb-4">
        {/* Contextual Pending Save Banner (only in 当前匹配 tab) */}
        {state.pendingCapture && activeTab === 'site' && (
          <div className="flex items-center justify-between gap-2 rounded-[12px] bg-primary/10 px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="truncate text-[13px] font-medium text-primary">
                {state.pendingCapture.mode === 'update'
                  ? '检测到新密码，是否更新？'
                  : '检测到新登录账号，是否保存？'}
              </div>
              <div className="truncate text-[12px] font-normal text-muted-foreground">
                {state.pendingCapture.host} · {state.pendingCapture.username || '无用户名'}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmSaveCapture()}
                className="h-7.5 rounded-[8px] bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {state.pendingCapture.mode === 'update' ? '更新' : '保存'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleDismissCapture()}
                className="h-7.5 rounded-[8px] bg-background/85 px-3 text-[12.5px] font-normal text-muted-foreground transition-colors hover:text-foreground"
              >
                忽略
              </button>
            </div>
          </div>
        )}

        {/* Contextual Live Email OTP Banner */}
        {latestOtpEmail?.otpCode && (activeTab === 'site' || activeTab === '2fa') && (
          <div className="flex items-center justify-between gap-2 rounded-[12px] bg-emerald-500/10 px-3.5 py-2.5">
            <div className="min-w-0">
              <div className="flex items-center gap-1 text-[11.5px] font-medium text-emerald-700 dark:text-emerald-400">
                <MailCheck className="h-3.5 w-3.5 shrink-0" strokeWidth={1.65} />
                <span className="truncate">邮箱验证码 · {latestOtpEmail.senderDomain}</span>
              </div>
              <div className="font-mono text-[20px] font-semibold tracking-widest text-foreground">
                {latestOtpEmail.otpCode}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {tabId && (
                <button
                  type="button"
                  onClick={() => void handleFillOtp(latestOtpEmail.otpCode!)}
                  className="h-7.5 rounded-[8px] bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
                >
                  填入
                </button>
              )}
              <button
                type="button"
                onClick={() => void copyValue('email-otp', latestOtpEmail.otpCode!)}
                className="inline-flex h-7.5 w-7.5 items-center justify-center rounded-[8px] bg-background/85 text-foreground transition-colors hover:bg-muted"
                title="复制验证码"
              >
                {copiedId === 'email-otp' ? (
                  <Check className="h-4 w-4 text-emerald-600" strokeWidth={1.65} />
                ) : (
                  <Copy className="h-4 w-4" strokeWidth={1.65} />
                )}
              </button>
            </div>
          </div>
        )}

        {/* Optional Local Filter Bar (only when list > 6 entries) */}
        {(showSiteFilter || showTotpFilter) && (
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              strokeWidth={1.65}
            />
            <input
              ref={filterInputRef}
              type="text"
              value={localFilter}
              onChange={(e) => setLocalFilter(e.target.value)}
              placeholder={
                activeTab === '2fa'
                  ? `筛选 ${totpItems.length} 个 2FA 验证码 (⌘K)`
                  : `筛选当前网站的 ${matchedLogins.length} 个账号 (⌘K)`
              }
              className="h-9.5 w-full rounded-[10px] border-0 bg-muted pl-10 pr-8 text-[13px] font-normal text-foreground outline-none transition-colors placeholder:text-muted-foreground/75 focus:bg-black/[0.085] dark:focus:bg-white/[0.12] focus:ring-0"
            />
            {localFilter && (
              <button
                type="button"
                onClick={() => setLocalFilter('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="清除筛选"
              >
                <X className="h-4 w-4" strokeWidth={1.65} />
              </button>
            )}
          </div>
        )}

        {/* Tab 2: Current Site Matched Logins */}
        {activeTab === 'site' && (
          <section aria-label="当前匹配" className="space-y-2">
            {filteredSiteLogins.length === 0 ? (
              <div className="rounded-[12px] bg-card px-4 py-10 text-center">
                <Globe className="mx-auto mb-2.5 h-6 w-6 text-muted-foreground/65" strokeWidth={1.65} />
                <div className="text-[13.5px] font-medium text-foreground">
                  {localFilter.trim()
                    ? '没有匹配的当前网站账号'
                    : hostname
                      ? `${hostname} 暂无已保存账号`
                      : '当前标签页暂无匹配账号'}
                </div>
                <p className="mt-1.5 text-[12px] font-normal leading-relaxed text-muted-foreground">
                  首次在网页登录新账号时将自动提示保存；如需查找全部密码库条目，请在 NonePwd 桌面端查看。
                </p>
              </div>
            ) : (
              filteredSiteLogins.map(({ item, totpCode, totpRemaining }, idx) => (
                <div
                  key={item.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => void handleFillLogin(item)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      void handleFillLogin(item);
                    }
                  }}
                  className={`w-full cursor-pointer rounded-[12px] p-3.5 transition-colors ${
                    idx === activeRowIdx ? 'bg-primary/12' : 'bg-card hover:bg-muted/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2.5">
                    <div className="flex min-w-0 items-center gap-3">
                      {renderMonogram(item)}
                      <div className="min-w-0">
                        <div className="truncate text-[13.5px] font-medium text-foreground">
                          {item.title}
                        </div>
                        <div className="truncate text-[12px] font-normal text-muted-foreground">
                          {item.username || item.emailAlias || '无用户名'}
                        </div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void handleFillLogin(item);
                      }}
                      className="h-8 shrink-0 rounded-[8px] bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
                    >
                      填充
                    </button>
                  </div>

                  {totpCode && (
                    <div
                      className="mt-2.5 flex items-center justify-between gap-2 pt-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[14px] font-medium tracking-wider text-primary">
                          {totpCode}
                        </span>
                        <CountdownPie remaining={totpRemaining} period={30} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        {tabId && (
                          <button
                            type="button"
                            onClick={() => void handleFillOtp(totpCode)}
                            className="h-7 rounded-[7px] bg-background/90 px-2.5 text-[12px] font-medium text-foreground transition-colors hover:bg-background"
                          >
                            填 2FA
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => void copyValue(`totp-${item.id}`, totpCode)}
                          className="h-7 rounded-[7px] bg-background/90 px-2.5 text-[12px] font-normal text-muted-foreground transition-colors hover:text-foreground"
                        >
                          {copiedId === `totp-${item.id}` ? '已复制' : '复制'}
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))
            )}
          </section>
        )}

        {/* Tab 1: Persistent Authenticator-Style 2FA Codes */}
        {activeTab === '2fa' && (
          <section aria-label="验证码" className="space-y-2">
            {filteredTotpItems.length === 0 ? (
              <div className="rounded-[12px] bg-card px-4 py-10 text-center text-[13px] font-normal text-muted-foreground">
                <ShieldCheck className="mx-auto mb-2 h-6 w-6 text-muted-foreground/65" strokeWidth={1.65} />
                {localFilter.trim() ? '没有找到匹配的 2FA 验证码' : '暂无 2FA 验证器密钥'}
              </div>
            ) : (
              filteredTotpItems.map((it, idx) => {
                const entry = totpCodes[it.id];
                const code = entry?.code ?? '••••••';
                const remaining = entry?.remainingSeconds ?? 30;
                const period = entry?.period ?? 30;
                const isCopied = copiedId === `2fa-${it.id}`;

                return (
                  <div
                    key={it.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (entry?.code) void copyValue(`2fa-${it.id}`, entry.code);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        if (entry?.code) void copyValue(`2fa-${it.id}`, entry.code);
                      }
                    }}
                    className={`w-full cursor-pointer select-none rounded-[12px] px-4 py-3.5 transition-colors ${
                      idx === activeRowIdx ? 'bg-primary/12' : 'bg-card hover:bg-muted/75'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[13.5px] font-medium text-foreground">
                        {it.title}
                      </span>
                      <div className="flex shrink-0 items-center gap-1.5">
                        {isCopied && (
                          <span className="text-[12px] font-medium text-emerald-600 dark:text-emerald-400">
                            已复制 ✓
                          </span>
                        )}
                        {tabId && entry?.code && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleFillOtp(entry.code);
                            }}
                            className="h-7 rounded-[7px] bg-background px-3 text-[12px] font-medium text-foreground shadow-2xs transition-colors hover:bg-background/80"
                          >
                            填入
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="my-1 font-mono text-[26px] font-semibold leading-[1.15] tracking-[0.06em] text-primary">
                      {code}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-[12px] font-normal text-muted-foreground">
                        {it.username || it.emailAlias || '点击卡片复制验证码'}
                      </span>
                      <CountdownPie remaining={remaining} period={period} />
                    </div>
                  </div>
                );
              })
            )}
          </section>
        )}

        {/* Tab 3: Cards & Identities Autofill */}
        {activeTab === 'autofill' && hasAutofillTab && (
          <section aria-label="卡片地址" className="space-y-3">
            {cardItems.length > 0 && (
              <div className="space-y-1.5">
                <div className="px-1 text-[12px] font-medium text-muted-foreground">银行卡</div>
                {cardItems.map((it, idx) => {
                  const { label } = formatCardDisplay(it.card, it.title);
                  const exp = formatCardExpiry(it.card?.expMonth, it.card?.expYear);
                  const sub = [it.title, it.card?.cardholderName, exp].filter(Boolean).join(' · ');
                  return (
                    <div
                      key={it.id}
                      className={`flex w-full items-center justify-between gap-2 rounded-[12px] px-3.5 py-2.5 transition-colors ${
                        idx === activeRowIdx ? 'bg-primary/12' : 'bg-card'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {renderMonogram(it)}
                        <div className="min-w-0">
                          <div className="truncate font-mono text-[13.5px] font-medium text-foreground">
                            {label}
                          </div>
                          <div className="truncate text-[12px] font-normal text-muted-foreground">
                            {sub}
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleFillCard(it)}
                          className="h-8 rounded-[8px] bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
                        >
                          填充
                        </button>
                        {it.card?.cvv && (
                          <button
                            type="button"
                            onClick={() => void handleFillCvv(it)}
                            title="点击单独填入安全码 (CVV)"
                            className="h-8 rounded-[8px] bg-background/85 px-2.5 font-mono text-[12px] font-medium text-foreground transition-colors hover:bg-muted"
                          >
                            CVV
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {identityItems.length > 0 && (
              <div className="space-y-1.5">
                <div className="px-1 text-[12px] font-medium text-muted-foreground">身份与地址</div>
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
                      className={`flex w-full items-center justify-between gap-2 rounded-[12px] px-3.5 py-2.5 transition-colors ${
                        idx + cardItems.length === activeRowIdx ? 'bg-primary/12' : 'bg-card'
                      }`}
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        {renderMonogram(it)}
                        <div className="min-w-0">
                          <div className="truncate text-[13.5px] font-medium text-foreground">
                            {title}
                          </div>
                          <div className="truncate text-[12px] font-normal text-muted-foreground">
                            {sub}
                          </div>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleFillIdentity(it)}
                        className="h-8 shrink-0 rounded-[8px] bg-primary px-3.5 text-[12.5px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
                      >
                        填充
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* Tab 4: Random Password Generator */}
        {activeTab === 'generator' && (
          <section aria-label="生成密码" className="w-full space-y-3 rounded-[12px] bg-card p-4">
            <div className="flex h-9.5 w-full items-center gap-1 rounded-[10px] bg-background p-1">
              {([16, 20, 32] as const).map((len) => {
                const selected = genLength === len;
                return (
                  <button
                    key={len}
                    type="button"
                    onClick={() => {
                      setGenLength(len);
                      setGeneratedPass(generatePassword({ length: len }));
                    }}
                    className={`flex h-full flex-1 items-center justify-center rounded-[8px] text-[13px] transition-all ${
                      selected
                        ? 'bg-muted font-medium text-foreground shadow-xs'
                        : 'font-normal text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {len} 位
                  </button>
                );
              })}
            </div>

            <code className="block w-full break-all rounded-[10px] bg-background px-4 py-3 font-mono text-[13.5px] font-normal text-foreground">
              {generatedPass}
            </code>

            <div className="flex w-full items-center gap-2">
              <button
                type="button"
                onClick={() => setGeneratedPass(generatePassword({ length: genLength }))}
                className="flex h-10 flex-1 items-center justify-center gap-1.5 rounded-[10px] bg-background text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Dices className="h-4 w-4" strokeWidth={1.65} />
                换一个
              </button>
              <button
                type="button"
                onClick={() => void copyValue('gen-pass', generatedPass)}
                className="flex h-10 flex-[1.6] items-center justify-center gap-1.5 rounded-[10px] bg-primary text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
              >
                {copiedId === 'gen-pass' ? (
                  <>
                    <Check className="h-4 w-4" strokeWidth={1.65} />
                    已复制到剪贴板
                  </>
                ) : (
                  <>
                    <Copy className="h-4 w-4" strokeWidth={1.65} />
                    复制密码
                  </>
                )}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
};
