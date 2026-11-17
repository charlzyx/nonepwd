import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  ExternalLink,
  Filter,
  Inbox,
  Mail,
  MailPlus,
  Power,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useVault, type DecryptedEmailItem } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

interface EmailOtpViewProps {
  onOpenImapSettings?: () => void;
  onOpenFilterSettings?: () => void;
}

function extractEmailAddresses(raw: string | null | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return [];
  const matches = trimmed.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi);
  if (matches && matches.length > 0) {
    return Array.from(new Set(matches.map((m) => m.toLowerCase())));
  }
  return [trimmed.toLowerCase()];
}

function getEmailRecipientAddresses(em: DecryptedEmailItem): string[] {
  const fromTo = extractEmailAddresses(em.to);
  const fromEnv = extractEmailAddresses(em.envelopeTo);
  if (fromTo.some((addr) => addr.includes('@'))) {
    return fromTo;
  }
  if (fromEnv.length > 0) {
    return fromEnv;
  }
  return fromTo;
}

export const EmailOtpView: React.FC<EmailOtpViewProps> = ({
  onOpenImapSettings,
  onOpenFilterSettings,
}) => {
  const {
    account,
    emails,
    aliases,
    imapConfig,
    imapAccounts,
    syncImapNow,
    createAlias,
    toggleAlias,
    deleteAlias,
    deleteEmail,
  } = useVault();
  const [siteInput, setSiteInput] = useState('github.com');
  const [explicitAddr, setExplicitAddr] = useState('');
  const [selectedMailbox, setSelectedMailbox] = useState<string>('all');
  const [syncing, setSyncing] = useState(false);
  const [syncFeedback, setSyncFeedback] = useState<{
    kind: 'ok' | 'error';
    message: string;
  } | null>(null);

  const anyImapEnabled =
    imapAccounts.some((a) => a.enabled) || Boolean(imapConfig?.enabled);

  const mailboxes = useMemo(() => {
    const map = new Map<string, { address: string; label?: string; count: number }>();
    for (const acc of imapAccounts) {
      for (const addr of extractEmailAddresses(acc.username)) {
        if (!addr) continue;
        const label = acc.label?.trim();
        map.set(addr, {
          address: addr,
          label: label && label.toLowerCase() !== addr ? label : undefined,
          count: 0,
        });
      }
    }
    for (const em of emails) {
      for (const addr of getEmailRecipientAddresses(em)) {
        if (!addr) continue;
        const existing = map.get(addr);
        if (existing) {
          existing.count += 1;
        } else {
          map.set(addr, { address: addr, count: 1 });
        }
      }
    }
    return Array.from(map.values());
  }, [emails, imapAccounts]);

  const effectiveMailbox = mailboxes.some((m) => m.address === selectedMailbox)
    ? selectedMailbox
    : 'all';

  const filteredEmails = useMemo(() => {
    if (effectiveMailbox === 'all') return emails;
    return emails.filter((em) => {
      const addrs = [
        ...extractEmailAddresses(em.to),
        ...extractEmailAddresses(em.envelopeTo),
      ];
      return addrs.includes(effectiveMailbox);
    });
  }, [effectiveMailbox, emails]);

  const handleCreateAlias = async (e: React.FormEvent) => {
    e.preventDefault();
    await createAlias({
      siteDomain: siteInput,
      address: explicitAddr.trim() || undefined,
    });
    setExplicitAddr('');
  };

  const handleSyncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncFeedback(null);
    try {
      const res = await syncImapNow();
      if (res.ok) {
        setSyncFeedback({
          kind: 'ok',
          message:
            res.synced && res.synced > 0
              ? `同步完成，拉取到 ${res.synced} 封新邮件`
              : '同步完成，当前已是最新收件列表',
        });
      } else if (res.error?.includes('404')) {
        setSyncFeedback({
          kind: 'ok',
          message: '已刷新收件列表（本地服务端由 IMAP IDLE 实时推送）',
        });
      } else {
        setSyncFeedback({
          kind: 'error',
          message: res.error || '同步收信失败',
        });
      }
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              邮箱验证码与别名
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              实时提取 IMAP 与 Cloudflare 域名路由邮件中的一次性验证码及登录链接。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={syncing}
              onClick={() => void handleSyncNow()}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
              <span>{syncing ? '同步中...' : '立即同步收信'}</span>
            </button>

            {onOpenFilterSettings && (
              <button
                type="button"
                onClick={onOpenFilterSettings}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <span>过滤规则</span>
              </button>
            )}

            {onOpenImapSettings && (
              <button
                type="button"
                onClick={onOpenImapSettings}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                <span>配置 IMAP</span>
              </button>
            )}
          </div>
        </div>

        {/* Unconfigured / disabled IMAP banner */}
        {!anyImapEnabled && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-start gap-3">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
              <div>
                <div className="text-xs font-semibold text-amber-800 dark:text-amber-200">
                  尚未启用邮箱 IMAP 自动收信
                </div>
                <p className="mt-0.5 text-xs text-amber-700/90 dark:text-amber-300/85">
                  配置 QQ / Gmail / 163 / iCloud / Outlook 邮箱授权码后，即可自动同步并提取验证码邮件。
                </p>
              </div>
            </div>
            {onOpenImapSettings && (
              <button
                type="button"
                onClick={onOpenImapSettings}
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
              >
                立即配置 IMAP
              </button>
            )}
          </div>
        )}

        {syncFeedback && (
          <div
            className={`rounded-lg border px-3.5 py-2 text-xs ${
              syncFeedback.kind === 'error'
                ? 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400'
                : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400'
            }`}
          >
            {syncFeedback.message}
          </div>
        )}

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Live Email OTP Stream */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  实时收件流（共 {filteredEmails.length} 封
                  {effectiveMailbox !== 'all' ? ` / 总 ${emails.length} 封` : ''}）
                </h3>
              </div>

              {mailboxes.length > 1 && (
                <div className="mb-4 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => setSelectedMailbox('all')}
                    className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      effectiveMailbox === 'all'
                        ? 'bg-primary text-primary-foreground'
                        : 'border border-border bg-background text-foreground hover:bg-muted'
                    }`}
                  >
                    全部邮箱 ({emails.length})
                  </button>
                  {mailboxes.map((m) => {
                    const active = effectiveMailbox === m.address;
                    return (
                      <button
                        key={m.address}
                        type="button"
                        title={m.label ? `${m.label} · ${m.address}` : m.address}
                        onClick={() => setSelectedMailbox(m.address)}
                        className={`inline-flex max-w-[260px] items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                          active
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border bg-background text-foreground hover:bg-muted'
                        }`}
                      >
                        <span className="truncate">
                          {m.label ? `${m.label} · ${m.address}` : m.address}
                        </span>
                        <span
                          className={`font-mono text-[10px] ${
                            active ? 'text-primary-foreground/85' : 'text-muted-foreground'
                          }`}
                        >
                          {m.count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {emails.length === 0 ? (
                <div className="space-y-3 rounded-lg border border-dashed border-border bg-background p-8 text-center text-xs text-muted-foreground">
                  <p>
                    暂无验证码邮件。在「设置」中启用 IMAP 或 Cloudflare 收信后，新验证码将自动展示于此。
                  </p>
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <button
                      type="button"
                      disabled={syncing}
                      onClick={() => void handleSyncNow()}
                      className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      <RefreshCw className={`h-3 w-3 ${syncing ? 'animate-spin' : ''}`} />
                      <span>立即同步收信</span>
                    </button>
                    {onOpenImapSettings && (
                      <button
                        type="button"
                        onClick={onOpenImapSettings}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                      >
                        <Inbox className="h-3 w-3" />
                        <span>配置 IMAP</span>
                      </button>
                    )}
                  </div>
                </div>
              ) : filteredEmails.length === 0 ? (
                <div className="space-y-3 rounded-lg border border-dashed border-border bg-background p-6 text-center text-xs text-muted-foreground">
                  <p>当前收件邮箱（{effectiveMailbox}）暂无匹配邮件。</p>
                  <button
                    type="button"
                    onClick={() => setSelectedMailbox('all')}
                    className="rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                  >
                    查看全部邮箱
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {filteredEmails.map((em) => {
                    const recipientDisplay = em.to?.includes('@')
                      ? em.to.trim()
                      : em.envelopeTo?.trim() || em.to?.trim() || '';
                    return (
                      <div
                        key={em.id}
                        className="rounded-lg border border-border bg-background p-4 transition-colors hover:border-ring"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="rounded border border-border bg-muted px-1.5 py-0.5 font-mono uppercase text-foreground">
                                {em.source}
                              </span>
                              <span className="font-medium text-foreground">{em.from}</span>
                              {recipientDisplay && (
                                <span
                                  title={`收件邮箱：${recipientDisplay}`}
                                  className="inline-flex max-w-[260px] items-center truncate rounded border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-sky-700 dark:text-sky-300"
                                >
                                  → {recipientDisplay}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 text-sm font-medium text-foreground">
                              {em.subject}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => void deleteEmail(em.id)}
                            className="rounded p-1 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                            title="删除记录"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {em.otpCode && (
                          <div className="mt-3 flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3.5 py-2.5">
                            <div>
                              <span className="font-mono text-[11px] text-muted-foreground">
                                提取验证码 (置信度 {Math.round(em.confidence * 100)}%)
                              </span>
                              <div className="font-mono text-xl font-bold tracking-widest text-foreground">
                                {em.otpCode}
                              </div>
                            </div>
                            <CopyButton value={em.otpCode} label="复制验证码" />
                          </div>
                        )}

                        {em.magicLink && (
                          <div className="mt-2">
                            <a
                              href={em.magicLink}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-xs text-foreground underline underline-offset-4 hover:opacity-75"
                            >
                              <span>打开 Magic Link 登录链接</span>
                              <ExternalLink className="h-3 w-3" />
                            </a>
                          </div>
                        )}

                        <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                          {em.snippet}
                        </p>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* Masked Aliases Column */}
          <div className="space-y-4">
            <form
              onSubmit={handleCreateAlias}
              className="space-y-3 rounded-xl border border-border bg-card p-5"
            >
              <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <MailPlus className="h-4 w-4 text-muted-foreground" />
                生成域名邮箱别名
              </h3>
              <input
                type="text"
                value={siteInput}
                onChange={(e) => setSiteInput(e.target.value)}
                placeholder="目标站点域名 (如 cursor.com)"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              />
              <input
                type="text"
                value={explicitAddr}
                onChange={(e) => setExplicitAddr(e.target.value)}
                placeholder={
                  account?.aliasDomain
                    ? `留空将自动生成 @${account.aliasDomain}`
                    : '输入完整别名地址 (或先配置 aliasDomain)'
                }
                className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
              />
              <button
                type="submit"
                className="w-full rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
              >
                创建别名
              </button>
            </form>

            <div className="rounded-xl border border-border bg-card p-5">
              <h3 className="mb-3 text-sm font-semibold text-foreground">
                已创建别名 ({aliases.length})
              </h3>
              <div className="space-y-2">
                {aliases.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-lg border border-border bg-background p-3 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-mono text-foreground">{a.address}</span>
                      <CopyButton value={a.address} />
                    </div>
                    <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>收信 {a.receivedCount} 次</span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => void toggleAlias(a.id, !a.enabled)}
                          className={`inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 font-medium ${
                            a.enabled
                              ? 'bg-muted/40 text-emerald-600 dark:text-emerald-400'
                              : 'bg-muted/40 text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          <Power className="h-3 w-3" />
                          {a.enabled ? '接收中' : '已屏蔽'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void deleteAlias(a.id)}
                          className="text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
                {aliases.length === 0 && (
                  <p className="text-xs text-muted-foreground">尚未生成邮箱别名。</p>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
