import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Copy,
  Dices,
  ExternalLink,
  KeyRound,
  Lock,
  MailCheck,
  RefreshCw,
  Search,
  ShieldCheck,
} from 'lucide-react';
import {
  generatePassword,
  generateTotp,
  type DecryptedEmailPayload,
  type VaultItemPayload,
} from '@nonepwd/core';

interface PopupState {
  unlocked: boolean;
  prefs: { serverUrl?: string; email?: string; secretKey?: string };
  items: VaultItemPayload[];
  emails: Array<DecryptedEmailPayload & { id: string }>;
  aliasDomain: string;
}

export const PopupApp: React.FC = () => {
  const [state, setState] = useState<PopupState | null>(null);
  const [tabUrl, setTabUrl] = useState('');
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [matchedLogins, setMatchedLogins] = useState<
    Array<{ item: VaultItemPayload; totpCode: string | null; totpRemaining: number }>
  >([]);
  const [latestOtpEmail, setLatestOtpEmail] = useState<
    (DecryptedEmailPayload & { id: string }) | null
  >(null);

  const [serverUrl, setServerUrl] = useState('http://127.0.0.1:8787');
  const [secretKey, setSecretKey] = useState('');
  const [masterPassword, setMasterPassword] = useState('');
  const [search, setSearch] = useState('');
  const [generatedPass, setGeneratedPass] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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
    const activeTab = tabs[0];
    if (activeTab?.url) {
      setTabUrl(activeTab.url);
      setTabId(activeTab.id);
      const q = (await chrome.runtime.sendMessage({
        type: 'NONEPWD_QUERY_TAB',
        url: activeTab.url,
        tabId: activeTab.id,
      })) as {
        ok: boolean;
        logins: Array<{ item: VaultItemPayload; totpCode: string | null; totpRemaining: number }>;
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

  const copyValue = async (id: string, val: string) => {
    await navigator.clipboard.writeText(val);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 1200);
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

  const handleFillItem = async (item: VaultItemPayload) => {
    if (!tabId) return;
    await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_FROM_POPUP', item });
    window.close();
  };

  const handleFillOtp = async (code: string) => {
    if (!tabId) return;
    await chrome.tabs.sendMessage(tabId, { type: 'NONEPWD_FILL_OTP_FROM_POPUP', code });
    window.close();
  };

  const filteredSearchItems = useMemo(() => {
    if (!state?.items) return [];
    const q = search.trim().toLowerCase();
    if (!q) return state.items.slice(0, 8);
    return state.items
      .filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          (i.username ?? '').toLowerCase().includes(q) ||
          i.urls.some((u) => u.toLowerCase().includes(q))
      )
      .slice(0, 10);
  }, [search, state?.items]);

  if (!state) {
    return (
      <div className="flex h-[460px] items-center justify-center text-xs text-slate-400">
        正在加载 nonepwd...
      </div>
    );
  }

  if (!state.unlocked) {
    return (
      <div className="p-5">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white">解锁 nonepwd 插件</h1>
            <p className="text-[11px] text-slate-400">连接你的自建零知识服务端</p>
          </div>
        </div>

        {err && (
          <div className="mb-3 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-[11px] text-rose-300">
            {err}
          </div>
        )}

        <form onSubmit={handleUnlock} className="space-y-3">
          <div>
            <label className="mb-1 block text-[11px] text-slate-400">服务端地址</label>
            <input
              type="url"
              required
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-[#121622] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-slate-400">Secret Key (NP3-...)</label>
            <input
              type="text"
              required
              value={secretKey}
              onChange={(e) => setSecretKey(e.target.value)}
              placeholder="NP3-XXXXXX-..."
              className="w-full rounded-lg border border-slate-700 bg-[#121622] px-3 py-2 font-mono text-[11px] text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-slate-400">主密码</label>
            <input
              type="password"
              required
              autoFocus
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="输入主密码解锁"
              className="w-full rounded-lg border border-slate-700 bg-[#121622] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <KeyRound className="h-3.5 w-3.5" />
            <span>{busy ? '正在解锁...' : '解锁密码库'}</span>
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="flex h-[500px] flex-col">
      {/* Top Bar */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-[#10141f] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-indigo-400" />
          <span className="text-xs font-semibold text-white">nonepwd</span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              void chrome.runtime.sendMessage({ type: 'NONEPWD_SYNC' }).then(() => loadAll())
            }
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            title="立即同步"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void chrome.tabs.create({ url: `${serverUrl.replace(/\/+$/, '')}/vault` })}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
            title="打开 Web 管理台"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => void handleLock()}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-rose-400"
            title="锁定"
          >
            <Lock className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3">
        {/* Live Email OTP Banner */}
        {latestOtpEmail?.otpCode && (
          <div className="flex items-center justify-between rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
            <div>
              <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-300">
                <MailCheck className="h-3 w-3" />
                <span>最新邮箱验证码 · {latestOtpEmail.senderDomain}</span>
              </div>
              <div className="font-mono text-lg font-bold tracking-widest text-white">
                {latestOtpEmail.otpCode}
              </div>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => void handleFillOtp(latestOtpEmail.otpCode!)}
                className="rounded-lg bg-emerald-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-emerald-500"
              >
                填入页面
              </button>
              <button
                type="button"
                onClick={() => void copyValue('email-otp', latestOtpEmail.otpCode!)}
                className="rounded-lg border border-slate-700 bg-slate-800 p-1.5 text-slate-200"
              >
                {copiedId === 'email-otp' ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </button>
            </div>
          </div>
        )}

        {/* Current Page Matches */}
        <div>
          <div className="mb-1.5 flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            <span>当前网页匹配 ({matchedLogins.length})</span>
            <span className="max-w-[160px] truncate text-slate-500">
              {tabUrl ? new URL(tabUrl).hostname : ''}
            </span>
          </div>

          {matchedLogins.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-800 p-3 text-center text-[11px] text-slate-500">
              暂无匹配当前站点的条目
            </div>
          ) : (
            <div className="space-y-1.5">
              {matchedLogins.map(({ item, totpCode }) => (
                <div
                  key={item.id}
                  className="rounded-xl border border-slate-800 bg-[#121622] p-2.5"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-xs font-semibold text-white">{item.title}</div>
                      <div className="truncate text-[11px] text-slate-400">
                        {item.username || item.emailAlias}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleFillItem(item)}
                      className="rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-indigo-500"
                    >
                      填充
                    </button>
                  </div>

                  {totpCode && (
                    <div className="mt-2 flex items-center justify-between border-t border-slate-800/80 pt-2">
                      <span className="font-mono text-xs font-bold text-indigo-300">
                        2FA: {totpCode}
                      </span>
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => void handleFillOtp(totpCode)}
                          className="rounded bg-indigo-500/20 px-2 py-0.5 text-[10px] text-indigo-200"
                        >
                          填 2FA
                        </button>
                        <button
                          type="button"
                          onClick={() => void copyValue(`totp-${item.id}`, totpCode)}
                          className="rounded bg-slate-800 px-2 py-0.5 text-[10px] text-slate-300"
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

        {/* All Items Search */}
        <div>
          <div className="relative mb-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索全部密码条目..."
              className="w-full rounded-lg border border-slate-800 bg-[#121622] py-1.5 pl-8 pr-3 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>
          <div className="space-y-1">
            {filteredSearchItems.map((it) => (
              <div
                key={it.id}
                className="flex items-center justify-between rounded-lg bg-[#121622]/70 px-2.5 py-2 text-xs"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium text-slate-200">{it.title}</div>
                  <div className="truncate text-[10px] text-slate-500">{it.username}</div>
                </div>
                <div className="flex gap-1">
                  {it.password && (
                    <button
                      type="button"
                      onClick={() => void copyValue(`pw-${it.id}`, it.password!)}
                      className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 hover:border-indigo-500/50"
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
                      className="rounded border border-slate-700 px-2 py-0.5 text-[10px] text-indigo-300"
                    >
                      {copiedId === `otp-${it.id}` ? '已复制' : '2FA'}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Quick Password Generator Footer */}
      <div className="border-t border-slate-800 bg-[#10141f] p-2.5">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setGeneratedPass(generatePassword({ length: 20 }))}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:border-indigo-500/60"
          >
            <Dices className="h-3.5 w-3.5 text-indigo-400" />
            随机密码
          </button>
          {generatedPass && (
            <>
              <code className="flex-1 truncate rounded bg-[#0b0e14] px-2 py-1 font-mono text-[11px] text-indigo-200">
                {generatedPass}
              </code>
              <button
                type="button"
                onClick={() => void copyValue('gen-pass', generatedPass)}
                className="rounded-lg bg-indigo-600 px-2 py-1 text-[11px] text-white"
              >
                {copiedId === 'gen-pass' ? '已复制' : '复制'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
