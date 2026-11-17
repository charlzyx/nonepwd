import React, { useEffect, useRef } from 'react';
import { Code2, Globe, Key, Plus, Search, Star, StickyNote, Upload } from 'lucide-react';
import { extractRegistrableDomain, type VaultItemPayload } from '@nonepwd/core';

interface ItemListProps {
  items: VaultItemPayload[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onCreateNew: () => void;
  onOpenImportCsv?: () => void;
}

function categoryIcon(cat: VaultItemPayload['category']) {
  switch (cat) {
    case 'api_credential':
      return <Code2 className="h-4 w-4 text-muted-foreground" />;
    case 'secure_note':
      return <StickyNote className="h-4 w-4 text-muted-foreground" />;
    case 'ssh_key':
      return <Key className="h-4 w-4 text-muted-foreground" />;
    default:
      return <Globe className="h-4 w-4 text-muted-foreground" />;
  }
}

export const ItemList: React.FC<ItemListProps> = ({
  items,
  selectedItemId,
  onSelectItem,
  searchQuery,
  onSearchChange,
  onCreateNew,
  onOpenImportCsv,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-border bg-card/50 text-foreground">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索账号、网址、标签... (⌘K)"
            className="w-full rounded-md border border-input bg-background py-2 pl-8 pr-3 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
        {onOpenImportCsv && (
          <button
            type="button"
            onClick={onOpenImportCsv}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground transition-colors hover:bg-muted"
            title="导入 CSV 密码"
          >
            <Upload className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onCreateNew}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
          title="新建条目"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center px-4 text-center">
            <p className="text-xs font-medium text-muted-foreground">暂无匹配条目</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={onCreateNew}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
              >
                + 创建第一条凭据
              </button>
              {onOpenImportCsv && (
                <button
                  type="button"
                  onClick={onOpenImportCsv}
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                >
                  <Upload className="h-3 w-3" />
                  <span>导入 CSV</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => {
              const active = item.id === selectedItemId;
              const subtitle =
                item.username ||
                item.emailAlias ||
                (item.urls[0] ? extractRegistrableDomain(item.urls[0]) : item.category);
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectItem(item.id)}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                    active ? 'bg-muted text-foreground' : 'hover:bg-muted/60'
                  }`}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border bg-background">
                    {categoryIcon(item.category)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-foreground">
                        {item.title}
                      </span>
                      {item.favorite && (
                        <Star className="h-3 w-3 shrink-0 fill-amber-500 text-amber-500" />
                      )}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{subtitle}</div>
                  </div>
                  {item.totp && (
                    <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                      2FA
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
