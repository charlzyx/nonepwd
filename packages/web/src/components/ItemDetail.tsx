import React, { useEffect, useMemo, useState } from 'react';
import {
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  MailCheck,
  ShieldCheck,
  Star,
  Terminal,
  Trash2,
} from 'lucide-react';
import { domainsMatch, generateTotp, type VaultItemPayload } from '@nonepwd/core';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

interface ItemDetailProps {
  item: VaultItemPayload | null;
  onEdit: (item: VaultItemPayload) => void;
}

export const ItemDetail: React.FC<ItemDetailProps> = ({ item, onEdit }) => {
  const { vaults, emails, deleteItem, saveItem } = useVault();
  const [revealPassword, setRevealPassword] = useState(false);
  const [totpState, setTotpState] = useState<{
    code: string;
    remaining: number;
    period: number;
  } | null>(null);

  useEffect(() => {
    setRevealPassword(false);
  }, [item?.id]);

  useEffect(() => {
    if (!item?.totp) {
      setTotpState(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await generateTotp(item.totp!);
        if (!cancelled) {
          setTotpState({ code: res.code, remaining: res.remainingSeconds, period: res.period });
        }
      } catch {
        if (!cancelled) setTotpState(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [item?.totp]);

  const vaultName = useMemo(() => {
    if (!item) return 'Personal';
    return vaults.find((v) => v.id === item.vaultId)?.metadata.name ?? 'Personal';
  }, [item, vaults]);

  const matchedEmailOtp = useMemo(() => {
    if (!item) return null;
    const cutoff = Date.now() - 15 * 60 * 1000;
    return (
      emails.find((em) => {
        if (!em.otpCode) return false;
        if (new Date(em.receivedAt).getTime() < cutoff) return false;
        if (item.emailAlias && em.to.toLowerCase() === item.emailAlias.toLowerCase()) {
          return true;
        }
        return item.urls.some((u) => domainsMatch(u, em.senderDomain || em.from));
      }) ?? null
    );
  }, [emails, item]);

  if (!item) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center bg-background p-8 text-center text-muted-foreground">
        <ShieldCheck className="mb-3 h-10 w-10 text-muted-foreground/50" />
        <p className="text-sm font-medium text-foreground">从左侧选择一个凭据查看详情</p>
        <p className="mt-1 text-xs text-muted-foreground">
          支持实时 2FA 动态码、邮箱验证码关联和 np:// 引用复制
        </p>
      </div>
    );
  }

  const secretRefBase = `np://${vaultName}/${item.title}`;

  const handleToggleFavorite = async () => {
    await saveItem({ ...item, favorite: !item.favorite }, false);
  };

  const handleDelete = async () => {
    if (!confirm(`确定删除 "${item.title}"？此操作不可撤销。`)) return;
    await deleteItem(item.vaultId, item.id);
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-2xl space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="rounded border border-border bg-muted/50 px-2 py-0.5 font-mono text-[11px] font-medium text-foreground">
                {vaultName}
              </span>
              <span className="rounded border border-border bg-card px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                {item.category}
              </span>
            </div>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight text-foreground">
              {item.title}
            </h2>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleToggleFavorite}
              className="rounded-md border border-border bg-background p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-amber-500"
              title="切换收藏"
            >
              <Star
                className={`h-4 w-4 ${item.favorite ? 'fill-amber-500 text-amber-500' : ''}`}
              />
            </button>
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Edit3 className="h-3.5 w-3.5" />
              编辑
            </button>
            <button
              type="button"
              onClick={handleDelete}
              className="rounded-md border border-border bg-background p-2 text-muted-foreground transition-colors hover:border-rose-500/50 hover:text-rose-600 dark:hover:text-rose-400"
              title="删除条目"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Matched Live Email OTP Banner */}
        {matchedEmailOtp && matchedEmailOtp.otpCode && (
          <div className="flex items-center justify-between rounded-xl border border-border bg-card p-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-background text-emerald-600 dark:text-emerald-400">
                <MailCheck className="h-5 w-5" />
              </div>
              <div>
                <div className="font-mono text-xs font-medium text-emerald-600 dark:text-emerald-400">
                  最新关联邮箱验证码 · {matchedEmailOtp.senderDomain}
                </div>
                <div className="mt-0.5 font-mono text-2xl font-bold tracking-widest text-foreground">
                  {matchedEmailOtp.otpCode}
                </div>
              </div>
            </div>
            <CopyButton value={matchedEmailOtp.otpCode} label="复制验证码" />
          </div>
        )}

        {/* Primary Credentials Card */}
        <div className="divide-y divide-border rounded-xl border border-border bg-card">
          {item.username && (
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  用户名 / 邮箱
                </div>
                <div className="mt-1 truncate text-sm text-foreground select-all">
                  {item.username}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <CopyButton value={`${secretRefBase}/username`} label="np://" />
                <CopyButton value={item.username} label="复制" />
              </div>
            </div>
          )}

          {item.password && (
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  密码 / 密钥
                </div>
                <div className="mt-1 truncate font-mono text-sm text-foreground select-all">
                  {revealPassword ? item.password : '••••••••••••••••••••'}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRevealPassword((v) => !v)}
                  className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                  title={revealPassword ? '隐藏' : '显示'}
                >
                  {revealPassword ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
                <CopyButton value={`${secretRefBase}/password`} label="np://" />
                <CopyButton value={item.password} label="复制" />
              </div>
            </div>
          )}

          {totpState && (
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="flex items-center gap-3">
                <svg className="h-9 w-9 -rotate-90" viewBox="0 0 36 36">
                  <circle
                    cx="18"
                    cy="18"
                    r="15"
                    fill="none"
                    stroke="currentColor"
                    className="text-border"
                    strokeWidth="3"
                  />
                  <circle
                    cx="18"
                    cy="18"
                    r="15"
                    fill="none"
                    stroke={totpState.remaining <= 5 ? '#e11d48' : 'currentColor'}
                    className={totpState.remaining <= 5 ? '' : 'text-foreground'}
                    strokeWidth="3"
                    strokeDasharray="94.25"
                    strokeDashoffset={
                      94.25 * (1 - totpState.remaining / Math.max(1, totpState.period))
                    }
                    strokeLinecap="round"
                  />
                </svg>
                <div>
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    一次性动态码 (2FA TOTP · {totpState.remaining}s)
                  </div>
                  <div className="mt-0.5 font-mono text-xl font-bold tracking-wider text-foreground">
                    {totpState.code.length === 6
                      ? `${totpState.code.slice(0, 3)} ${totpState.code.slice(3)}`
                      : totpState.code}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <CopyButton value={`${secretRefBase}/totp`} label="np://" />
                <CopyButton value={totpState.code} label="复制 2FA" />
              </div>
            </div>
          )}

          {item.emailAlias && (
            <div className="flex items-center justify-between gap-4 p-4">
              <div className="min-w-0">
                <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  绑定邮箱别名 (Masked Email)
                </div>
                <div className="mt-1 truncate font-mono text-sm text-foreground">
                  {item.emailAlias}
                </div>
              </div>
              <CopyButton value={item.emailAlias} label="复制别名" />
            </div>
          )}

          {item.urls.length > 0 && (
            <div className="space-y-2 p-4">
              <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                关联网址
              </div>
              {item.urls.map((u, idx) => (
                <div key={idx} className="flex items-center justify-between gap-2">
                  <a
                    href={u}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 truncate text-sm text-foreground underline underline-offset-4 hover:opacity-75"
                  >
                    <span className="truncate">{u}</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </a>
                  <CopyButton value={u} />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Custom Fields */}
        {item.customFields.length > 0 && (
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {item.customFields.map((cf) => (
              <div key={cf.id} className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    {cf.label}
                  </div>
                  <div className="mt-1 truncate font-mono text-sm text-foreground">
                    {cf.type === 'concealed' && !revealPassword ? '••••••••••••' : cf.value}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CopyButton value={`${secretRefBase}/${cf.label}`} label="np://" />
                  <CopyButton value={cf.value} label="复制" />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Notes */}
        {item.notes && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-1.5 font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
              安全备注
            </div>
            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-foreground">
              {item.notes}
            </pre>
          </div>
        )}

        {/* CLI Secret Reference Hint */}
        <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-2 truncate">
            <Terminal className="h-3.5 w-3.5 shrink-0 text-foreground" />
            <code className="truncate font-mono text-foreground">
              np read "{secretRefBase}/password"
            </code>
          </span>
          <CopyButton value={`np read "${secretRefBase}/password"`} label="复制命令" />
        </div>
      </div>
    </div>
  );
};
