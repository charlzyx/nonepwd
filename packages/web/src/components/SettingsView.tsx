import React, { useState } from 'react';
import { Cloud, Inbox, RefreshCw, Save, TestTube2 } from 'lucide-react';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

export const SettingsView: React.FC = () => {
  const { account, imapConfig, updateSettings, saveImapConfig, testImapConfig } = useVault();

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
    const res = await testImapConfig({
      host: imapHost,
      port: Number(imapPort),
      tls: imapTls,
      username: imapUser,
      password: imapPass || undefined,
    });
    setTestResult(
      res.ok ? `连接成功！INBOX 当前共有 ${res.messages ?? 0} 封邮件。` : `连接失败：${res.error}`
    );
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            收信引擎配置：IMAP IDLE + Cloudflare Email Worker
          </h2>
          <p className="mt-1 text-xs text-muted-foreground">
            两种收信通道可单独使用或同时开启，收到验证码邮件后均通过你的 X25519 公钥密封。
          </p>
        </div>

        {/* IMAP IDLE Card */}
        <form
          onSubmit={handleSaveImap}
          className="space-y-4 rounded-xl border border-border bg-card p-5"
        >
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <Inbox className="h-4 w-4 text-muted-foreground" />
              主力邮箱 IMAP IDLE 长连接监听
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
              Cloudflare Email Routing Worker 部署参数
            </h3>
            <button
              type="button"
              onClick={() => void updateSettings({ rotateWebhookSecret: true })}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <RefreshCw className="h-3 w-3" /> 轮换 Webhook 密钥
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
              保存别名域名
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
              <span className="font-mono text-muted-foreground">
                RECIPIENT_X25519_PUBLIC_KEY (可选边缘加密)
              </span>
              <div className="flex items-center gap-2">
                <code className="max-w-[320px] truncate font-mono text-foreground">
                  {account?.emailPublicKey ?? ''}
                </code>
                <CopyButton value={account?.emailPublicKey ?? ''} />
              </div>
            </div>
          </div>

          <pre className="overflow-x-auto rounded-lg border border-border bg-background p-3.5 font-mono text-[11px] text-foreground">{`cd packages/cf-email-worker
npx wrangler deploy
npx wrangler secret put WEBHOOK_SECRET   # 粘贴上方 WEBHOOK_SECRET
# 并在 Cloudflare Dashboard -> Email -> Email Routing -> Catch-all 选择发送到 nonepwd-email-router`}</pre>
        </div>
      </div>
    </div>
  );
};
