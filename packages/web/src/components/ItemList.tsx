import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Code2,
  CreditCard,
  Globe,
  Plus,
  Search,
  Star,
  StickyNote,
  Terminal,
  Upload,
  User,
} from 'lucide-react';
import {
  extractRegistrableDomain,
  generateTotp,
  type ItemCategory,
  type VaultItemPayload,
} from '@nonepwd/core';
import { useVault } from '../state/VaultContext';

export type ItemSortField = 'title' | 'website' | 'createdAt' | 'updatedAt';

interface ItemListProps {
  title: string;
  items: VaultItemPayload[];
  selectedItemId: string | null;
  onSelectItem: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  sortField: ItemSortField;
  sortAscending: boolean;
  onChangeSortField: (field: ItemSortField) => void;
  onChangeSortAscending: (asc: boolean) => void;
  onCreateNew: (category?: ItemCategory) => void;
  onOpenImportCsv?: () => void;
}

const SORT_OPTIONS: Array<{ field: ItemSortField; label: string }> = [
  { field: 'title', label: '标题' },
  { field: 'website', label: '网站' },
  { field: 'createdAt', label: '创建日期' },
  { field: 'updatedAt', label: '编辑日期' },
];

const CREATE_OPTIONS: Array<{
  category: ItemCategory;
  label: string;
  icon: React.ReactNode;
}> = [
  { category: 'login', label: '新建网站登录', icon: <Globe className="h-3.5 w-3.5" /> },
  { category: 'api_credential', label: '新建 API 密钥', icon: <Code2 className="h-3.5 w-3.5" /> },
  { category: 'ssh_key', label: '新建 SSH 密钥', icon: <Terminal className="h-3.5 w-3.5" /> },
  { category: 'card', label: '新建银行卡', icon: <CreditCard className="h-3.5 w-3.5" /> },
  { category: 'identity', label: '新建身份地址', icon: <User className="h-3.5 w-3.5" /> },
  { category: 'secure_note', label: '新建安全笔记', icon: <StickyNote className="h-3.5 w-3.5" /> },
];

function categoryIcon(cat: VaultItemPayload['category']) {
  switch (cat) {
    case 'api_credential':
      return <Code2 className="h-4 w-4 text-muted-foreground" />;
    case 'secure_note':
      return <StickyNote className="h-4 w-4 text-muted-foreground" />;
    case 'ssh_key':
      return <Terminal className="h-4 w-4 text-muted-foreground" />;
    case 'card':
      return <CreditCard className="h-4 w-4 text-muted-foreground" />;
    case 'identity':
      return <User className="h-4 w-4 text-muted-foreground" />;
    default:
      return <Globe className="h-4 w-4 text-muted-foreground" />;
  }
}

function safeDomain(url: string): string {
  try {
    return extractRegistrableDomain(url) || url;
  } catch {
    return url;
  }
}

function itemSubtitle(item: VaultItemPayload): string {
  if (item.category === 'card') {
    const digits = (item.card?.number ?? '').replace(/\s+/g, '');
    const last4 = digits.length >= 4 ? `•••• ${digits.slice(-4)}` : '';
    return [item.card?.brand, last4, item.card?.cardholderName].filter(Boolean).join(' · ') || '银行卡';
  }
  if (item.category === 'identity') {
    const fullName =
      item.identity?.fullName ||
      [item.identity?.firstName, item.identity?.lastName].filter(Boolean).join(' ');
    return (
      [fullName, item.identity?.email || item.identity?.phone].filter(Boolean).join(' · ') ||
      '身份与地址'
    );
  }
  if (item.category === 'ssh_key') {
    return item.urls[0] || item.username || 'SSH 密钥';
  }
  if (item.category === 'api_credential') {
    return item.username || (item.urls[0] ? safeDomain(item.urls[0]) : 'API 密钥');
  }
  if (item.category === 'secure_note') {
    return item.username || item.notes?.split('\n')[0]?.trim() || '安全笔记';
  }
  return (
    item.username ||
    item.emailAlias ||
    (item.urls[0] ? safeDomain(item.urls[0]) : '网站登录')
  );
}

