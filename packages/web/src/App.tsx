import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type VaultItemPayload } from '@nonepwd/core';
import { Download, ExternalLink, ShieldCheck, Terminal } from 'lucide-react';
import { CopyButton } from './components/CopyButton';
import { DeveloperView } from './components/DeveloperView';
import { EmailOtpView } from './components/EmailOtpView';
import { ItemDetail } from './components/ItemDetail';
import { ItemList } from './components/ItemList';
import { ItemModal } from './components/ItemModal';
import { LandingPage } from './components/LandingPage';
import { SettingsView } from './components/SettingsView';
import { SetupWizard } from './components/SetupWizard';
import { Sidebar, type ActiveSection } from './components/Sidebar';
import { UnlockScreen } from './components/UnlockScreen';
import { useVault, VaultProvider } from './state/VaultContext';

const StandaloneVaultGuide: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const cliInstallCmd = origin
    ? `curl -fsSL ${origin}/install.sh | bash`
    : 'npm install -g @nonepwd/cli';

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.16),_#0b0e14_65%)] p-6 text-slate-100">
      <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-[#121622]/95 p-8 shadow-2xl shadow-black/60">
        <div className="mb-4 flex items-center justify-between">
          <button
            type="button"
            onClick={onBackHome}
            className="text-xs text-slate-400 transition hover:text-indigo-300"
          >
            ← 返回 nonepwd 官网
          </button>
          <span className="rounded-full border border-emerald-500/35 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
            Zero-Knowledge Self-Hosted
          </span>
        </div>

        <div className="mb-6 flex items-center gap-3.5">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-indigo-600/20 text-indigo-400 ring-1 ring-indigo-500/40">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">启动你的私有 nonepwd 密码库</h1>
            <p className="mt-1 text-xs leading-relaxed text-slate-400">
              当前访问的是公开官网，从不托管任何用户密文或密钥。请在本地或自有服务器一条命令启动属于你的零知识 Vault 实例。
            </p>
          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-xl border border-slate-800 bg-[#0b0e14] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-white">第 1 步：启动私有零知识服务端</span>
              <CopyButton value="npx @nonepwd/server" label="复制" />
            </div>
            <pre className="overflow-x-auto font-mono text-xs text-indigo-200">
              npx @nonepwd/server
            </pre>
            <p className="mt-2 text-[11px] text-slate-400">
              启动后将自动托管本地 SQLite 密文库、Web 管理台与 WebSocket 实时推送（默认端口 8787）。
            </p>
          </div>

          <div className="rounded-xl border border-slate-800 bg-[#0b0e14] p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-semibold text-white">第 2 步：安装原生 Rust CLI（`np`）</span>
              <CopyButton value={cliInstallCmd} label="复制" />
            </div>
            <pre className="overflow-x-auto font-mono text-xs text-emerald-300">
              {`${cliInstallCmd}\n# 或通过 npm 全局安装：\nnpm install -g @nonepwd/cli`}
            </pre>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <a
              href="http://127.0.0.1:8787/vault"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-500"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              <span>打开本地实例 (127.0.0.1:8787/vault)</span>
            </a>
            <a
              href="/downloads/nonepwd-extension.zip"
              download="nonepwd-extension.zip"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#0b0e14] px-4 py-2.5 text-xs font-medium text-slate-200 transition hover:border-indigo-500/50 hover:text-white"
            >
              <Download className="h-3.5 w-3.5 text-indigo-400" />
              <span>下载浏览器插件包</span>
            </a>
            <a
              href="/demo-login"
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#0b0e14] px-4 py-2.5 text-xs font-medium text-slate-200 transition hover:border-emerald-500/50 hover:text-white"
            >
              <Terminal className="h-3.5 w-3.5 text-emerald-400" />
              <span>体验 6 宫格沙盒</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

const WorkspaceApp: React.FC<{ onNavigateHome: () => void }> = ({ onNavigateHome }) => {
  const { phase, items } = useVault();
  const [selectedVaultId, setSelectedVaultId] = useState<string | 'all'>('all');
  const [section, setSection] = useState<ActiveSection>({ kind: 'items' });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [modalItem, setModalItem] = useState<VaultItemPayload | null | undefined>(undefined);

  const filteredItems = useMemo(() => {
    let list = items;
    if (selectedVaultId !== 'all') {
      list = list.filter((i) => i.vaultId === selectedVaultId);
    }
    if (section.kind === 'items') {
      if (section.favoritesOnly) list = list.filter((i) => i.favorite);
      if (section.category) list = list.filter((i) => i.category === section.category);
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (i) =>
          i.title.toLowerCase().includes(q) ||
          (i.username ?? '').toLowerCase().includes(q) ||
          (i.emailAlias ?? '').toLowerCase().includes(q) ||
          i.urls.some((u) => u.toLowerCase().includes(q)) ||
          i.tags.some((t) => t.toLowerCase().includes(q))
      );
    }
    return list;
  }, [items, searchQuery, section, selectedVaultId]);

  const activeItem = useMemo(
    () =>
      filteredItems.find((i) => i.id === selectedItemId) ??
      items.find((i) => i.id === selectedItemId) ??
      filteredItems[0] ??
      null,
    [filteredItems, items, selectedItemId]
  );

  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0b0e14] text-sm text-slate-400">
        正在连接 nonepwd 零知识服务端...
      </div>
    );
  }

  if (phase === 'standalone') {
    return <StandaloneVaultGuide onBackHome={onNavigateHome} />;
  }

  if (phase === 'uninitialized') {
    return <SetupWizard onBackHome={onNavigateHome} />;
  }

  if (phase === 'locked') {
    return <UnlockScreen onBackHome={onNavigateHome} />;
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[#0b0e14] text-slate-100">
      <Sidebar
        selectedVaultId={selectedVaultId}
        onSelectVault={setSelectedVaultId}
        section={section}
        onSelectSection={setSection}
        onBackHome={onNavigateHome}
      />

      {section.kind === 'items' && (
        <>
          <ItemList
            items={filteredItems}
            selectedItemId={activeItem?.id ?? null}
            onSelectItem={setSelectedItemId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            onCreateNew={() => setModalItem(null)}
          />
          <ItemDetail item={activeItem} onEdit={(it) => setModalItem(it)} />
        </>
      )}

      {section.kind === 'email_otp' && <EmailOtpView />}
      {section.kind === 'developer' && <DeveloperView />}
      {section.kind === 'settings' && <SettingsView />}

      {modalItem !== undefined && (
        <ItemModal
          initialItem={modalItem}
          defaultVaultId={selectedVaultId}
          onClose={() => setModalItem(undefined)}
          onSaved={(saved) => setSelectedItemId(saved.id)}
        />
      )}
    </div>
  );
};

const RouterView: React.FC = () => {
  const [routePath, setRoutePath] = useState(() =>
    typeof window !== 'undefined' ? window.location.pathname : '/'
  );

  useEffect(() => {
    const onPopState = () => {
      setRoutePath(window.location.pathname);
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setRoutePath(nextPath);
    window.scrollTo({ top: 0 });
  }, []);

  if (routePath.startsWith('/vault')) {
    return <WorkspaceApp onNavigateHome={() => navigate('/')} />;
  }
  return <LandingPage onOpenVault={() => navigate('/vault')} />;
};

export const App: React.FC = () => (
  <VaultProvider>
    <RouterView />
  </VaultProvider>
);

export default App;
