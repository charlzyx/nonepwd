import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  MailCheck,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
} from 'lucide-react';
import { domainsMatch, generateTotp, type IdentityDetails, type VaultItemPayload } from '@nonepwd/core';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

interface ItemDetailProps {
  item: VaultItemPayload | null;
  onEdit: (item: VaultItemPayload) => void;
  onSelectGroup?: (group: string) => void;
}

function maskCardNumber(raw: string): string {
  const digits = raw.replace(/\s+/g, '');
  if (digits.length <= 4) return '••••';
  return `•••• •••• •••• ${digits.slice(-4)}`;
}

function formatExpiry(expMonth?: string, expYear?: string): string {
  if (!expMonth && !expYear) return '';
  return [expMonth, expYear].filter(Boolean).join(' / ');
}

function formatFullAddress(id: IdentityDetails): string {
  return [id.address1, id.address2, id.city, id.state, id.postalCode, id.country]
    .filter(Boolean)
    .join(', ');
}

const IDENTITY_FIELD_ROWS: Array<{ key: keyof IdentityDetails; label: string }> = [
  { key: 'fullName', label: '姓名' },
  { key: 'firstName', label: '名' },
  { key: 'lastName', label: '姓' },
  { key: 'email', label: '邮箱' },
  { key: 'phone', label: '电话' },
  { key: 'company', label: '公司' },
  { key: 'address1', label: '地址 1' },
  { key: 'address2', label: '地址 2' },
  { key: 'city', label: '城市' },
  { key: 'state', label: '省 / 州' },
  { key: 'postalCode', label: '邮编' },
  { key: 'country', label: '国家 / 地区' },
];

