import React, { useState } from 'react';
import {
  Code2,
  FolderLock,
  Globe,
  KeyRound,
  Lock,
  Mail,
  Plus,
  Settings,
  ShieldCheck,
  Star,
  StickyNote,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react';
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
  onBackHome?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  selectedVaultId,
  onSelectVault,
  section,
  onSelectSection,
  onBackHome,
}) => {
  const { vaults, items, emails, wsConnected, lock, createVault, account } = useVault();
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
    `flex w-full items-center justify-between rounded-lg px-2.5 py-2 text-xs font-medium transition ${
      active
        ? 'bg-indigo-600/20 text-indigo-200 ring-1 ring-indigo-500/30'
        : 'text-slate-400 hover:bg-slate-800/70 hover:text-slate-200'
    }`;

  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-slate-800/80 bg-[#0e121b] p-3">
      {/* Brand + live sync badge */}
      <div className="mb-4 flex items-center justify-between px-1.5 pt-1">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-600 text-white shadow-md shadow-indigo-600/30">
            <ShieldCheck className="h-4.5 w-4.5" />
          </div>
          <div>
            <div className="text-sm font-semibold text-white">nonepwd</div>
            <div className="max-w-[125px] truncate text-[10px] text-slate-500">
              {account?.email}
            </div>
          </div>
        </div>
        <span
          title={wsConnected ? 'WebSocket 实时同步已连接' : 'WebSocket 重连中'}
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
            wsConnected
              ? 'bg-emerald-500/15 text-emerald-300'
              : 'bg-amber-500/15 text-amber-300'
          }`}
        >
          {wsConnected ? <Wifi className="h-3 w-3" /> : <WifiOff className="h-3 w-3" />}
          {wsConnected ? 'Live' : 'Sync'}
        </span>
      </div>

      {/* Vault Selector */}
      <div className="mb-4">
        <div className="mb-1.5 flex items-center justify-between px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          <span>密码库 (Vaults)</span>
          <button
            type="button"
            onClick={() => setCreatingVault((v) => !v)}
            className="rounded p-0.5 text-slate-400 hover:bg-slate-800 hover:text-white"
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
              className="w-full rounded-lg border border-slate-700 bg-[#0b0e14] px-2.5 py-1 text-xs text-white outline-none focus:border-indigo-500"
            />
            <button
              type="submit"
              className="rounded-lg bg-indigo-600 px-2 py-1 text-xs font-medium text-white hover:bg-indigo-500"
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
            className={navClass(selectedVaultId === 'all' && section.kind === 'items' && !section.category && !section.favoritesOnly)}
          >
            <span className="flex items-center gap-2">
              <FolderLock className="h-3.5 w-3.5 text-indigo-400" />
              全部密码库
            </span>
            <span className="text-[11px] text-slate-500">{items.length}</span>
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
                  <span className="h-2 w-2 rounded-full bg-indigo-400" />
                  <span className="truncate">{v.metadata.name}</span>
                </span>
                <span className="text-[11px] text-slate-500">{count}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Quick Category Views */}
      <div className="mb-4">
        <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          分类视图
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', favoritesOnly: true })}
            className={navClass(section.kind === 'items' && Boolean(section.favoritesOnly))}
          >
            <span className="flex items-center gap-2">
              <Star className="h-3.5 w-3.5 text-amber-400" />
              收藏夹
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'login' })}
            className={navClass(section.kind === 'items' && section.category === 'login')}
          >
            <span className="flex items-center gap-2">
              <Globe className="h-3.5 w-3.5 text-sky-400" />
              网站登录
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'api_credential' })}
            className={navClass(section.kind === 'items' && section.category === 'api_credential')}
          >
            <span className="flex items-center gap-2">
              <Code2 className="h-3.5 w-3.5 text-emerald-400" />
              API 密钥
            </span>
          </button>
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'items', category: 'secure_note' })}
            className={navClass(section.kind === 'items' && section.category === 'secure_note')}
          >
            <span className="flex items-center gap-2">
              <StickyNote className="h-3.5 w-3.5 text-violet-400" />
              安全笔记
            </span>
          </button>
        </div>
      </div>

      {/* Email OTP, Developer & Settings */}
      <div className="mb-4">
        <div className="mb-1.5 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-500">
          引擎与工具
        </div>
        <div className="space-y-0.5">
          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'email_otp' })}
            className={navClass(section.kind === 'email_otp')}
          >
            <span className="flex items-center gap-2">
              <Mail className="h-3.5 w-3.5 text-indigo-400" />
              邮箱验证码 & 别名
            </span>
            {otpEmailCount > 0 && (
              <span className="rounded-full bg-indigo-600/30 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-200">
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
              <Terminal className="h-3.5 w-3.5 text-emerald-400" />
              CLI & Service Account
            </span>
          </button>

          <button
            type="button"
            onClick={() => onSelectSection({ kind: 'settings' })}
            className={navClass(section.kind === 'settings')}
          >
            <span className="flex items-center gap-2">
              <Settings className="h-3.5 w-3.5 text-slate-400" />
              IMAP / Cloudflare 配置
            </span>
          </button>
        </div>
      </div>

      <div className="mt-auto space-y-2 border-t border-slate-800/80 pt-3">
        {onBackHome && (
          <button
            type="button"
            onClick={onBackHome}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-800/70 bg-[#0b0e14]/70 px-3 py-1.5 text-[11px] text-slate-400 transition hover:border-slate-700 hover:text-slate-200"
          >
            ← 返回官网首页
          </button>
        )}
        <a
          href="/demo-login"
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs text-slate-300 transition hover:border-indigo-500/40 hover:text-indigo-200"
        >
          <KeyRound className="h-3.5 w-3.5 text-indigo-400" />
          <span>打开自动填充测试页</span>
        </a>
        <button
          type="button"
          onClick={() => void lock()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-800 bg-[#0b0e14] px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-rose-500/40 hover:text-rose-300"
        >
          <Lock className="h-3.5 w-3.5" />
          <span>立即锁定密码库</span>
        </button>
      </div>
    </aside>
  );
};
