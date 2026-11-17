import React, { useEffect, useMemo, useState } from 'react';
import { Cloud, Filter, Inbox, Plus, RefreshCw, Save, TestTube2, Trash2 } from 'lucide-react';
import { randomId } from '@nonepwd/core';
import {
  useVault,
  type EmailFilterConfig,
  type EmailFilterField,
  type EmailFilterMode,
  type EmailFilterRule,
} from '../state/VaultContext';
import { CopyButton } from './CopyButton';

const DEFAULT_FILTER: EmailFilterConfig = {
  enabled: false,
  otpOnly: false,
  mode: 'allow',
  rules: [],
};

const FIELD_LABELS: Record<EmailFilterField, string> = {
  from: '发件人 (From)',
  to: '收件人 (To)',
  subject: '主题 (Subject)',
  body: '正文 (Body)',
};

function validateRegex(pattern: string): { regex: RegExp | null; error: string | null } {
  if (!pattern.trim()) {
    return { regex: null, error: '请输入正则表达式' };
  }
  try {
    return { regex: new RegExp(pattern), error: null };
  } catch (err) {
    return {
      regex: null,
      error: err instanceof Error ? err.message : '无效的正则表达式',
    };
  }
}

export const SettingsView: React.FC = () => {
  const {
    account,
    imapConfig,
    updateSettings,
    saveImapConfig,
    testImapConfig,
    getEmailFilter,
    saveEmailFilter,
  } = useVault();

  const [aliasDomain, setAliasDomain] = useState(account?.aliasDomain ?? '');
  const [savingAlias, setSavingAlias] = useState(false);

  const [imapEnabled, setImapEnabled] = useState(imapConfig?.enabled ?? false);
  const [imapHost, setImapHost] = useState(imapConfig?.host ?? 'imap.gmail.com');
  const [imapPort, setImapPort] = useState(imapConfig?.port ?? 993);
  const [imapTls, setImapTls] = useState(imapConfig?.tls ?? true);
  const [imapUser, setImapUser] = useState(imapConfig?.username ?? '');
  const [imapPass, setImapPass] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [savingImap, setSavingImap] = useState(false);

  const [filterConfig, setFilterConfig] = useState<EmailFilterConfig>(DEFAULT_FILTER);
  const [filterLoading, setFilterLoading] = useState(true);
  const [filterSaving, setFilterSaving] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [sampleField, setSampleField] = useState<EmailFilterField | 'all'>('all');
  const [sampleText, setSampleText] = useState('');

  useEffect(() => {
    let cancelled = false;
    setFilterLoading(true);
    setFilterError(null);
    void getEmailFilter()
      .then((data) => {
        if (cancelled) return;
        setFilterConfig({
          enabled: Boolean(data.enabled),
          otpOnly: Boolean(data.otpOnly),
          mode: data.mode === 'deny' ? 'deny' : 'allow',
          rules: Array.isArray(data.rules) ? data.rules : [],
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setFilterError(err instanceof Error ? err.message : '加载邮件过滤配置失败');
      })
      .finally(() => {
        if (!cancelled) setFilterLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [getEmailFilter]);

  const ruleValidations = useMemo(
    () =>
      filterConfig.rules.map((rule) => {
        const { regex, error } = validateRegex(rule.pattern);
        const matchesSample =
          Boolean(sampleText) &&
          rule.enabled &&
          regex !== null &&
          (sampleField === 'all' || sampleField === rule.field) &&
          regex.test(sampleText);
        return { id: rule.id, regex, error, matchesSample };
      }),
    [filterConfig.rules, sampleField, sampleText]
  );

  const hasInvalidRegex = ruleValidations.some((v) => v.error !== null);

  const sampleOutcome = useMemo(() => {
    if (!sampleText) return null;
    const applicable = filterConfig.rules.filter(
      (r) => r.enabled && (sampleField === 'all' || sampleField === r.field)
    );
    const anyMatch = ruleValidations.some((v) => v.matchesSample);
    if (!filterConfig.enabled) {
      return { allowed: true, reason: '过滤未启用，所有邮件均接收' };
    }
    if (filterConfig.mode === 'allow') {
      if (applicable.length === 0) {
        return { allowed: false, reason: '白名单模式且无匹配字段的启用规则：将拦截' };
      }
      return anyMatch
        ? { allowed: true, reason: '命中白名单规则：将接收' }
        : { allowed: false, reason: '未命中任何白名单规则：将拦截' };
    }
    return anyMatch
      ? { allowed: false, reason: '命中黑名单规则：将拦截' }
      : { allowed: true, reason: '未命中黑名单规则：将接收' };
  }, [filterConfig.enabled, filterConfig.mode, filterConfig.rules, ruleValidations, sampleField, sampleText]);

  const handleAddRule = () => {
    setFilterNotice(null);
    setFilterError(null);
    setFilterConfig((prev) => ({
      ...prev,
      rules: [
        ...prev.rules,
        { id: randomId(), field: 'from', pattern: '', enabled: true },
      ],
    }));
  };

  const handleUpdateRule = (id: string, patch: Partial<EmailFilterRule>) => {
    setFilterNotice(null);
    setFilterError(null);
    setFilterConfig((prev) => ({
      ...prev,
      rules: prev.rules.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }));
  };

  const handleRemoveRule = (id: string) => {
    setFilterNotice(null);
    setFilterError(null);
    setFilterConfig((prev) => ({
      ...prev,
      rules: prev.rules.filter((r) => r.id !== id),
    }));
  };

  const handleSaveFilter = async (e: React.FormEvent) => {
    e.preventDefault();
    setFilterError(null);
    setFilterNotice(null);
    if (hasInvalidRegex) {
      setFilterError('请先修正无效或为空的正则表达式后再保存');
      return;
    }
    setFilterSaving(true);
    try {
      const saved = await saveEmailFilter(filterConfig);
      setFilterConfig({
        enabled: Boolean(saved.enabled),
        otpOnly: Boolean(saved.otpOnly),
        mode: saved.mode === 'deny' ? 'deny' : 'allow',
        rules: Array.isArray(saved.rules) ? saved.rules : [],
      });
      setFilterNotice('邮件过滤规则已保存');
    } catch (err) {
      setFilterError(err instanceof Error ? err.message : '保存过滤规则失败');
    } finally {
      setFilterSaving(false);
    }
  };

  const handleSaveAliasDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAlias(true);
    try {
      await updateSettings({ aliasDomain });
    } finally {
      setSavingAlias(false);
    }
  };

  const handleSaveImap = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingImap(true);
    try {
      await saveImapConfig({
        enabled: imapEnabled,
        host: imapHost,
        port: Number(imapPort),
        tls: imapTls,
        username: imapUser,
        password: imapPass || undefined,
      });
      setImapPass('');
    } finally {
      setSavingImap(false);
    }
  };

  const handleTestImap = async () => {
    setTestResult('正在连接 IMAP 服务器...');
    try {
      const res = await testImapConfig({
        host: imapHost,
        port: Number(imapPort),
        tls: imapTls,
        username: imapUser,
        password: imapPass || undefined,
      });
      setTestResult(
        res.ok ? `连接成功，INBOX 当前共有 ${res.messages ?? 0} 封邮件。` : `连接失败：${res.error}`
      );
    } catch (err) {
      setTestResult(err instanceof Error ? err.message : '测试连接失败');
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">设置</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            管理 IMAP 收信、邮件过滤规则与域名邮箱别名参数。
          </p>
        </div>

        {/* Email Filter Card */}
        <form
          onSubmit={handleSaveFilter}
          className="space-y-4 rounded-xl border border-border bg-card p-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Filter className="h-4 w-4 text-muted-foreground" />
              邮件过滤规则
            </h3>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-foreground select-none">
              <input
                type="checkbox"
                checked={filterConfig.enabled}
                onChange={(e) => {
                  setFilterNotice(null);
                  setFilterConfig((p) => ({ ...p, enabled: e.target.checked }));
                }}
                className="h-3.5 w-3.5 rounded border-input accent-primary"
              />
              <span>启用邮件过滤</span>
            </label>
          </div>

          {filterError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              {filterError}
            </div>
          )}

          {filterNotice && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              {filterNotice}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">过滤模式</label>
              <select
                value={filterConfig.mode}
                onChange={(e) => {
                  setFilterNotice(null);
                  setFilterConfig((p) => ({
                    ...p,
                    mode: e.target.value as EmailFilterMode,
                  }));
                }}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              >
                <option value="allow">白名单 (Allow) — 仅保留匹配规则的邮件</option>
                <option value="deny">黑名单 (Deny) — 拦截匹配规则的邮件</option>
              </select>
            </div>

            <div className="flex items-end pb-1.5">
              <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground select-none">
                <input
                  type="checkbox"
                  checked={filterConfig.otpOnly}
                  onChange={(e) => {
                    setFilterNotice(null);
                    setFilterConfig((p) => ({ ...p, otpOnly: e.target.checked }));
                  }}
                  className="h-3.5 w-3.5 rounded border-input accent-primary"
                />
                <span>仅接收包含验证码 (OTP) 的邮件</span>
              </label>
            </div>
          </div>

          {/* Rules */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                正则规则（{filterConfig.rules.length}）
              </span>
              <button
                type="button"
                onClick={handleAddRule}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
              >
                <Plus className="h-3 w-3" />
                添加规则
              </button>
            </div>

            {filterLoading ? (
              <div className="rounded-lg border border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                正在加载过滤规则...
              </div>
            ) : filterConfig.rules.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                暂无正则规则，点击右上角「添加规则」创建。
              </div>
            ) : (
              <div className="space-y-2">
                {filterConfig.rules.map((rule, idx) => {
                  const validation = ruleValidations[idx];
                  return (
                    <div
                      key={rule.id}
                      className="rounded-lg border border-border bg-background p-2.5"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          onChange={(e) =>
                            handleUpdateRule(rule.id, { enabled: e.target.checked })
                          }
                          aria-label="启用此规则"
                          className="h-3.5 w-3.5 rounded border-input accent-primary"
                        />
                        <select
                          value={rule.field}
                          onChange={(e) =>
                            handleUpdateRule(rule.id, {
                              field: e.target.value as EmailFilterField,
                            })
                          }
                          aria-label="匹配字段"
                          className="rounded-md border border-input bg-card px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-ring"
                        >
                          {(Object.keys(FIELD_LABELS) as EmailFilterField[]).map((f) => (
                            <option key={f} value={f}>
                              {FIELD_LABELS[f]}
                            </option>
                          ))}
                        </select>
                        <input
                          type="text"
                          value={rule.pattern}
                          onChange={(e) =>
                            handleUpdateRule(rule.id, { pattern: e.target.value })
                          }
                          placeholder="正则表达式，例如 @(github|openai)\.com$"
                          aria-label="正则表达式"
                          className={`min-w-[180px] flex-1 rounded-md border bg-card px-2.5 py-1.5 font-mono text-xs text-foreground outline-none ${
                            validation?.error
                              ? 'border-rose-500/60 focus:border-rose-500'
                              : 'border-input focus:border-ring'
                          }`}
                        />
                        {sampleText && rule.enabled && !validation?.error && (
                          <span
                            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] ${
                              validation?.matchesSample
                                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
                                : 'border-border bg-muted text-muted-foreground'
                            }`}
                          >
                            {validation?.matchesSample ? '命中' : '未命中'}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveRule(rule.id)}
                          aria-label="删除规则"
                          className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      {validation?.error && (
                        <p className="mt-1.5 pl-5 font-mono text-[11px] text-rose-600 dark:text-rose-400">
                          {validation.error}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Live sample test */}
          <div className="space-y-2 rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">规则实时测试</span>
              {sampleOutcome && (
                <span
                  className={`font-mono text-[11px] font-medium ${
                    sampleOutcome.allowed
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-rose-600 dark:text-rose-400'
                  }`}
                >
                  {sampleOutcome.reason}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <select
                value={sampleField}
                onChange={(e) => setSampleField(e.target.value as EmailFilterField | 'all')}
                aria-label="测试字段"
                className="rounded-md border border-input bg-card px-2.5 py-1.5 text-xs text-foreground outline-none focus:border-ring"
              >
                <option value="all">匹配所有字段</option>
                {(Object.keys(FIELD_LABELS) as EmailFilterField[]).map((f) => (
                  <option key={f} value={f}>
                    {FIELD_LABELS[f]}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                placeholder="输入测试样本字符串，如 noreply@github.com 或 Verification code: 482910"
                className="min-w-[200px] flex-1 rounded-md border border-input bg-card px-3 py-1.5 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
          </div>

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={filterSaving || filterLoading || hasInvalidRegex}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              <span>{filterSaving ? '保存中...' : '保存过滤规则'}</span>
            </button>
          </div>
        </form>

        {/* IMAP IDLE Card */}
        <form
          onSubmit={handleSaveImap}
          className="space-y-4 rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Inbox className="h-4 w-4 text-muted-foreground" />
              IMAP IDLE 收信配置
            </h3>
            <span
              className={`rounded-full border border-border bg-background px-2.5 py-0.5 font-mono text-[11px] font-medium ${
                imapConfig?.status === 'listening'
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : imapConfig?.status === 'error'
                  ? 'text-rose-600 dark:text-rose-400'
                  : 'text-muted-foreground'
              }`}
            >
              状态：{imapConfig?.status ?? 'disabled'}
            </span>
          </div>

          {imapConfig?.lastError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              最近错误：{imapConfig.lastError}
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <label className="mb-1 block text-xs text-muted-foreground">IMAP Host</label>
              <input
                type="text"
                value={imapHost}
                onChange={(e) => setImapHost(e.target.value)}
                placeholder="imap.gmail.com / imap.qq.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">端口</label>
              <input
                type="number"
                value={imapPort}
                onChange={(e) => setImapPort(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">邮箱账号</label>
              <input
                type="text"
                value={imapUser}
                onChange={(e) => setImapUser(e.target.value)}
                placeholder="you@gmail.com"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">
                应用专用密码 (App Password){imapConfig?.hasPassword ? ' · 已加密存储' : ''}
              </label>
              <input
                type="password"
                value={imapPass}
                onChange={(e) => setImapPass(e.target.value)}
                placeholder={imapConfig?.hasPassword ? '留空保持原密码不变' : '输入应用密码'}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex items-center gap-4 text-xs text-foreground">
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={imapTls}
                  onChange={(e) => setImapTls(e.target.checked)}
                  className="accent-primary"
                />
                <span>启用 TLS/SSL</span>
              </label>
              <label className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={imapEnabled}
                  onChange={(e) => setImapEnabled(e.target.checked)}
                  className="accent-primary"
                />
                <span>启用后台 IMAP IDLE 监听</span>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleTestImap}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted"
              >
                <TestTube2 className="h-3.5 w-3.5 text-muted-foreground" />
                测试连接
              </button>
              <button
                type="submit"
                disabled={savingImap}
                className="inline-flex items-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85"
              >
                <Save className="h-3.5 w-3.5" />
                保存 IMAP 设置
              </button>
            </div>
          </div>
          {testResult && <p className="text-xs text-muted-foreground">{testResult}</p>}
        </form>

        {/* Cloudflare Email Worker Card */}
        <div className="space-y-4 rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Cloud className="h-4 w-4 text-muted-foreground" />
              域名别名 &amp; Cloudflare Email Webhook
            </h3>
            <button
              type="button"
              onClick={() => void updateSettings({ rotateWebhookSecret: true })}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" /> 轮换密钥
            </button>
          </div>

          <form onSubmit={handleSaveAliasDomain} className="flex gap-2">
            <input
              type="text"
              value={aliasDomain}
              onChange={(e) => setAliasDomain(e.target.value)}
              placeholder="别名邮箱域名，例如 mail.yourdomain.com"
              className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
            />
            <button
              type="submit"
              disabled={savingAlias}
              className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85"
            >
              保存域名
            </button>
          </form>

          <div className="space-y-2 rounded-lg border border-border bg-background p-4 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-muted-foreground">WEBHOOK_URL</span>
              <div className="flex items-center gap-2">
                <code className="font-mono text-foreground">
                  {window.location.origin}/api/webhooks/email/cf
                </code>
                <CopyButton value={`${window.location.origin}/api/webhooks/email/cf`} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-muted-foreground">WEBHOOK_SECRET</span>
              <div className="flex items-center gap-2">
                <code className="max-w-[320px] truncate font-mono text-foreground">
                  {account?.cfWebhookSecret ?? ''}
                </code>
                <CopyButton value={account?.cfWebhookSecret ?? ''} />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-muted-foreground">RECIPIENT_X25519_PUBLIC_KEY</span>
              <div className="flex items-center gap-2">
                <code className="max-w-[320px] truncate font-mono text-foreground">
                  {account?.emailPublicKey ?? ''}
                </code>
                <CopyButton value={account?.emailPublicKey ?? ''} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
