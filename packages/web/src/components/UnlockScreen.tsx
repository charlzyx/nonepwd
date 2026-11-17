import React, { useState } from 'react';
import { KeyRound, Lock, Shield, Trash2 } from 'lucide-react';
import { useVault } from '../state/VaultContext';

export const UnlockScreen: React.FC<{ onBackHome?: () => void }> = ({ onBackHome }) => {
  const { knownEmail, trustedSecretKey, unlock, forgetTrustedDevice } = useVault();
  const [masterPassword, setMasterPassword] = useState('');
  const [secretKey, setSecretKey] = useState(trustedSecretKey ?? '');
  const [showSecretInput, setShowSecretInput] = useState(!trustedSecretKey);
  const [rememberDevice, setRememberDevice] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      await unlock({
        masterPassword,
        secretKey: secretKey || trustedSecretKey || '',
        rememberDevice,
      });
    } catch (error) {
      setErr(error instanceof Error ? error.message : '解锁失败，请检查主密码或 Secret Key');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.16),_#0b0e14_65%)] p-6">
      <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#121622]/95 p-8 shadow-2xl shadow-black/60">
        {onBackHome && (
          <div className="mb-3">
            <button
              type="button"
              onClick={onBackHome}
              className="text-xs text-slate-400 transition hover:text-indigo-300"
            >
              ← 返回 nonepwd 官网
            </button>
          </div>
        )}
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600/20 text-indigo-400 ring-1 ring-indigo-500/40">
            <Shield className="h-7 w-7" />
          </div>
          <h1 className="text-xl font-semibold text-white">解锁 nonepwd</h1>
          <p className="mt-1 text-xs text-slate-400">
            {knownEmail ? `账户：${knownEmail}` : '零知识端到端加密密码库'}
          </p>
        </div>

        {err && (
          <div className="mb-4 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-300">
            {err}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!showSecretInput && trustedSecretKey ? (
            <div className="flex items-center justify-between rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3.5 py-2 text-xs text-emerald-300">
              <span className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" />
                已识别当前信任设备的 Secret Key
              </span>
              <button
                type="button"
                onClick={() => {
                  forgetTrustedDevice();
                  setSecretKey('');
                  setShowSecretInput(true);
                }}
                className="inline-flex items-center gap-1 text-slate-400 hover:text-rose-300"
              >
                <Trash2 className="h-3 w-3" /> 清除
              </button>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-300">
                Secret Key (NP3-...)
              </label>
              <input
                type="text"
                required
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="NP3-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                className="w-full rounded-xl border border-slate-700/80 bg-[#0c1019] px-3.5 py-2.5 font-mono text-xs text-white outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
              />
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-slate-300">主密码</label>
            <input
              type="password"
              required
              autoFocus
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="输入你的主密码..."
              className="w-full rounded-xl border border-slate-700/80 bg-[#0c1019] px-3.5 py-2.5 text-sm text-white outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/25"
            />
          </div>

          {showSecretInput && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-400">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
                className="rounded border-slate-600 bg-slate-900 text-indigo-500"
              />
              <span>在此浏览器记住 Secret Key（主密码永不存储）</span>
            </label>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-60"
          >
            <Lock className="h-4 w-4" />
            <span>{busy ? '正在 PBKDF2 派生并解密...' : '解锁密码库'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
