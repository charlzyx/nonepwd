import React, { useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Download,
  KeyRound,
  Moon,
  Sun,
} from 'lucide-react';
import { useTheme } from '../state/theme';
import { useVault } from '../state/VaultContext';
import { BrandMark } from './BrandMark';
import { CopyButton } from './CopyButton';

function calcStrength(pw: string): { score: number; label: string; color: string } {
  let score = 0;
  if (pw.length >= 10) score++;
  if (pw.length >= 16) score++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { score: 25, label: '较弱', color: 'bg-rose-500' };
  if (score === 2) return { score: 55, label: '中等', color: 'bg-amber-500' };
  if (score === 3) return { score: 80, label: '较强', color: 'bg-emerald-500' };
  return { score: 100, label: '极强', color: 'bg-primary' };
}

export const SetupWizard: React.FC<{ onBackHome?: () => void }> = ({ onBackHome }) => {
  const { setupAccount, generateNewSecretKey } = useVault();
  const { isDark, toggleTheme } = useTheme();
  const [step, setStep] = useState<1 | 2>(1);
  const [email, setEmail] = useState('');
  const [masterPassword, setMasterPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [aliasDomain, setAliasDomain] = useState('');
  const [rememberDevice, setRememberDevice] = useState(true);
  const [secretKey] = useState(() => generateNewSecretKey());
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const strength = useMemo(() => calcStrength(masterPassword), [masterPassword]);

  const handleNext = (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!email.includes('@')) {
      setErr('请输入有效的邮箱地址');
      return;
    }
    if (masterPassword.length < 8) {
      setErr('主密码至少需要 8 位字符');
      return;
    }
    if (masterPassword !== confirmPassword) {
      setErr('两次输入的主密码不一致');
      return;
    }
    setStep(2);
  };

  const downloadEmergencyKit = () => {
    const kit = {
      product: 'nonepwd Self-Hosted Vault',
      createdAt: new Date().toISOString(),
      serverOrigin: window.location.origin,
      email: email.trim().toLowerCase(),
      secretKey,
      warning:
        'Keep this Emergency Kit safe. Server cannot recover your Master Password or Secret Key.',
    };
    const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `nonepwd-emergency-kit-${email.split('@')[0] || 'vault'}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setSavedConfirmed(true);
  };

  const handleCreate = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setupAccount({
        email,
        masterPassword,
        secretKey,
        aliasDomain,
        rememberDevice,
      });
    } catch (error) {
      setErr(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-6 text-foreground">
      <div className="w-full max-w-lg rounded-xl border border-border bg-card p-8">
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

        <div className="mb-6 flex items-center gap-3">
          <BrandMark className="size-11" />
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">
              初始化密码库
            </h1>
            <p className="text-xs text-muted-foreground">
              创建管理员账号与本地加密密钥
            </p>
          </div>
        </div>

        <div className="mb-6 flex items-center gap-2 text-xs font-medium">
          <span
            className={`rounded-full px-3 py-1 ${
              step === 1
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-background text-muted-foreground'
            }`}
          >
            1. 账户与主密码
          </span>
          <div className="h-px flex-1 bg-border" />
          <span
            className={`rounded-full px-3 py-1 ${
              step === 2
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-background text-muted-foreground'
            }`}
          >
            2. 保存 Secret Key 救援密钥
          </span>
        </div>

        {err && (
          <div className="mb-4 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-2.5 text-xs text-rose-600 dark:text-rose-400">
            {err}
          </div>
        )}

        {step === 1 ? (
          <form onSubmit={handleNext} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                管理员邮箱
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-ring"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                主密码（仅用于本地派生解密密钥，绝不上传服务端）
              </label>
              <input
                type="password"
                required
                value={masterPassword}
                onChange={(e) => setMasterPassword(e.target.value)}
                placeholder="建议 12 位以上高强度密码"
                className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-ring"
              />
              {masterPassword && (
                <div className="mt-2 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full transition-all ${strength.color}`}
                      style={{ width: `${strength.score}%` }}
                    />
                  </div>
                  <span className="text-[11px] text-muted-foreground">{strength.label}</span>
                </div>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                确认主密码
              </label>
              <input
                type="password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="再次输入主密码"
                className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-ring"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                域名邮箱别名后缀（可选，用于 Cloudflare Email Worker）
              </label>
              <input
                type="text"
                value={aliasDomain}
                onChange={(e) => setAliasDomain(e.target.value)}
                placeholder="例如 mail.yourdomain.com（可稍后在设置中配置）"
                className="w-full rounded-lg border border-input bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition-colors focus:border-ring"
              />
            </div>

            <button
              type="submit"
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              <span>下一步：生成双密钥救援包</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                  128-bit+ Secret Key（新设备登录必需）
                </span>
                <CopyButton value={secretKey} label="复制密钥" />
              </div>
              <div className="rounded-md border border-border bg-background p-3 font-mono text-sm tracking-wide text-foreground select-all">
                {secretKey}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                服务端数据库只存密文。即使服务器磁盘失窃，没有此 Secret Key 也无法暴力破解你的主密码。
              </p>
            </div>

            <button
              type="button"
              onClick={downloadEmergencyKit}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              <Download className="h-4 w-4 text-muted-foreground" />
              <span>下载紧急救援包（Emergency Kit .json）</span>
            </button>

            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3.5 py-2.5 text-xs text-foreground">
              <input
                type="checkbox"
                checked={rememberDevice}
                onChange={(e) => setRememberDevice(e.target.checked)}
                className="rounded border-input accent-primary"
              />
              <span>记住当前信任设备的 Secret Key（下次解锁只需输入主密码）</span>
            </label>

            <label className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-border bg-background px-3.5 py-2.5 text-xs text-foreground">
              <input
                type="checkbox"
                checked={savedConfirmed}
                onChange={(e) => setSavedConfirmed(e.target.checked)}
                className="rounded border-input accent-primary"
              />
              <span>我已安全备份 Secret Key 和主密码</span>
            </label>

            <div className="flex gap-3 pt-1">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded-lg border border-border bg-background px-4 py-2.5 text-sm text-foreground hover:bg-muted"
              >
                返回
              </button>
              <button
                type="button"
                disabled={!savedConfirmed || busy}
                onClick={handleCreate}
                className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <CheckCircle2 className="h-4 w-4" />
                <span>{busy ? '正在派生密钥并初始化...' : '完成初始化并进入密码库'}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