export const ItemList: React.FC<ItemListProps> = ({
  title,
  items,
  selectedItemId,
  onSelectItem,
  searchQuery,
  onSearchChange,
  sortField,
  sortAscending,
  onChangeSortField,
  onChangeSortAscending,
  onCreateNew,
  onOpenImportCsv,
}) => {
  const { securityIssues } = useVault();
  const inputRef = useRef<HTMLInputElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [totpMap, setTotpMap] = useState<Record<string, { code: string; remaining: number }>>({});

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
      } else if (e.key === 'Escape') {
        setSortMenuOpen(false);
        setCreateMenuOpen(false);
      }
    };
    const onMouseDown = (e: MouseEvent) => {
      if (actionsRef.current && !actionsRef.current.contains(e.target as Node)) {
        setSortMenuOpen(false);
        setCreateMenuOpen(false);
      }
    };
    window.addEventListener('keydown', handler);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', handler);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, []);

  const totpItems = useMemo(() => items.filter((it) => Boolean(it.totp?.trim())), [items]);

  useEffect(() => {
    if (totpItems.length === 0) {
      setTotpMap({});
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      const nowMs = Date.now();
      const entries = await Promise.all(
        totpItems.map(async (it) => {
          try {
            const res = await generateTotp(it.totp!, nowMs);
            return [it.id, { code: res.code, remaining: res.remainingSeconds }] as const;
          } catch {
            return null;
          }
        })
      );
      if (cancelled) return;
      const next: Record<string, { code: string; remaining: number }> = {};
      for (const entry of entries) {
        if (entry) next[entry[0]] = entry[1];
      }
      setTotpMap(next);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [totpItems]);

  return (
    <div className="flex h-full w-80 shrink-0 flex-col border-r border-border bg-card/50 text-foreground">
      {/* Header: Destination title + count + Sort & Create dropdowns + Search */}
      <div className="space-y-2.5 border-b border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <h2 className="truncate text-sm font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">
              {items.length}
            </span>
          </div>

          <div ref={actionsRef} className="relative flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setCreateMenuOpen(false);
                setSortMenuOpen((v) => !v);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              title="排序方式"
              aria-label="排序方式"
            >
              <ArrowUpDown className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => {
                setSortMenuOpen(false);
                setCreateMenuOpen((v) => !v);
              }}
              className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground transition-colors hover:bg-primary/85"
              title="新建条目"
              aria-label="新建条目"
            >
              <Plus className="h-4 w-4" />
            </button>

            {sortMenuOpen && (
              <div className="absolute right-0 top-9 z-30 w-44 rounded-lg border border-border bg-card p-1 text-xs text-foreground shadow-lg">
                <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                  排序方式
                </div>
                {SORT_OPTIONS.map((opt) => (
                  <button
                    key={opt.field}
                    type="button"
                    onClick={() => {
                      onChangeSortField(opt.field);
                      setSortMenuOpen(false);
                    }}
                    className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <span>{opt.label}</span>
                    {sortField === opt.field && <Check className="h-3.5 w-3.5 text-foreground" />}
                  </button>
                ))}
                <div className="my-1 border-t border-border" />
                <div className="px-2 py-1 text-[10px] font-medium text-muted-foreground">
                  顺序
                </div>
                <button
                  type="button"
                  onClick={() => {
                    onChangeSortAscending(true);
                    setSortMenuOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-1.5">
                    <ArrowUp className="h-3 w-3 text-muted-foreground" />
                    <span>升序</span>
                  </span>
                  {sortAscending && <Check className="h-3.5 w-3.5 text-foreground" />}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onChangeSortAscending(false);
                    setSortMenuOpen(false);
                  }}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
                >
                  <span className="flex items-center gap-1.5">
                    <ArrowDown className="h-3 w-3 text-muted-foreground" />
                    <span>降序</span>
                  </span>
                  {!sortAscending && <Check className="h-3.5 w-3.5 text-foreground" />}
                </button>
              </div>
            )}

            {createMenuOpen && (
              <div className="absolute right-0 top-9 z-30 w-48 rounded-lg border border-border bg-card p-1 text-xs text-foreground shadow-lg">
                {CREATE_OPTIONS.map((opt) => (
                  <button
                    key={opt.category}
                    type="button"
                    onClick={() => {
                      setCreateMenuOpen(false);
                      onCreateNew(opt.category);
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
                  >
                    <span className="text-muted-foreground">{opt.icon}</span>
                    <span>{opt.label}</span>
                  </button>
                ))}
                {onOpenImportCsv && (
                  <>
                    <div className="my-1 border-t border-border" />
                    <button
                      type="button"
                      onClick={() => {
                        setCreateMenuOpen(false);
                        onOpenImportCsv();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-muted"
                    >
                      <Upload className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>导入密码 / 2FA</span>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="搜索账号、网址、分组... (⌘K)"
            className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-3 text-xs text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center px-4 text-center">
            <p className="text-xs font-medium text-muted-foreground">暂无匹配条目</p>
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => onCreateNew()}
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
                  <span>导入密码 / 2FA</span>
                </button>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-1">
            {items.map((item) => {
              const active = item.id === selectedItemId;
              const subtitle = itemSubtitle(item);
              const liveTotp = totpMap[item.id];
              const warning = securityIssues[item.id];
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
                  <div className="flex shrink-0 items-center gap-1.5">
                    {warning && (
                      <span
                        title={warning}
                        aria-label={warning}
                        className="inline-flex items-center text-rose-500"
                      >
                        <AlertCircle className="h-4 w-4" />
                      </span>
                    )}
                    {liveTotp ? (
                      <span
                        title={`2FA 验证码（剩余 ${liveTotp.remaining}s）`}
                        className={`rounded border px-1.5 py-0.5 font-mono text-[11px] font-medium tabular-nums ${
                          liveTotp.remaining <= 5
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400'
                            : 'border-border bg-background text-foreground'
                        }`}
                      >
                        {liveTotp.code}
                      </span>
                    ) : item.totp ? (
                      <span className="rounded border border-border bg-background px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                        2FA
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};
