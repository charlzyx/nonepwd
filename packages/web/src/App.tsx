import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type ItemCategory, type VaultItemPayload } from '@nonepwd/core';
import { Download, ExternalLink, Moon, Sun } from 'lucide-react';
import { CopyButton } from './components/CopyButton';
import { DeveloperView } from './components/DeveloperView';
import { EmailOtpView } from './components/EmailOtpView';
import { ImportCsvModal } from './components/ImportCsvModal';
import { ItemDetail } from './components/ItemDetail';
import { ItemList, type ItemSortField } from './components/ItemList';
import { ItemModal } from './components/ItemModal';
import { LandingPage } from './components/LandingPage';
import { SettingsView } from './components/SettingsView';
import { SetupWizard } from './components/SetupWizard';
import { Sidebar, type ActiveSection } from './components/Sidebar';
import { UnlockScreen } from './components/UnlockScreen';
import { useLocale } from './state/locale';
import { useTheme } from './state/theme';
import { useVault, VaultProvider } from './state/VaultContext';

const StandaloneVaultGuide: React.FC<{ onBackHome: () => void }> = ({ onBackHome }) => {
  const { isDark, toggleTheme } = useTheme();
  const { isZh, toggleLocale } = useLocale();
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const cliInstallCmd = origin
    ? `curl -fsSL ${origin}/install.sh | bash`
    : 'npm install -g @nonepwd/cli';
  const copyLabel = isZh ? '复制' : 'Copy';

  return (
    <div className="min-h-dvh bg-background text-foreground antialiased">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1100px] flex-col border-border/70 md:border-x">
        <header className="flex h-16 items-center justify-between border-b border-border/70 px-5 md:px-10">
          <button
            type="button"
            onClick={onBackHome}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            {isZh ? '← 返回 nonepwd 官网' : '← Back to nonepwd'}
          </button>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-border px-2.5 py-0.5 font-mono text-[11px] text-muted-foreground">
              Zero-Knowledge Self-Hosted
            </span>
            <button
              type="button"
              onClick={toggleLocale}
              aria-label={isZh ? 'Switch to English' : '切换到中文'}
              title={isZh ? 'Switch to English' : '切换到中文'}
              className="inline-flex h-7 items-center justify-center rounded-md border border-border/80 bg-background px-2 font-mono text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isZh ? 'EN' : '中'}
            </button>
            <button
              type="button"
              onClick={toggleTheme}
              aria-label={isZh ? '切换亮暗模式' : 'Toggle color theme'}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/80 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>
          </div>
        </header>

        <main className="flex flex-1 flex-col justify-center px-5 py-14 md:px-10">
          <div className="max-w-2xl">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Self-Hosted Quickstart
            </div>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
              {isZh ? '启动你的私有密码库' : 'Start your private vault'}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {isZh
                ? '公开官网不托管任何密文或密钥。选择以下任一方式在本地或自有域名启动实例。'
                : 'This public site stores no user data or keys. Launch your zero-knowledge instance locally or on Cloudflare.'}
            </p>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70">
              <div className="bg-background p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs font-medium text-foreground">
                    {isZh
                      ? '01A · Cloudflare Worker + D1 + R2（Fork 后部署）'
                      : '01A · Cloudflare Worker + D1 + R2 (Fork & Deploy)'}
                  </span>
                  <CopyButton
                    value={`pnpm install && pnpm build:cf-server\ncd packages/cf-server && npx wrangler deploy`}
                    label={copyLabel}
                    variant="minimal"
                  />
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
{`pnpm install && pnpm build:cf-server
cd packages/cf-server && npx wrangler deploy`}
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  {isZh
                    ? '点击官网「一键 Fork 并部署到 Cloudflare」或 Fork 仓库后运行上方命令，无需安装 Rust。'
                    : 'Use the "Fork & Deploy to Cloudflare" button on the homepage, or run the commands above from your fork (no Rust required).'}
                </p>
              </div>

              <div className="bg-background p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs font-medium text-foreground">
                    {isZh ? '01B · 本地 Rust 单二进制服务端' : '01B · Local Single-Binary Server'}
                  </span>
                  <CopyButton value="np server" label={copyLabel} variant="minimal" />
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                  np server
                </pre>
                <p className="mt-2 text-xs text-muted-foreground">
                  {isZh
                    ? '在 127.0.0.1:8787 运行内置 SQLite 密文库与 Web 管理台。'
                    : 'Serves the local SQLite vault and Web UI at 127.0.0.1:8787.'}
                </p>
              </div>

              <div className="bg-background p-5">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-mono text-xs font-medium text-foreground">
                    {isZh ? '02 · 安装原生 np CLI' : '02 · Install Native np CLI'}
                  </span>
                  <CopyButton value={cliInstallCmd} label={copyLabel} variant="minimal" />
                </div>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                  {`${cliInstallCmd}\n${isZh ? '# 或 npm 全局安装：' : '# Or install globally via npm:'}\nnpm install -g @nonepwd/cli`}
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
                <span>
                  {isZh ? '打开本地实例 (127.0.0.1:8787/vault)' : 'Open Local Vault (127.0.0.1:8787/vault)'}
                </span>
              </a>
              <a
                href="https://github.com/charlzyx/nonepwd/releases/download/v0.2.0/NonePwd-macos-arm64.zip"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-3.5" />
                <span>{isZh ? 'macOS 桌面端' : 'macOS App'}</span>
              </a>
              <a
                href="https://github.com/charlzyx/nonepwd/releases/download/v0.2.0/NonePwd-android.apk"
                target="_blank"
                rel="noreferrer"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-3.5" />
                <span>Android APK</span>
              </a>
              <a
                href="/downloads/nonepwd-extension.zip"
                download="nonepwd-extension.zip"
                className="inline-flex h-10 items-center gap-1.5 rounded-lg border border-border bg-background px-3.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-3.5" />
                <span>{isZh ? 'MV3 浏览器插件' : 'MV3 Extension'}</span>
              </a>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};

