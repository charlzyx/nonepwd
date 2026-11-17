import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Cloud, Filter, HardDrive, Inbox, Plus, RefreshCw, RotateCcw, Save, TestTube2, Trash2 } from 'lucide-react';
import { randomId } from '@nonepwd/core';
import {
  useVault,
  type EmailFilterConfig,
  type EmailFilterField,
  type EmailFilterMode,
  type EmailFilterRule,
  type R2BackupMeta,
} from '../state/VaultContext';
import { CopyButton } from './CopyButton';

export type SettingsFocusTab = 'alias' | 'imap' | 'filter' | 'backup';

interface SettingsViewProps {
  initialFocus?: SettingsFocusTab;
}

const IMAP_PRESETS = [
  { label: 'QQ 邮箱', host: 'imap.qq.com', port: 993, tls: true },
  { label: 'Gmail', host: 'imap.gmail.com', port: 993, tls: true },
  { label: '163 邮箱', host: 'imap.163.com', port: 993, tls: true },
  { label: 'iCloud', host: 'imap.mail.me.com', port: 993, tls: true },
  { label: 'Outlook', host: 'outlook.office365.com', port: 993, tls: true },
] as const;

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

export const SettingsView: React.FC<SettingsViewProps> = ({ initialFocus }) => {
  const {
    account,
    imapConfig,
    updateSettings,
    saveImapConfig,
    testImapConfig,
    getEmailFilter,
    saveEmailFilter,
    listBackups,
    createBackup,
    restoreBackup,
    deleteBackup,
  } = useVault();

  const filterRef = useRef<HTMLFormElement>(null);
  const imapRef = useRef<HTMLFormElement>(null);
  const aliasRef = useRef<HTMLDivElement>(null);
  const backupRef = useRef<HTMLDivElement>(null);
  const [highlightedTab, setHighlightedTab] = useState<SettingsFocusTab | null>(
    initialFocus ?? null
  );

  const [aliasDomain, setAliasDomain] = useState(account?.aliasDomain ?? '');
  const [savingAlias, setSavingAlias] = useState(false);
  const [aliasNotice, setAliasNotice] = useState<string | null>(null);
  const [aliasError, setAliasError] = useState<string | null>(null);

  const [imapEnabled, setImapEnabled] = useState(
    Boolean(imapConfig?.enabled) || (!imapConfig?.enabled && !imapConfig?.host)
  );
  const [imapHost, setImapHost] = useState(imapConfig?.host ?? '');
  const [imapPort, setImapPort] = useState(imapConfig?.port ?? 993);
  const [imapTls, setImapTls] = useState(imapConfig?.tls ?? true);
  const [imapUser, setImapUser] = useState(imapConfig?.username ?? '');
  const [imapPass, setImapPass] = useState('');
  const [testResult, setTestResult] = useState<string | null>(null);
  const [savingImap, setSavingImap] = useState(false);
  const [imapNotice, setImapNotice] = useState<string | null>(null);
  const [imapError, setImapError] = useState<string | null>(null);

  const [filterConfig, setFilterConfig] = useState<EmailFilterConfig>(DEFAULT_FILTER);
  const [filterLoading, setFilterLoading] = useState(true);
  const [filterSaving, setFilterSaving] = useState(false);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filterNotice, setFilterNotice] = useState<string | null>(null);
  const [sampleField, setSampleField] = useState<EmailFilterField | 'all'>('all');
  const [sampleText, setSampleText] = useState('');

  const [backupsSupported, setBackupsSupported] = useState(false);
  const [r2Enabled, setR2Enabled] = useState(false);
  const [backups, setBackups] = useState<R2BackupMeta[]>([]);
  const [backupBusy, setBackupBusy] = useState(false);
  const [backupNotice, setBackupNotice] = useState<string | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listBackups()
      .then((res) => {
        if (cancelled) return;
        setBackupsSupported(true);
        setR2Enabled(Boolean(res.enabled));
        setBackups(Array.isArray(res.backups) ? res.backups : []);
      })
      .catch(() => {
        if (cancelled) return;
        setBackupsSupported(false);
      });
    return () => {
      cancelled = true;
    };
  }, [listBackups]);

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

  useEffect(() => {
    if (!initialFocus) {
      setHighlightedTab(null);
      return;
    }
    setHighlightedTab(initialFocus);
    const target =
      initialFocus === 'filter'
        ? filterRef.current
        : initialFocus === 'imap'
          ? imapRef.current
          : initialFocus === 'alias'
            ? aliasRef.current
            : backupRef.current;
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    const timer = window.setTimeout(() => {
      setHighlightedTab((cur) => (cur === initialFocus ? null : cur));
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [initialFocus, backupsSupported]);

  const cardFocusClass = (tab: SettingsFocusTab) =>
    highlightedTab === tab
      ? 'ring-2 ring-primary/50 border-primary/60 transition-all duration-300'
      : 'transition-all duration-300';

  const handleSaveAliasDomain = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingAlias(true);
    setAliasNotice(null);
    setAliasError(null);
    try {
      await updateSettings({ aliasDomain });
      setAliasNotice('别名域名已保存');
    } catch (err) {
      setAliasError(err instanceof Error ? err.message : '保存别名域名失败');
    } finally {
      setSavingAlias(false);
    }
  };

  const handleSaveImap = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingImap(true);
    setImapNotice(null);
    setImapError(null);
    try {
      await saveImapConfig({
        enabled: imapEnabled,
        host: imapHost.trim(),
        port: Number(imapPort),
        tls: imapTls,
        username: imapUser.trim(),
        password: imapPass || undefined,
      });
      setImapPass('');
      setImapNotice(imapEnabled ? 'IMAP 设置已保存并启用收信监听' : 'IMAP 设置已保存');
    } catch (err) {
      setImapError(err instanceof Error ? err.message : '保存 IMAP 设置失败');
    } finally {
      setSavingImap(false);
    }
  };

  const handleCreateBackup = async () => {
    setBackupBusy(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const created = await createBackup();
      setBackups((prev) => [created, ...prev.filter((b) => b.key !== created.key)]);
      setBackupNotice(`已创建 R2 零知识加密快照：${created.key}`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '创建 R2 快照失败');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleRestoreBackup = async (key: string) => {
    setBackupBusy(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      const res = await restoreBackup(key);
      setBackupNotice(
        `已从 ${res.key} 恢复 ${res.vaultCount} 个库 / ${res.itemCount} 条条目 / ${res.emailCount} 封邮件`
      );
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '恢复快照失败');
    } finally {
      setBackupBusy(false);
    }
  };

  const handleDeleteBackup = async (key: string) => {
    setBackupBusy(true);
    setBackupError(null);
    setBackupNotice(null);
    try {
      await deleteBackup(key);
      setBackups((prev) => prev.filter((b) => b.key !== key));
      setBackupNotice(`已删除快照：${key}`);
    } catch (err) {
      setBackupError(err instanceof Error ? err.message : '删除快照失败');
    } finally {
      setBackupBusy(false);
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
          ref={filterRef}
          data-settings-section="filter"
          onSubmit={handleSaveFilter}
          className={`space-y-4 rounded-xl border border-border bg-card p-5 ${cardFocusClass('filter')}`}
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
          ref={imapRef}
          data-settings-section="imap"
          onSubmit={handleSaveImap}
          className={`space-y-4 rounded-xl border border-border bg-card p-5 ${cardFocusClass('imap')}`}
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

          {imapError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              {imapError}
            </div>
          )}

          {imapNotice && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              {imapNotice}
            </div>
          )}

          {imapConfig?.lastError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              最近错误：{imapConfig.lastError}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">常用预设：</span>
            {IMAP_PRESETS.map((preset) => {
              const selected = imapHost.trim().toLowerCase() === preset.host.toLowerCase();
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setImapHost(preset.host);
                    setImapPort(preset.port);
                    setImapTls(preset.tls);
                    setImapEnabled(true);
                    setImapNotice(null);
                    setImapError(null);
                  }}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                    selected
                      ? 'bg-primary text-primary-foreground'
                      : 'border border-border bg-background text-foreground hover:bg-muted'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>

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
        <div
          ref={aliasRef}
          data-settings-section="alias"
          className={`space-y-4 rounded-xl border border-border bg-card p-5 ${cardFocusClass('alias')}`}
        >
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

          <p className="text-xs text-muted-foreground">
            若服务端部署在 Cloudflare 版 <code className="font-mono text-foreground">@nonepwd/cf-server</code>
            ，可在 Cloudflare Dashboard Email Routing Catch-All 直接指向 Worker{' '}
            <code className="font-mono text-foreground">nonepwd-cf-server</code>，无需额外转发与 Webhook Secret。
          </p>

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

          {aliasError && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
              {aliasError}
            </div>
          )}

          {aliasNotice && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
              {aliasNotice}
            </div>
          )}

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

        {/* R2 Zero-Knowledge Snapshots Card (Cloudflare @nonepwd/cf-server) */}
        {backupsSupported && (
          <div
            ref={backupRef}
            data-settings-section="backup"
            className={`space-y-4 rounded-xl border border-border bg-card p-5 ${cardFocusClass('backup')}`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <HardDrive className="h-4 w-4 text-muted-foreground" />
                  R2 零知识加密快照备份
                </h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Cron 每 6 小时自动生成全库密文快照并存入 Cloudflare R2，也可在此随时手动备份与回滚。
                </p>
              </div>
              {r2Enabled && (
                <button
                  type="button"
                  disabled={backupBusy}
                  onClick={() => void handleCreateBackup()}
                  className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>{backupBusy ? '处理中...' : '立即创建 R2 快照'}</span>
                </button>
              )}
            </div>

            {backupError && (
              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-600 dark:text-rose-400">
                {backupError}
              </div>
            )}

            {backupNotice && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-600 dark:text-emerald-400">
                {backupNotice}
              </div>
            )}

            {!r2Enabled ? (
              <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                当前 Worker 尚未绑定 R2 Bucket（<code className="font-mono text-foreground">BUCKET</code>
                ）。请在 <code className="font-mono text-foreground">packages/cf-server/wrangler.jsonc</code>{' '}
                中配置 <code className="font-mono text-foreground">r2_buckets</code> 后重新部署以开启 R2 快照备份。
              </div>
            ) : backups.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-center text-xs text-muted-foreground">
                R2 桶暂无加密快照，点击右上角「立即创建 R2 快照」生成首份全库备份。
              </div>
            ) : (
              <div className="space-y-2">
                {backups.map((b) => (
                  <div
                    key={b.key}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-background px-3.5 py-2.5 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono font-medium text-foreground">{b.key}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
                        <span>{b.uploadedAt}</span>
                        <span>· {b.reason}</span>
                        {b.vaultCount !== null && <span>· {b.vaultCount} 库</span>}
                        {b.itemCount !== null && <span>· {b.itemCount} 条目</span>}
                        {b.emailCount !== null && <span>· {b.emailCount} 邮件</span>}
                        <span>· {(b.size / 1024).toFixed(1)} KB</span>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={backupBusy}
                        onClick={() => void handleRestoreBackup(b.key)}
                        className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        从此快照恢复
                      </button>
                      <button
                        type="button"
                        disabled={backupBusy}
                        onClick={() => void handleDeleteBackup(b.key)}
                        aria-label="删除快照"
                        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600 dark:hover:text-rose-400 disabled:opacity-50"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
