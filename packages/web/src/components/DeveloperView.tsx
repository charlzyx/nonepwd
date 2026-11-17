import React, { useState } from 'react';
import { KeyRound, Plus, Terminal, Trash2 } from 'lucide-react';
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
    <div className="flex-1 overflow-y-auto bg-[#0b0e14] p-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-white">开发者工具：np CLI、Service Account 与 Connect API</h2>
          <p className="mt-1 text-xs text-slate-400">
            为 CI/CD、本地开发与 AI Agent 设计的零知识密钥注入与本地 Connect HTTP 解密网关，零订阅费自建，原生支持邮件 OTP 阻塞等待。每个 Token 仅封装所选 Vault 的子密钥，客户端本地解密，服务端全程零明文。
          </p>
        </div>

        {/* Service Account Creator */}
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <form
            onSubmit={handleCreate}
            className="space-y-4 rounded-2xl border border-slate-800 bg-[#121622] p-5"
          >
            <h3 className="flex items-center gap-2 text-sm font-semibold text-white">
              <KeyRound className="h-4 w-4 text-indigo-400" />
              签发 Service Account 隔离令牌
            </h3>
            <div>
              <label className="mb-1 block text-xs text-slate-400">服务账号名称</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 ci-runner / playwright-e2e"
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-slate-400">
                授权访问的密码库（最小权限隔离）
              </label>
              <div className="space-y-1.5">
                {vaults.map((v) => (
                  <label
                    key={v.id}
                    className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-800 bg-[#0d111a] px-3 py-2 text-xs text-slate-200"
                  >
                    <input
                      type="checkbox"
                      checked={selectedVaults.includes(v.id)}
                      onChange={() => toggleVault(v.id)}
                      className="rounded border-slate-600 bg-slate-900 text-indigo-500"
                    />
                    <span>{v.metadata.name}</span>
                  </label>
                ))}
              </div>
            </div>
            <button
              type="submit"
              disabled={busy || selectedVaults.length === 0}
              className="flex w-full items-center justify-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>生成 NONEPWD_TOKEN (npst_v1_...)</span>
            </button>

            {generatedToken && (
              <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3.5">
                <div className="mb-1.5 flex items-center justify-between text-xs font-semibold text-emerald-300">
                  <span>请立即保存此 Token（仅展示一次）：</span>
                  <CopyButton value={`export NONEPWD_TOKEN="${generatedToken}"`} label="复制导出命令" />
                </div>
                <div className="break-all rounded bg-[#0b0e14] p-2 font-mono text-[11px] text-emerald-100 select-all">
                  {generatedToken}
                </div>
              </div>
            )}
          </form>

          <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
            <h3 className="mb-3 text-sm font-semibold text-white">
              已签发 Service Accounts ({serviceAccounts.length})
            </h3>
            <div className="space-y-2">
              {serviceAccounts.map((sa) => (
                <div
                  key={sa.id}
                  className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#0d111a] p-3 text-xs"
                >
                  <div>
                    <div className="font-medium text-white">{sa.name}</div>
                    <div className="mt-0.5 font-mono text-[11px] text-slate-400">
                      {sa.id} · 授权 {sa.vaultIds.length} 个 Vault
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void revokeServiceAccount(sa.id)}
                    className="rounded-lg p-1.5 text-slate-500 hover:bg-slate-800 hover:text-rose-400"
                    title="吊销并断开所有会话"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {serviceAccounts.length === 0 && (
                <p className="text-xs text-slate-500">尚未创建 Service Account。</p>
              )}
            </div>
          </div>
        </div>

        {/* CLI & Connect API Cheat Sheet */}
        <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
          <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-white">
            <Terminal className="h-4 w-4 text-emerald-400" />
            常用 CLI 与本地 Connect HTTP API 示例
          </h3>
          <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-[#0b0e14] p-4 font-mono text-xs leading-relaxed text-slate-200">{`# 1. 读取字段与动态 2FA 验证码
np read "np://DevOps/OpenAI/password"
np otp "GitHub" --vault Personal

# 2. 内存注入环境变量启动（硬盘永不落盘明文 .env）
np run --env-file .env.tpl -- npm run dev

# 3. 阻塞等待新邮件验证码到达（适合 Playwright E2E / AI Agent 自动登录）
np mail otp --domain github.com --wait 30s

# 4. 启动本地解密 REST 网关（Connect HTTP API）
np serve --connect --port 8788 --token my-local-token
curl -H "Authorization: Bearer my-local-token" "http://127.0.0.1:8788/v1/resolve?ref=np://DevOps/OpenAI/password"`}</pre>
        </div>
      </div>
    </div>
  );
};
