import React, { useEffect, useRef } from 'react';
import { Code2, Globe, Key, Plus, Search, Star, StickyNote } from 'lucide-react';
import { extractRegistrableDomain, type VaultItemPayload } from '@nonepwd/core';

interface ItemListProps {
  items: VaultItemPayload[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  onCreateNew: () => void;
}

function categoryIcon(cat: VaultItemPayload['category']) {
  switch (cat) {
    case 'api_credential':
      return <Code2 className="h-4 w-4 text-emerald-400" />;
    case 'secure_note':
      return <StickyNote className="h-4 w-4 text-violet-400" />;
    case 'ssh_key':
      return <Key className="h-4 w-4 text-amber-400" />;
    default:
      return <Globe className="h-4 w-4 text-indigo-400" />;
  }
}

export const ItemList: React.FC<ItemListProps> = ({
  items,
  selectedItemId,
  onSelectItem,
  searchQuery,
  onSearchChange,
  onCreateNew,
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
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-slate-800/80 bg-[#10141f]">
      <div className="flex items-center gap-2 border-b border-slate-800/80 p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索账号、网址、标签... (⌘K)"
            className="w-full rounded-xl border border-slate-800 bg-[#0b0e14] py-2 pl-8 pr-3 text-xs text-slate-100 outline-none transition placeholder:text-slate-500 focus:border-indigo-500"
          />
        </div>
        <button
          type="button"
          onClick={onCreateNew}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-sm shadow-indigo-600/30 transition hover:bg-indigo-500"
          title="新建条目"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center px-4 text-center">
            <p className="text-xs font-medium text-slate-400">暂无匹配条目</p>
            <button
              type="button"
              onClick={onCreateNew}
              className="mt-3 rounded-lg border border-indigo-500/40 bg-indigo-500/10 px-3 py-1.5 text-xs font-medium text-indigo-300 hover:bg-indigo-500/20"
            >
              + 创建第一条凭据
            </button>
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
                  className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition ${
                    active
                      ? 'bg-indigo-600/20 ring-1 ring-indigo-500/40'
                      : 'hover:bg-slate-800/60'
                  }`}
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[#0b0e14] ring-1 ring-slate-800">
                    {categoryIcon(item.category)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm font-medium text-slate-100">
                        {item.title}
                      </span>
                      {item.favorite && (
                        <Star className="h-3 w-3 shrink-0 fill-amber-400 text-amber-400" />
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-400">{subtitle}</div>
                  </div>
                  {item.totp && (
                    <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-300">
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
