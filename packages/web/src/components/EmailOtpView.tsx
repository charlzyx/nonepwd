import React, { useState } from 'react';
import { ExternalLink, Mail, MailPlus, Power, Trash2 } from 'lucide-react';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

export const EmailOtpView: React.FC = () => {
  const { account, emails, aliases, createAlias, toggleAlias, deleteAlias, deleteEmail } =
    useVault();
  const [siteInput, setSiteInput] = useState('github.com');
  const [explicitAddr, setExplicitAddr] = useState('');

  const handleCreateAlias = async (e: React.FormEvent) => {
    e.preventDefault();
    await createAlias({
      siteDomain: siteInput,
      address: explicitAddr.trim() || undefined,
    });
    setExplicitAddr('');
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            邮箱验证码实时中心 &amp; 域名别名
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            来自 IMAP IDLE 或 Cloudflare Email Worker 的验证码邮件经 X25519 公钥密封存储，仅在本地内存解密展示。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Live Email OTP Stream */}
          <div className="lg:col-span-2">
            <div className="rounded-xl border border-border bg-card p-5">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  实时收件流（共 {emails.length} 封）
                </h3>
              </div>

              {emails.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border bg-background p-8 text-center text-xs text-muted-foreground">
                  暂无验证码邮件。在「IMAP / Cloudflare 配置」中启用收信通道后，新到达的验证码将自动经 X25519 密封展示于此。
                </div>
              ) : (
                <div className="space-y-3">
                  {emails.map((em) => (
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
                            {em.to && <span>→ {em.to}</span>}
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

                      <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">{em.snippet}</p>
                    </div>
                  ))}
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
