import React, { useState } from 'react';
import { KeyRound, Lock, Moon, Shield, Sun, Trash2 } from 'lucide-react';
import { useTheme } from '../state/theme';
import { useVault } from '../state/VaultContext';

export const UnlockScreen: React.FC<{ onBackHome?: () => void }> = ({ onBackHome }) => {
  const { knownEmail, trustedSecretKey, unlock, forgetTrustedDevice } = useVault();
  const { isDark, toggleTheme } = useTheme();
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
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-md rounded-xl border border-border bg-card p-8">
        <div className="mb-4 flex items-center justify-between">
          {onBackHome ? (
            <button
              type="button"
              onClick={onBackHome}
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              ← 返回 nonepwd 官网
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={toggleTheme}
            aria-label="切换亮暗模式"
            className="inline-flex size-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {isDark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-background text-foreground">
            <Shield className="h-6 w-6" />
          </div>
          <h1 className="text-xl font-semibold tracking-tight text-foreground">解锁 nonepwd</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {knownEmail ? `账户：${knownEmail}` : '零知识端到端加密密码库'}
          </p>
        </div>

        {err && (
          <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-600 dark:text-rose-400">
            {err}
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          {!showSecretInput && trustedSecretKey ? (
            <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3.5 py-2 text-xs text-foreground">
              <span className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                已识别当前信任设备的 Secret Key
              </span>
              <button
                type="button"
                onClick={() => {
                  forgetTrustedDevice();
                  setSecretKey('');
                  setShowSecretInput(true);
                }}
                className="inline-flex items-center gap-1 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
              >
                <Trash2 className="h-3 w-3" /> 清除
              </button>
            </div>
          ) : (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Secret Key (NP3-...)
              </label>
              <input
                type="text"
                required
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="NP3-XXXXXX-XXXXXX-XXXXXX-XXXXXX-XXXXXX"
                className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 font-mono text-xs text-foreground outline-none transition-colors focus:border-ring"
              />
            </div>
          )}

          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">主密码</label>
            <input
              type="password"
              required
              autoFocus
              value={masterPassword}
              onChange={(e) => setMasterPassword(e.target.value)}
              placeholder="输入你的主密码..."
              className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-ring"
            />
          </div>

          {showSecretInput && (
            <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
                className="rounded border-input accent-primary"
              />
              <span>在此浏览器记住 Secret Key（主密码永不存储）</span>
            </label>
          )}

          <button
            type="submit"
            disabled={busy}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:opacity-60"
          >
            <Lock className="h-4 w-4" />
            <span>{busy ? '正在 PBKDF2 派生并解密...' : '解锁密码库'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};
