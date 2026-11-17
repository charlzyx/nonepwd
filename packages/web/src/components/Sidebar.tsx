import React, { useState } from 'react';
import {
  Code2,
  CreditCard,
  FolderLock,
  Globe,
  Lock,
  Mail,
  Moon,
  Plus,
  Settings,
  ShieldCheck,
  Star,
  StickyNote,
  Sun,
  Terminal,
  Upload,
  User,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useTheme } from '../state/theme';
import { useVault } from '../state/VaultContext';

export type ActiveSection =
  | { kind: 'items'; category?: string; favoritesOnly?: boolean }
  | { kind: 'email_otp' }
  | { kind: 'developer' }
  | { kind: 'settings' };

interface SidebarProps {
  selectedVaultId: string | 'all';
  onSelectVault: (id: string | 'all') => void;
  section: ActiveSection;
  onSelectSection: (s: ActiveSection) => void;
  onOpenImportCsv?: () => void;
  onBackHome?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  selectedVaultId,
  onSelectVault,
  section,
  onSelectSection,
  onOpenImportCsv,
}) => {
  const { vaults, items, emails, wsConnected, lock, createVault, account } = useVault();
  const { isDark, toggleTheme } = useTheme();
  const [creatingVault, setCreatingVault] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');

  const otpEmailCount = emails.filter((e) => Boolean(e.otpCode)).length;

  const handleCreateVault = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newVaultName.trim()) return;
    const created = await createVault(newVaultName.trim());
    setNewVaultName('');
    setCreatingVault(false);
    onSelectVault(created.id);
    onSelectSection({ kind: 'items' });
  };

  const navClass = (active: boolean) =>
    `flex w-full items-center justify-between rounded-md px-2.5 py-2 text-xs transition-colors ${
      active
        ? 'bg-muted font-medium text-foreground'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
    }`;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card p-3 text-foreground">
      {/* Brand + live sync badge + theme switch */}
      <div className="mb-4 flex items-center justify-between gap-2 px-1.5 pt-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-foreground">nonepwd</div>
            <div className="max-w-[100px] truncate font-mono text-[10px] text-muted-foreground">
              {account?.email}
            </div>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          <span
            title={wsConnected ? 'WebSocket 实时同步已连接' : 'WebSocket 重连中'}
            className={`inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[10px] ${
              wsConnected
                ? 'bg-background text-emerald-600 dark:text-emerald-400'
                : 'bg-background text-amber-600 dark:text-amber-400'
            }`}
          >
            {wsConnected ? <Wifi className="h-2.5 w-2.5" /> : <WifiOff className="h-2.5 w-2.5" />}
            {wsConnected ? 'Live' : 'Sync'}
          </span>

          <button
            type="button"
            onClick={toggleTheme}
            aria-label="切换亮暗模式"
            title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
            className="inline-flex size-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {isDark ? <Sun className="h-3 w-3" /> : <Moon className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {/* Vault Selector */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between px-2 font-mono text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          <span>Vaults</span>
          <button
            type="button"
            onClick={() => setCreatingVault((v) => !v)}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="新建独立密码库"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        </div>

        {creatingVault && (
          <form onSubmit={handleCreateVault} className="mb-2 flex gap-1 px-1">
            <input
              type="text"
              autoFocus
              value={newVaultName}
              onChange={(e) => setNewVaultName(e.target.value)}
              placeholder="库名称 (如 Work)"
              className="w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground outline-none focus:border-ring"
            />
            <button
              type="submit"
              className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/85"
            >
              添加
            </button>
          </form>
        )}

        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => {
              onSelectVault('all');
              onSelectSection({ kind: 'items' });
            }}
            className={navClass(
              selectedVaultId === 'all' &&
                section.kind === 'items' &&
                !section.category &&
                !section.favoritesOnly
            )}
          >
            <span className="flex items-center gap-2">
              <FolderLock className="h-3.5 w-3.5 text-muted-foreground" />
              全部密码库
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">{items.length}</span>
          </button>

          {vaults.map((v) => {
            const count = items.filter((i) => i.vaultId === v.id).length;
            return (
              <button
                key={v.id}
                type="button"
                onClick={() => {
                  onSelectVault(v.id);
                  onSelectSection({ kind: 'items' });
                }}
                className={navClass(selectedVaultId === v.id && section.kind === 'items')}
              >
                <span className="flex items-center gap-2 truncate">
                  <span className="h-1.5 w-1.5 rounded-full bg-foreground/50" />
                  <span className="truncate">{v.metadata.name}</span>
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick Category Views */}
      <div className="mb-4">
        <div className="mb-1.5 px-2 font-mono text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          分类视图
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', favoritesOnly: true })}
            className={navClass(section.kind === 'items' && Boolean(section.favoritesOnly))}
          >
            <span className="flex items-center gap-2">
              <Star className="h-3.5 w-3.5 text-muted-foreground" />
              收藏夹
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'login' })}
            className={navClass(section.kind === 'items' && section.category === 'login')}
          >
            <span className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-muted-foreground" />
              网站登录
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'card' })}
            className={navClass(section.kind === 'items' && section.category === 'card')}
          >
            <span className="flex items-center gap-2">
              <CreditCard className="h-3.5 w-3.5 text-muted-foreground" />
              银行卡
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'identity' })}
            className={navClass(section.kind === 'items' && section.category === 'identity')}
          >
            <span className="flex items-center gap-2">
              <User className="h-3.5 w-3.5 text-muted-foreground" />
              地址身份
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'api_credential' })}
            className={navClass(section.kind === 'items' && section.category === 'api_credential')}
          >
            <span className="flex items-center gap-2">
              <Code2 className="h-3.5 w-3.5 text-muted-foreground" />
              API 密钥
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'secure_note' })}
            className={navClass(section.kind === 'items' && section.category === 'secure_note')}
          >
            <span className="flex items-center gap-2">
              <StickyNote className="h-3.5 w-3.5 text-muted-foreground" />
              安全笔记
            </span>
          </button>
        </div>
      </div>

      {/* Email OTP, Developer & Settings */}
      <div className="mb-4">
        <div className="mb-1.5 px-2 font-mono text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          工具与设置
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'email_otp' })}
            className={navClass(section.kind === 'email_otp')}
          >
            <span className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-muted-foreground" />
              邮箱验证码
            </span>
            {otpEmailCount > 0 && (
              <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-foreground">
                {otpEmailCount}
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'developer' })}
            className={navClass(section.kind === 'developer')}
          >
            <span className="flex items-center gap-2">
              <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
              Service Account
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'settings' })}
            className={navClass(section.kind === 'settings')}
          >
            <span className="flex items-center gap-2">
              <Settings className="h-3.5 w-3.5 text-muted-foreground" />
              设置
            </span>
          </button>
        </div>
      </div>

      <div className="mt-auto space-y-2 border-t border-border pt-3">
        {onOpenImportCsv && (
          <button
            type="button"
            onClick={onOpenImportCsv}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>导入 CSV / 2FA</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => void lock()}
          className="flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-rose-500/50 hover:text-rose-600 dark:hover:text-rose-400"
        >
          <Lock className="h-3.5 w-3.5" />
          <span>锁定密码库</span>
        </button>
      </div>
    </aside>
  );
};
