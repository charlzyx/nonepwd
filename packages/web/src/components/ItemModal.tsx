import React, { useState } from 'react';
import { Dices, MailPlus, Plus, Trash2, X } from 'lucide-react';
import {
  generatePassphrase,
  generatePassword,
  randomId,
  type CustomField,
  type ItemCategory,
  type VaultItemPayload,
} from '@nonepwd/core';
import { useVault } from '../state/VaultContext';

interface ItemModalProps {
  initialItem: VaultItemPayload | null;
  defaultVaultId: string;
  onClose: () => void;
  onSaved: (item: VaultItemPayload) => void;
}

export const ItemModal: React.FC<ItemModalProps> = ({
  initialItem,
  defaultVaultId,
  onClose,
  onSaved,
}) => {
  const { vaults, account, saveItem, createAlias } = useVault();
  const isNew = !initialItem;

  const [vaultId, setVaultId] = useState(
    initialItem?.vaultId ?? (defaultVaultId !== 'all' ? defaultVaultId : vaults[0]?.id ?? '')
  );
  const [category, setCategory] = useState<ItemCategory>(initialItem?.category ?? 'login');
  const [title, setTitle] = useState(initialItem?.title ?? '');
  const [urlText, setUrlText] = useState(initialItem?.urls.join('\n') ?? '');
  const [username, setUsername] = useState(initialItem?.username ?? '');
  const [password, setPassword] = useState(initialItem?.password ?? '');
  const [totp, setTotp] = useState(initialItem?.totp ?? '');
  const [emailAlias, setEmailAlias] = useState(initialItem?.emailAlias ?? '');
  const [notes, setNotes] = useState(initialItem?.notes ?? '');
  const [customFields, setCustomFields] = useState<CustomField[]>(initialItem?.customFields ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleGenerateAlias = async () => {
    setErr(null);
    try {
      const site = urlText.split('\n')[0]?.trim() || title.trim() || 'site';
      const alias = await createAlias({
        siteDomain: site,
        vaultId,
      });
      setEmailAlias(alias.address);
      if (!username) setUsername(alias.address);
    } catch (error) {
      setErr(error instanceof Error ? error.message : '生成别名失败，请先在设置中配置别名域名');
    }
  };

  const handleAddField = () => {
    setCustomFields((prev) => [
      ...prev,
      { id: randomId(), label: '', value: '', type: 'concealed' },
    ]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !vaultId) return;
    setBusy(true);
    setErr(null);
    try {
      const now = new Date().toISOString();
      const payload: VaultItemPayload = {
        id: initialItem?.id ?? randomId(),
        vaultId,
        category,
        title: title.trim(),
        favorite: initialItem?.favorite ?? false,
        tags: initialItem?.tags ?? [],
        urls: urlText
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        username: username.trim() || undefined,
        password: password || undefined,
        totp: totp.trim() || undefined,
        emailAlias: emailAlias.trim() || undefined,
        notes: notes.trim() || undefined,
        customFields: customFields.filter((f) => f.label.trim()),
        createdAt: initialItem?.createdAt ?? now,
        updatedAt: now,
      };
      const saved = await saveItem(payload, isNew);
      onSaved(saved);
      onClose();
    } catch (error) {
      setErr(error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div className="flex max-h-[90vh] w-full max-w-xl flex-col rounded-2xl border border-slate-800 bg-[#121622] shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4">
          <h3 className="text-base font-semibold text-white">
            {isNew ? '新建加密条目' : `编辑条目：${initialItem?.title}`}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex-1 space-y-4 overflow-y-auto p-6">
          {err && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs text-rose-300">
              {err}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">所属密码库</label>
              <select
                value={vaultId}
                disabled={!isNew}
                onChange={(e) => setVaultId(e.target.value)}
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500 disabled:opacity-60"
              >
                {vaults.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.metadata.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">条目类型</label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as ItemCategory)}
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
              >
                <option value="login">网站登录 (Login)</option>
                <option value="api_credential">API 密钥 (API Credential)</option>
                <option value="secure_note">安全笔记 (Secure Note)</option>
                <option value="ssh_key">SSH 密钥</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">标题</label>
            <input
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例如 GitHub / OpenAI / Postgres"
              className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 text-sm text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-400">用户名 / 邮箱</label>
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="alex@example.com"
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 text-sm text-white outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <div className="mb-1 flex items-center justify-between">
                <label className="text-xs font-medium text-slate-400">域名邮箱别名</label>
                {account?.aliasDomain && (
                  <button
                    type="button"
                    onClick={handleGenerateAlias}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
                  >
                    <MailPlus className="h-3 w-3" /> 一键生成别名
                  </button>
                )}
              </div>
              <input
                type="text"
                value={emailAlias}
                onChange={(e) => setEmailAlias(e.target.value)}
                placeholder={account?.aliasDomain ? `site.xxxxx@${account.aliasDomain}` : '可选'}
                className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 font-mono text-xs text-white outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-400">密码 / 密钥</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPassword(generatePassword({ length: 20 }))}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
                >
                  <Dices className="h-3 w-3" /> 随机强密码
                </button>
                <button
                  type="button"
                  onClick={() => setPassword(generatePassphrase({ words: 4 }))}
                  className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300"
                >
                  易记短语
                </button>
              </div>
            </div>
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="输入或点击右上角生成"
              className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 font-mono text-sm text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">
              2FA TOTP 密钥或 otpauth:// URI
            </label>
            <input
              type="text"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="JBSWY3DPEHPK3PXP 或 otpauth://totp/..."
              className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 font-mono text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">
              网址 URL（每行一个，用于浏览器插件匹配与邮件域名关联）
            </label>
            <textarea
              rows={2}
              value={urlText}
              onChange={(e) => setUrlText(e.target.value)}
              placeholder="https://github.com/login"
              className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>

          {/* Custom Fields */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-slate-400">
                自定义字段（支持 np://Vault/Title/字段名 引用）
              </label>
              <button
                type="button"
                onClick={handleAddField}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
              >
                <Plus className="h-3 w-3" /> 添加字段
              </button>
            </div>
            <div className="space-y-2">
              {customFields.map((cf, idx) => (
                <div key={cf.id} className="flex items-center gap-2">
                  <input
                    type="text"
                    placeholder="字段名 (如 api_key)"
                    value={cf.label}
                    onChange={(e) => {
                      const next = [...customFields];
                      next[idx] = { ...cf, label: e.target.value };
                      setCustomFields(next);
                    }}
                    className="w-1/3 rounded-lg border border-slate-700 bg-[#0b0e14] px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                  <input
                    type="text"
                    placeholder="值"
                    value={cf.value}
                    onChange={(e) => {
                      const next = [...customFields];
                      next[idx] = { ...cf, value: e.target.value };
                      setCustomFields(next);
                    }}
                    className="flex-1 rounded-lg border border-slate-700 bg-[#0b0e14] px-2.5 py-1.5 font-mono text-xs text-white outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setCustomFields((p) => p.filter((x) => x.id !== cf.id))}
                    className="rounded-lg p-1.5 text-slate-500 hover:text-rose-400"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-slate-400">备注</label>
            <textarea
              rows={3}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2 text-xs text-white outline-none focus:border-indigo-500"
            />
          </div>

          <div className="flex justify-end gap-2 border-t border-slate-800 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-xl bg-indigo-600 px-5 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {busy ? '正在加密保存...' : '保存条目'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
