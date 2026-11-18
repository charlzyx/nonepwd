import React, { useState } from 'react';
import { type ItemCategory } from '@nonepwd/core';
import {
  AlertCircle,
  Code2,
  CreditCard,
  Filter,
  FolderLock,
  Globe,
  Inbox,
  KeyRound,
  Lock,
  Mail,
  Moon,
  Plus,
  Puzzle,
  Settings,
  ShieldCheck,
  Star,
  StickyNote,
  Sun,
  Tag,
  Terminal,
  Trash2,
  Upload,
  User,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useTheme } from '../state/theme';
import { useVault } from '../state/VaultContext';
import { BrandMark } from './BrandMark';

export type SettingsFocusTab = 'alias' | 'imap' | 'filter' | 'backup';

export type ActiveSection =
  | {
      kind: 'items';
      category?: ItemCategory;
      twoFactorOnly?: boolean;
      securityOnly?: boolean;
      favoritesOnly?: boolean;
      group?: string;
    }
  | { kind: 'email_otp' }
  | { kind: 'developer' }
  | { kind: 'settings'; focusTab?: SettingsFocusTab };

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
  const {
    vaults,
    items,
    emails,
    wsConnected,
    imapConfig,
    imapAccounts,
    allGroups,
    securityIssues,
    lock,
    createVault,
    addGroup,
    removeGroup,
    account,
  } = useVault();
  const { isDark, toggleTheme } = useTheme();
  const [creatingVault, setCreatingVault] = useState(false);
  const [newVaultName, setNewVaultName] = useState('');
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');

  const loginCount = items.filter((i) => i.category === 'login').length;
  const twoFactorCount = items.filter((i) => Boolean(i.totp?.trim())).length;
  const otpEmailCount = emails.filter((e) => Boolean(e.otpCode?.trim())).length;
  const securityCount = Object.keys(securityIssues).length;
  const favoriteCount = items.filter((i) => i.favorite).length;

  const isPlainItemsView =
    section.kind === 'items' &&
    !section.category &&
    !section.twoFactorOnly &&
    !section.securityOnly &&
    !section.favoritesOnly &&
    !section.group;

  const handleCreateVault = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newVaultName.trim();
    if (!trimmed) return;
    const created = await createVault(trimmed);
    setNewVaultName('');
    setCreatingVault(false);
    onSelectVault(created.id);
    onSelectSection({ kind: 'items' });
  };

  const handleCreateGroup = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newGroupName.trim();
    if (!trimmed) return;
    addGroup(trimmed);
    setNewGroupName('');
    setCreatingGroup(false);
    onSelectVault('all');
    onSelectSection({ kind: 'items', group: trimmed });
  };

  const navClass = (active: boolean) =>
    `flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
      active
        ? 'bg-muted font-medium text-foreground'
        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
    }`;

  const bentoTiles: Array<{
    key: string;
    title: string;
    count: number;
    tint: string;
    active: boolean;
    icon: React.ReactNode;
    onClick: () => void;
  }> = [
    {
      key: 'all',
      title: '全部',
      count: items.length,
      tint: '#3657f5',
      active: selectedVaultId === 'all' && isPlainItemsView,
      icon: <KeyRound className="h-3.5 w-3.5" />,
      onClick: () => {
        onSelectVault('all');
        onSelectSection({ kind: 'items' });
      },
    },
    {
      key: 'login',
      title: '密码登录',
      count: loginCount,
      tint: '#2ec24f',
      active:
        selectedVaultId === 'all' &&
        section.kind === 'items' &&
        section.category === 'login' &&
        !section.twoFactorOnly &&
        !section.securityOnly &&
        !section.favoritesOnly &&
        !section.group,
      icon: <Globe className="h-3.5 w-3.5" />,
      onClick: () => {
        onSelectVault('all');
        onSelectSection({ kind: 'items', category: 'login' });
      },
    },
    {
      key: '2fa',
      title: '验证码',
      count: twoFactorCount,
      tint: '#e6bd26',
      active: selectedVaultId === 'all' && section.kind === 'items' && Boolean(section.twoFactorOnly),
      icon: <ShieldCheck className="h-3.5 w-3.5" />,
      onClick: () => {
        onSelectVault('all');
        onSelectSection({ kind: 'items', twoFactorOnly: true });
      },
    },
    {
      key: 'email_otp',
      title: '收件验证码',
      count: otpEmailCount,
      tint: '#389be6',
      active: section.kind === 'email_otp',
      icon: <Mail className="h-3.5 w-3.5" />,
      onClick: () => {
        onSelectSection({ kind: 'email_otp' });
      },
    },
    {
      key: 'security',
      title: '安全性',
      count: securityCount,
      tint: '#e03b33',
      active: selectedVaultId === 'all' && section.kind === 'items' && Boolean(section.securityOnly),
      icon: <AlertCircle className="h-3.5 w-3.5" />,
      onClick: () => {
        onSelectVault('all');
        onSelectSection({ kind: 'items', securityOnly: true });
      },
    },
    {
      key: 'favorites',
      title: '收藏夹',
      count: favoriteCount,
      tint: '#ed8a24',
      active:
        selectedVaultId === 'all' && section.kind === 'items' && Boolean(section.favoritesOnly),
      icon: <Star className="h-3.5 w-3.5" />,
      onClick: () => {
        onSelectVault('all');
        onSelectSection({ kind: 'items', favoritesOnly: true });
      },
    },
  ];

  const fillCategories: Array<{
    category: ItemCategory;
    label: string;
    icon: React.ReactNode;
    tintClass: string;
    count: number;
  }> = [
    {
      category: 'api_credential',
      label: 'API 密钥',
      icon: <Code2 className="h-3.5 w-3.5" />,
      tintClass: 'text-indigo-600 dark:text-indigo-400',
      count: items.filter((i) => i.category === 'api_credential').length,
    },
    {
      category: 'ssh_key',
      label: 'SSH 密钥',
      icon: <Terminal className="h-3.5 w-3.5" />,
      tintClass: 'text-slate-600 dark:text-slate-300',
      count: items.filter((i) => i.category === 'ssh_key').length,
    },
    {
      category: 'card',
      label: '银行卡',
      icon: <CreditCard className="h-3.5 w-3.5" />,
      tintClass: 'text-emerald-600 dark:text-emerald-400',
      count: items.filter((i) => i.category === 'card').length,
    },
    {
      category: 'identity',
      label: '身份与地址',
      icon: <User className="h-3.5 w-3.5" />,
      tintClass: 'text-sky-600 dark:text-sky-400',
      count: items.filter((i) => i.category === 'identity').length,
    },
    {
      category: 'secure_note',
      label: '安全笔记',
      icon: <StickyNote className="h-3.5 w-3.5" />,
      tintClass: 'text-amber-600 dark:text-amber-400',
      count: items.filter((i) => i.category === 'secure_note').length,
    },
  ];

  const anyImapListening =
    imapAccounts.some((a) => a.status === 'listening') || imapConfig?.status === 'listening';
  const anyImapError =
    imapAccounts.some((a) => a.status === 'error') || imapConfig?.status === 'error';
  const anyImapConnecting =
    imapAccounts.some((a) => a.status === 'connecting') || imapConfig?.status === 'connecting';

  const imapDotClass = anyImapListening
    ? 'bg-emerald-500'
    : anyImapError
      ? 'bg-rose-500'
      : anyImapConnecting
        ? 'bg-amber-500'
        : 'bg-muted-foreground/40';

  const imapStatusLabel = anyImapListening
    ? 'listening'
    : anyImapError
      ? 'error'
      : anyImapConnecting
        ? 'connecting'
        : imapConfig?.status ?? 'disabled';

  return (
    <aside className="flex h-full w-[264px] shrink-0 flex-col border-r border-border bg-card text-foreground">
      {/* Header: Brand + email + Live/Sync pill + Theme switch */}
      <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BrandMark className="size-8" />
          <div className="min-w-0">
            <div className="text-sm font-semibold tracking-tight text-foreground">nonepwd</div>
            <div className="max-w-[105px] truncate font-mono text-[10px] text-muted-foreground">
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

      {/* Scrollable Body */}
      <div className="flex-1 space-y-4 overflow-y-auto px-3 py-3">
        {/* 2x3 Bento Grid */}
        <div className="grid grid-cols-2 gap-2">
          {bentoTiles.map((tile) => (
            <button
              key={tile.key}
              type="button"
              onClick={tile.onClick}
              style={tile.active ? { backgroundColor: tile.tint } : undefined}
              className={`group flex flex-col justify-between rounded-2xl p-2.5 text-left transition-all ${
                tile.active
                  ? 'text-white shadow-xs'
                  : 'border border-border/70 bg-background/80 text-foreground hover:bg-muted/70'
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <span
                  style={tile.active ? { color: tile.tint } : { backgroundColor: tile.tint }}
                  className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${
                    tile.active ? 'bg-white' : 'text-white'
                  }`}
                >
                  {tile.icon}
                </span>
                <span
                  className={`pt-0.5 font-mono text-xs font-semibold tabular-nums ${
                    tile.active ? 'text-white/95' : 'text-muted-foreground'
                  }`}
                >
                  {tile.count}
                </span>
              </div>
              <div
                className={`mt-2 truncate text-xs font-medium ${
                  tile.active ? 'text-white' : 'text-foreground'
                }`}
              >
                {tile.title}
              </div>
            </button>
          ))}
        </div>

        {/* 填充与密文 */}
        <div>
          <div className="mb-1 px-2 text-[11px] font-medium text-muted-foreground">填充与密文</div>
          <div className="space-y-0.5">
            {fillCategories.map((entry) => {
              const active =
                selectedVaultId === 'all' &&
                section.kind === 'items' &&
                section.category === entry.category &&
                !section.twoFactorOnly &&
                !section.securityOnly &&
                !section.favoritesOnly &&
                !section.group;
              return (
                <button
                  key={entry.category}
                  type="button"
                  onClick={() => {
                    onSelectVault('all');
                    onSelectSection({ kind: 'items', category: entry.category });
                  }}
                  className={navClass(active)}
                >
                  <span className="flex items-center gap-2">
                    <span className={active ? 'text-foreground' : entry.tintClass}>{entry.icon}</span>
                    <span>{entry.label}</span>
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {entry.count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 分组 */}
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-muted-foreground">分组</span>
            <button
              type="button"
              onClick={() => setCreatingGroup((v) => !v)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="新建分组"
              aria-label="新建分组"
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>

          {creatingGroup && (
            <form onSubmit={handleCreateGroup} className="mb-2 flex gap-1 px-1">
              <input
                type="text"
                autoFocus
                value={newGroupName}
                onChange={(e) => setNewGroupName(e.target.value)}
                placeholder="分组名称 (如 AI)"
                className="w-full rounded-md border border-input bg-background px-2.5 py-1 text-xs text-foreground outline-none focus:border-ring"
              />
              <button
                type="submit"
                className="shrink-0 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/85"
              >
                添加
              </button>
            </form>
          )}

          {allGroups.length === 0 ? (
            <p className="px-2 py-1 text-[11px] text-muted-foreground/80">
              点击 + 新建分组，支持条目多选归类
            </p>
          ) : (
            <div className="space-y-0.5">
              {allGroups.map((group) => {
                const count = items.filter((i) =>
                  i.tags.some((t) => t.trim().toLowerCase() === group.toLowerCase())
                ).length;
                const active =
                  selectedVaultId === 'all' &&
                  section.kind === 'items' &&
                  section.group?.toLowerCase() === group.toLowerCase();
                return (
                  <div
                    key={group}
                    className={`group flex items-center justify-between rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                      active
                        ? 'bg-muted font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelectVault('all');
                        onSelectSection({ kind: 'items', group });
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Tag className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{group}</span>
                    </button>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeGroup(group);
                          if (active) {
                            onSelectSection({ kind: 'items' });
                          }
                        }}
                        title={`删除分组「${group}」`}
                        aria-label={`删除分组 ${group}`}
                        className="rounded p-0.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-rose-600 focus:opacity-100 dark:hover:text-rose-400"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                        {count}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 密码库 */}
        <div>
          <div className="mb-1 flex items-center justify-between px-2">
            <span className="text-[11px] font-medium text-muted-foreground">密码库</span>
            <button
              type="button"
              onClick={() => setCreatingVault((v) => !v)}
              className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="新建独立密码库"
              aria-label="新建独立密码库"
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
                className="shrink-0 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/85"
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
              className={navClass(selectedVaultId === 'all' && isPlainItemsView)}
            >
              <span className="flex items-center gap-2">
                <FolderLock className="h-3.5 w-3.5 text-muted-foreground" />
                <span>全部密码库</span>
              </span>
              <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                {items.length}
              </span>
            </button>

            {vaults.map((v) => {
              const count = items.filter((i) => i.vaultId === v.id).length;
              const active = selectedVaultId === v.id && isPlainItemsView;
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    onSelectVault(v.id);
                    onSelectSection({ kind: 'items' });
                  }}
                  className={navClass(active)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/50" />
                    <span className="truncate">{v.metadata.name}</span>
                  </span>
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {count}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 连接与工具 */}
        <div>
          <div className="mb-1 px-2 text-[11px] font-medium text-muted-foreground">连接与工具</div>
          <div className="space-y-0.5">
            <a
              href="/downloads/nonepwd-extension.zip"
              download="nonepwd-extension.zip"
              className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
            >
              <span className="flex items-center gap-2">
                <Puzzle className="h-3.5 w-3.5 text-blue-600 dark:text-blue-400" />
                <span>浏览器自动填充扩展</span>
              </span>
            </a>

            {onOpenImportCsv && (
              <button
                type="button"
                onClick={onOpenImportCsv}
                className={navClass(false)}
              >
                <span className="flex items-center gap-2">
                  <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>导入密码 / 2FA</span>
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => onSelectSection({ kind: 'settings', focusTab: 'imap' })}
              className={navClass(
                section.kind === 'settings' && section.focusTab === 'imap'
              )}
            >
              <span className="flex items-center gap-2">
                <Inbox className="h-3.5 w-3.5 text-muted-foreground" />
                <span>邮箱 IMAP 收信</span>
              </span>
              <span
                title={
                  imapAccounts.length > 0
                    ? `IMAP 状态：${imapStatusLabel}（已启用 ${imapAccounts.filter((a) => a.enabled).length}/${imapAccounts.length} 个邮箱）`
                    : `IMAP 状态：${imapStatusLabel}`
                }
                className={`h-2 w-2 rounded-full ${imapDotClass}`}
              />
            </button>

            <button
              type="button"
              onClick={() => onSelectSection({ kind: 'settings', focusTab: 'filter' })}
              className={navClass(
                section.kind === 'settings' && section.focusTab === 'filter'
              )}
            >
              <span className="flex items-center gap-2">
                <Filter className="h-3.5 w-3.5 text-muted-foreground" />
                <span>邮件接收过滤</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => onSelectSection({ kind: 'developer' })}
              className={navClass(section.kind === 'developer')}
            >
              <span className="flex items-center gap-2">
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                <span>Service Account (CLI)</span>
              </span>
            </button>
          </div>
        </div>
      </div>

      {/* Footer: Account email + Settings + Lock button */}
      <div className="space-y-2 border-t border-border p-3">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {account?.email ?? ''}
          </span>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'settings' })}
            title="打开设置"
            aria-label="打开设置"
            className={`rounded-md p-1 transition-colors ${
              section.kind === 'settings' && !section.focusTab
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => void lock()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:border-rose-500/50 hover:text-rose-600 dark:hover:text-rose-400"
        >
          <Lock className="h-3.5 w-3.5" />
          <span>锁定密码库</span>
        </button>
      </div>
    </aside>
  );
};
