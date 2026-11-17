import React, { useState } from 'react';
import { KeyRound, Plus, Trash2 } from 'lucide-react';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

export const DeveloperView: React.FC = () => {
  const { vaults, serviceAccounts, createServiceAccount, revokeServiceAccount } = useVault();
  const [name, setName] = useState('github-actions');
  const [selectedVaults, setSelectedVaults] = useState<string[]>(() =>
    vaults.length > 0 ? [vaults[vaults.length - 1].id] : []
  );
  const [generatedToken, setGeneratedToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const toggleVault = (id: string) => {
    setSelectedVaults((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || selectedVaults.length === 0) return;
    setBusy(true);
    try {
      const res = await createServiceAccount(name.trim(), selectedVaults);
      setGeneratedToken(res.token);
      setName('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto bg-background p-6 text-foreground">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">Service Account</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            签发仅授权指定密码库的访问令牌，供 CLI 与自动化脚本使用。
          </p>
        </div>

        {/* Service Account Creator */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <form
            onSubmit={handleCreate}
            className="space-y-4 rounded-xl border border-border bg-card p-5"
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <KeyRound className="h-4 w-4 text-muted-foreground" />
              签发 Service Account 隔离令牌
            </h3>
            <div>
              <label className="mb-1 block text-xs text-muted-foreground">服务账号名称</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 ci-runner / playwright-e2e"
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-xs text-foreground outline-none focus:border-ring"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">
                授权访问的密码库（最小权限隔离）
              </label>
              <div className="space-y-1.5">
                {vaults.map((v) => (
                  <label
                    key={v.id}
                    className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-3 py-2 text-xs text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={selectedVaults.includes(v.id)}
                      onChange={() => toggleVault(v.id)}
                      className="rounded border-input accent-primary"
                    />
                    <span>{v.metadata.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={busy || selectedVaults.length === 0}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>生成 NONEPWD_TOKEN (npst_v1_...)</span>
            </button>

            {generatedToken && (
              <div className="rounded-lg border border-border bg-muted/40 p-3.5">
                <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-foreground">
                  <span>请立即保存此 Token（仅展示一次）：</span>
                  <CopyButton
                    value={`export NONEPWD_TOKEN="${generatedToken}"`}
                    label="复制导出命令"
                  />
                </div>
                <div className="break-all rounded border border-border bg-background p-2 font-mono text-[11px] text-foreground select-all">
                  {generatedToken}
                </div>
              </div>
            )}
          </form>

          <div className="rounded-xl border border-border bg-card p-5">
            <h3 className="mb-3 text-sm font-semibold text-foreground">
              已签发 Service Accounts ({serviceAccounts.length})
            </h3>
            <div className="space-y-2">
              {serviceAccounts.map((sa) => (
                <div
                  key={sa.id}
                  className="flex items-center justify-between rounded-lg border border-border bg-background p-3 text-xs"
                >
                  <div>
                    <div className="font-medium text-foreground">{sa.name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {sa.id} · 授权 {sa.vaultIds.length} 个 Vault
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void revokeServiceAccount(sa.id)}
                    className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-rose-600 dark:hover:text-rose-400"
                    title="吊销并断开所有会话"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {serviceAccounts.length === 0 && (
                <p className="text-xs text-muted-foreground">尚未创建 Service Account。</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
