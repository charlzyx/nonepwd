import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type VaultItemPayload } from '@nonepwd/core';
import { Download, ExternalLink, Terminal } from 'lucide-react';
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
    <div className="min-h-dvh bg-background text-foreground antialiased">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1100px] flex-col border-border/70 md:border-x">
        <header className="flex h-16 items-center justify-between border-b border-border/70 px-5 md:px-10">
          <button
            type="button"
            onClick={onBackHome}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            ← 返回 nonepwd 官网
          </button>
          <span className="rounded-full border border-border px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            Zero-Knowledge Self-Hosted
          </span>
        </header>

        <main className="flex flex-1 flex-col justify-center px-5 py-14 md:px-10">
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Self-Hosted Quickstart
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
              启动你的私有 nonepwd 密码库
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              当前访问的是公开官网，从不托管任何用户密文或密钥。请在本地或自有服务器一条命令启动属于你的零知识 Vault 实例。
            </p>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70">
              <div className="bg-background p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs font-medium text-foreground">
                    01 · 启动私有零知识服务端
                  </span>
                  <CopyButton value="npx @nonepwd/server" label="复制" variant="minimal" />
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                  npx @nonepwd/server
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  默认在 127.0.0.1:8787 托管本地 SQLite 密文库、Web 管理台与 WebSocket 实时推送。
                </p>
              </div>

              <div className="bg-background p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs font-medium text-foreground">
                    02 · 安装原生 Rust CLI (`np`)
                  </span>
                  <CopyButton value={cliInstallCmd} label="复制" variant="minimal" />
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                  {`${cliInstallCmd}\n# 或 npm 全局安装：\nnpm install -g @nonepwd/cli`}
                </pre>
              </div>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <a
                href="http://127.0.0.1:8787/vault"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
              >
                <ExternalLink className="size-3.5" />
                <span>打开本地实例 (127.0.0.1:8787/vault)</span>
              </a>
              <a
                href="/downloads/nonepwd-extension.zip"
                download="nonepwd-extension.zip"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-3.5" />
                <span>下载浏览器插件包</span>
              </a>
              <a
                href="/demo-login"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-4 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Terminal className="size-3.5" />
                <span>体验 6 宫格沙盒</span>
              </a>
            </div>
          </div>
        </main>
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