const CATEGORY_TITLES: Record<ItemCategory, string> = {
  login: '密码登录',
  api_credential: 'API 密钥',
  ssh_key: 'SSH 密钥',
  card: '银行卡',
  identity: '身份与地址',
  secure_note: '安全笔记',
};

const WorkspaceApp: React.FC<{ onNavigateHome: () => void }> = ({ onNavigateHome }) => {
  const { phase, items, vaults, securityIssues } = useVault();
  const [selectedVaultId, setSelectedVaultId] = useState<string | 'all'>('all');
  const [section, setSection] = useState<ActiveSection>({ kind: 'items' });
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<ItemSortField>('title');
  const [sortAscending, setSortAscending] = useState(true);
  const [modalState, setModalState] = useState<
    | {
        item: VaultItemPayload | null;
        defaultCategory?: ItemCategory;
        defaultTags?: string[];
      }
    | undefined
  >(undefined);
  const [importModalOpen, setImportModalOpen] = useState(false);

  const destinationTitle = useMemo(() => {
    if (selectedVaultId !== 'all') {
      return vaults.find((v) => v.id === selectedVaultId)?.metadata.name ?? '密码库';
    }
    if (section.kind !== 'items') return '全部';
    if (section.favoritesOnly) return '收藏夹';
    if (section.twoFactorOnly) return '验证码';
    if (section.securityOnly) return '安全性';
    if (section.group) return section.group;
    if (section.category) return CATEGORY_TITLES[section.category] ?? '全部';
    return '全部';
  }, [section, selectedVaultId, vaults]);

  const filteredItems = useMemo(() => {
    let list = items;
    if (selectedVaultId !== 'all') {
      list = list.filter((i) => i.vaultId === selectedVaultId);
    }
    if (section.kind === 'items') {
      if (section.favoritesOnly) list = list.filter((i) => i.favorite);
      if (section.category) list = list.filter((i) => i.category === section.category);
      if (section.twoFactorOnly) list = list.filter((i) => Boolean(i.totp?.trim()));
      if (section.securityOnly) list = list.filter((i) => Boolean(securityIssues[i.id]));
      if (section.group) {
        const gLower = section.group.trim().toLowerCase();
        list = list.filter((i) => i.tags.some((t) => t.trim().toLowerCase() === gLower));
      }
    }
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((i) => {
        const cardDigits = (i.card?.number ?? '').replace(/\s+/g, '');
        const last4 = cardDigits.slice(-4);
        return (
          i.title.toLowerCase().includes(q) ||
          (i.username ?? '').toLowerCase().includes(q) ||
          (i.emailAlias ?? '').toLowerCase().includes(q) ||
          (i.card?.brand ?? '').toLowerCase().includes(q) ||
          (i.card?.cardholderName ?? '').toLowerCase().includes(q) ||
          last4.includes(q) ||
          (i.identity?.fullName ?? '').toLowerCase().includes(q) ||
          (i.identity?.email ?? '').toLowerCase().includes(q) ||
          (i.identity?.phone ?? '').toLowerCase().includes(q) ||
          (i.identity?.company ?? '').toLowerCase().includes(q) ||
          (i.identity?.city ?? '').toLowerCase().includes(q) ||
          i.urls.some((u) => u.toLowerCase().includes(q)) ||
          i.tags.some((t) => t.toLowerCase().includes(q)) ||
          i.customFields.some(
            (cf) =>
              cf.label.toLowerCase().includes(q) ||
              (cf.type !== 'concealed' && cf.value.toLowerCase().includes(q))
          )
        );
      });
    }
    const sorted = [...list].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'title') {
        cmp = a.title.localeCompare(b.title, 'zh-Hans-CN');
      } else if (sortField === 'website') {
        const ua = a.urls[0] || a.title;
        const ub = b.urls[0] || b.title;
        cmp = ua.localeCompare(ub, 'zh-Hans-CN');
      } else if (sortField === 'createdAt') {
        cmp = a.createdAt.localeCompare(b.createdAt);
      } else {
        cmp = a.updatedAt.localeCompare(b.updatedAt);
      }
      if (cmp === 0) {
        cmp = a.id.localeCompare(b.id);
      }
      return sortAscending ? cmp : -cmp;
    });
    return sorted;
  }, [items, searchQuery, section, securityIssues, selectedVaultId, sortAscending, sortField]);

  const activeItem = useMemo(
    () =>
      filteredItems.find((i) => i.id === selectedItemId) ??
      items.find((i) => i.id === selectedItemId) ??
      filteredItems[0] ??
      null,
    [filteredItems, items, selectedItemId]
  );

  const handleOpenCreateModal = useCallback(
    (explicitCategory?: ItemCategory) => {
      const defaultCategory: ItemCategory =
        explicitCategory ?? (section.kind === 'items' && section.category ? section.category : 'login');
      const defaultTags = section.kind === 'items' && section.group ? [section.group] : [];
      setModalState({
        item: null,
        defaultCategory,
        defaultTags,
      });
    },
    [section]
  );

  if (phase === 'loading') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
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
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        selectedVaultId={selectedVaultId}
        onSelectVault={setSelectedVaultId}
        section={section}
        onSelectSection={setSection}
        onOpenImportCsv={() => setImportModalOpen(true)}
      />

      {section.kind === 'items' && (
        <>
          <ItemList
            title={destinationTitle}
            items={filteredItems}
            selectedItemId={activeItem?.id ?? null}
            onSelectItem={setSelectedItemId}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            sortField={sortField}
            sortAscending={sortAscending}
            onChangeSortField={setSortField}
            onChangeSortAscending={setSortAscending}
            onCreateNew={handleOpenCreateModal}
            onOpenImportCsv={() => setImportModalOpen(true)}
          />
          <ItemDetail
            item={activeItem}
            onEdit={(it) => setModalState({ item: it })}
            onSelectGroup={(group) => {
              setSelectedVaultId('all');
              setSection({ kind: 'items', group });
            }}
          />
        </>
      )}

      {section.kind === 'email_otp' && (
        <EmailOtpView
          onOpenImapSettings={() => setSection({ kind: 'settings', focusTab: 'imap' })}
          onOpenFilterSettings={() => setSection({ kind: 'settings', focusTab: 'filter' })}
        />
      )}
      {section.kind === 'developer' && <DeveloperView />}
      {section.kind === 'settings' && <SettingsView initialFocus={section.focusTab} />}

      {modalState !== undefined && (
        <ItemModal
          initialItem={modalState.item}
          defaultVaultId={selectedVaultId}
          defaultCategory={modalState.defaultCategory}
          defaultTags={modalState.defaultTags}
          onClose={() => setModalState(undefined)}
          onSaved={(saved) => setSelectedItemId(saved.id)}
        />
      )}

      {importModalOpen && (
        <ImportCsvModal
          defaultVaultId={selectedVaultId}
          onClose={() => setImportModalOpen(false)}
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
  return <LandingPage onOpenVault={() => window.location.assign('/vault')} />;
};

export const App: React.FC = () => (
  <VaultProvider>
    <RouterView />
  </VaultProvider>
);

export default App;
