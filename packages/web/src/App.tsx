import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { type VaultItemPayload } from '@nonepwd/core';
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