export const ItemDetail: React.FC<ItemDetailProps> = ({ item, onEdit, onSelectGroup }) => {
  const {
    vaults,
    emails,
    allGroups,
    securityIssues,
    deleteItem,
    saveItem,
    toggleItemGroup,
    scheduleEmailAutoDelete,
  } = useVault();
  const [revealPassword, setRevealPassword] = useState(false);
  const [revealPassphrase, setRevealPassphrase] = useState(false);
  const [revealCard, setRevealCard] = useState(false);
  const [revealCustom, setRevealCustom] = useState(false);
  const [groupMenuOpen, setGroupMenuOpen] = useState(false);
  const groupMenuRef = useRef<HTMLDivElement>(null);
  const [totpState, setTotpState] = useState<{
    code: string;
    remaining: number;
    period: number;
  } | null>(null);

  useEffect(() => {
    setRevealPassword(false);
    setRevealPassphrase(false);
    setRevealCard(false);
    setRevealCustom(false);
    setGroupMenuOpen(false);
  }, [item?.id]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
        setGroupMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGroupMenuOpen(false);
    };
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, []);

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
        <ShieldCheck className="mb-3 h-9 w-9 text-muted-foreground/40" />
        <p className="text-sm font-medium text-foreground">从左侧选择一个条目查看详情</p>
      </div>
    );
  }

  const handleToggleFavorite = async () => {
    await saveItem({ ...item, favorite: !item.favorite }, false);
  };

  const handleDelete = async () => {
    if (!confirm(`确定删除 "${item.title}"？此操作不可撤销。`)) return;
    await deleteItem(item.vaultId, item.id);
  };

  const isSshKey = item.category === 'ssh_key';
  const isApiCredential = item.category === 'api_credential';
  const securityWarning = securityIssues[item.id];

  const sshPublicKey = isSshKey
    ? item.customFields.find((f) => f.label.trim().toLowerCase() === 'public_key')?.value.trim()
    : undefined;
  const sshPassphrase = isSshKey
    ? item.customFields.find((f) => f.label.trim().toLowerCase() === 'passphrase')?.value
    : undefined;
  const displayCustomFields = isSshKey
    ? item.customFields.filter((f) => {
        const key = f.label.trim().toLowerCase();
        return key !== 'public_key' && key !== 'passphrase';
      })
    : item.customFields;

  const hasCredentialRows = Boolean(
    item.username ||
      item.password ||
      totpState ||
      item.emailAlias ||
      item.urls.length > 0 ||
      sshPublicKey ||
      sshPassphrase
  );

  const card = item.card;
  const expiryStr = card ? formatExpiry(card.expMonth, card.expYear) : '';
  const hasCardRows = Boolean(
    card && (card.cardholderName || card.number || expiryStr || card.cvv || card.brand)
  );
  const identity = item.identity;
  const fullAddress = identity ? formatFullAddress(identity) : '';
  const visibleIdentityRows = identity
    ? IDENTITY_FIELD_ROWS.filter((row) => Boolean(identity[row.key]))
    : [];

  const usernameLabel = isApiCredential ? '凭证标识' : '用户名 / 邮箱';
  const passwordLabel = isApiCredential
    ? 'API Key'
    : isSshKey
      ? '私钥 (Private Key)'
      : item.category === 'secure_note'
        ? '密钥内容'
        : '密码';
  const urlsLabel = isApiCredential ? 'Endpoint' : isSshKey ? '主机 / Git' : '关联网址';

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-2xl space-y-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 border-b border-border pb-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
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

            {item.tags.length > 0 && (
              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                {item.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => onSelectGroup?.(tag)}
                    className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <span>#{tag}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {allGroups.length > 0 && (
              <div ref={groupMenuRef} className="relative">
                <button
                  type="button"
                  onClick={() => setGroupMenuOpen((v) => !v)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted"
                  title="管理所属分组"
                >
                  <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>分组</span>
                </button>
                {groupMenuOpen && (
                  <div className="absolute right-0 top-10 z-30 w-44 rounded-lg border border-border bg-card p-1 text-xs text-foreground shadow-lg">
                    <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                      所属分组（多选）
                    </div>
                    {allGroups.map((g) => {
                      const active = item.tags.some(
                        (t) => t.trim().toLowerCase() === g.toLowerCase()
                      );
                      return (
                        <button
                          key={g}
                          type="button"
                          onClick={() => void toggleItemGroup(item, g)}
                          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                        >
                          <span className="truncate">{g}</span>
                          {active && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" />}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

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

        {/* Security Warning Banner */}
        {securityWarning && (
          <div className="flex items-center justify-between gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
            <div className="flex items-center gap-3">
              <AlertCircle className="h-5 w-5 shrink-0 text-rose-600 dark:text-rose-400" />
              <div>
                <div className="text-xs font-semibold text-rose-700 dark:text-rose-300">
                  安全警告：{securityWarning}
                </div>
                <div className="mt-0.5 text-xs text-rose-600/90 dark:text-rose-300/80">
                  建议点击右上角「编辑」更换为独立随机强密码。
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => onEdit(item)}
              className="shrink-0 rounded-md border border-rose-500/30 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            >
              立即修改
            </button>
          </div>
        )}

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
            <CopyButton
              value={matchedEmailOtp.otpCode}
              label="复制验证码"
              onCopy={() => scheduleEmailAutoDelete(matchedEmailOtp.id)}
            />
          </div>
        )}

        {/* Primary Credentials / SSH / API Card */}
        {hasCredentialRows && (
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {isSshKey && sshPublicKey && (
              <div className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    公钥 (Public Key)
                  </div>
                  <div className="mt-1 break-all font-mono text-xs text-foreground select-all">
                    {sshPublicKey}
                  </div>
                </div>
                <CopyButton value={sshPublicKey} label="复制" />
              </div>
            )}

            {item.username && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    {usernameLabel}
                  </div>
                  <div
                    className={`mt-1 truncate text-sm text-foreground select-all ${
                      isApiCredential ? 'font-mono' : ''
                    }`}
                  >
                    {item.username}
                  </div>
                </div>
                <CopyButton value={item.username} label="复制" />
              </div>
            )}

            {item.password && (
              <div className="flex items-start justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    {passwordLabel}
                  </div>
                  {isSshKey && revealPassword ? (
                    <pre className="mt-1.5 max-h-56 overflow-auto rounded-lg border border-border bg-background p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all text-foreground select-all">
                      {item.password}
                    </pre>
                  ) : (
                    <div className="mt-1 truncate font-mono text-sm text-foreground select-all">
                      {revealPassword ? item.password : '••••••••••••••••••••'}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
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
                  <CopyButton value={item.password} label="复制" />
                </div>
              </div>
            )}

            {isSshKey && sshPassphrase && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    私钥口令 (Passphrase)
                  </div>
                  <div className="mt-1 truncate font-mono text-sm text-foreground select-all">
                    {revealPassphrase ? sshPassphrase : '••••••••••••'}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRevealPassphrase((v) => !v)}
                    className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={revealPassphrase ? '隐藏' : '显示'}
                  >
                    {revealPassphrase ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <CopyButton value={sshPassphrase} label="复制" />
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
                      2FA 动态码 · {totpState.remaining}s
                    </div>
                    <div className="mt-0.5 font-mono text-xl font-bold tracking-wider text-foreground">
                      {totpState.code.length === 6
                        ? `${totpState.code.slice(0, 3)} ${totpState.code.slice(3)}`
                        : totpState.code}
                    </div>
                  </div>
                </div>
                <CopyButton value={totpState.code} label="复制" />
              </div>
            )}

            {item.emailAlias && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    邮箱别名
                  </div>
                  <div className="mt-1 truncate font-mono text-sm text-foreground">
                    {item.emailAlias}
                  </div>
                </div>
                <CopyButton value={item.emailAlias} label="复制" />
              </div>
            )}

            {item.urls.length > 0 && (
              <div className="space-y-2 p-4">
                <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                  {urlsLabel}
                </div>
                {item.urls.map((u, idx) => {
                  const isHttpUrl = /^https?:\/\//i.test(u);
                  return (
                    <div key={idx} className="flex items-center justify-between gap-2">
                      {isHttpUrl ? (
                        <a
                          href={u}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 truncate text-sm text-foreground underline underline-offset-4 hover:opacity-75"
                        >
                          <span className="truncate">{u}</span>
                          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        </a>
                      ) : (
                        <span className="truncate font-mono text-sm text-foreground select-all">
                          {u}
                        </span>
                      )}
                      <CopyButton value={u} />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Card Details */}
        {hasCardRows && card && (
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {card.brand && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    发卡组织 / 品牌
                  </div>
                  <div className="mt-1 text-sm text-foreground">{card.brand}</div>
                </div>
                <CopyButton value={card.brand} label="复制" />
              </div>
            )}

            {card.cardholderName && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    持卡人
                  </div>
                  <div className="mt-1 text-sm text-foreground select-all">
                    {card.cardholderName}
                  </div>
                </div>
                <CopyButton value={card.cardholderName} label="复制" />
              </div>
            )}

            {card.number && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    卡号
                  </div>
                  <div className="mt-1 font-mono text-sm text-foreground select-all">
                    {revealCard ? card.number : maskCardNumber(card.number)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setRevealCard((v) => !v)}
                    className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    title={revealCard ? '隐藏卡号与 CVV' : '显示卡号与 CVV'}
                  >
                    {revealCard ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </button>
                  <CopyButton value={card.number} label="复制" />
                </div>
              </div>
            )}

            {expiryStr && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    有效期
                  </div>
                  <div className="mt-1 font-mono text-sm text-foreground">{expiryStr}</div>
                </div>
                <CopyButton value={expiryStr} label="复制" />
              </div>
            )}

            {card.cvv && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    安全码 (CVV)
                  </div>
                  <div className="mt-1 font-mono text-sm text-foreground select-all">
                    {revealCard ? card.cvv : '•••'}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!card.number && (
                    <button
                      type="button"
                      onClick={() => setRevealCard((v) => !v)}
                      className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title={revealCard ? '隐藏' : '显示'}
                    >
                      {revealCard ? (
                        <EyeOff className="h-3.5 w-3.5" />
                      ) : (
                        <Eye className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  <CopyButton value={card.cvv} label="复制" />
                </div>
              </div>
            )}
          </div>
        )}

        {/* Identity Details */}
        {visibleIdentityRows.length > 0 && identity && (
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {fullAddress && (
              <div className="flex items-center justify-between gap-4 p-4">
                <div className="min-w-0">
                  <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                    完整地址
                  </div>
                  <div className="mt-1 text-sm text-foreground">{fullAddress}</div>
                </div>
                <CopyButton value={fullAddress} label="复制地址" />
              </div>
            )}
            {visibleIdentityRows.map((row) => {
              const val = identity[row.key] ?? '';
              return (
                <div key={row.key} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                      {row.label}
                    </div>
                    <div className="mt-1 truncate text-sm text-foreground select-all">{val}</div>
                  </div>
                  <CopyButton value={val} label="复制" />
                </div>
              );
            })}
          </div>
        )}

        {/* Custom Fields */}
        {displayCustomFields.length > 0 && (
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {displayCustomFields.map((cf) => {
              const isConcealed = cf.type === 'concealed';
              const shown = !isConcealed || revealCustom || revealPassword;
              return (
                <div key={cf.id} className="flex items-center justify-between gap-4 p-4">
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
                      {cf.label}
                    </div>
                    <div className="mt-1 truncate font-mono text-sm text-foreground select-all">
                      {shown ? cf.value : '••••••••••••'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {isConcealed && (
                      <button
                        type="button"
                        onClick={() => setRevealCustom((v) => !v)}
                        className="rounded-md border border-border bg-background p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title={shown ? '隐藏' : '显示'}
                      >
                        {shown ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    <CopyButton value={cf.value} label="复制" />
                  </div>
                </div>
              );
            })}
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
      </div>
    </div>
  );
};
