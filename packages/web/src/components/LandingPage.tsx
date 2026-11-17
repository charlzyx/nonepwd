import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  Cloud,
  Cpu,
  Download,
  ExternalLink,
  Globe,
  KeyRound,
  Lock,
  MailCheck,
  RefreshCw,
  Shield,
  ShieldCheck,
  Sparkles,
  Terminal,
  Zap,
} from 'lucide-react';
import {
  AAD,
  encryptJson,
  extractEmailOtp,
  generateEmailAlias,
  generateEmailKeyPair,
  generatePassphrase,
  generatePassword,
  generateRawAesKey,
  generateTotp,
  sealJsonForPublicKey,
  type SealedEnvelope,
} from '@nonepwd/core';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

interface LandingPageProps {
  onOpenVault: () => void;
}

type LabTab = 'otp' | 'crypto' | 'totp';
type CliTab = 'run' | 'mail' | 'sa' | 'connect';

const OTP_PRESETS = [
  {
    id: 'github',
    label: 'GitHub HTML 邮件',
    from: 'GitHub <noreply@github.com>',
    subject: '[GitHub] Please verify your device',
    body: `<div style="color:#445566">Your GitHub verification code is:</div>\n<div style="font-size:28px;color:#112233">839204</div>\n<p>Or verify directly: https://github.com/login/verify?token=gh_91a2</p>\n<footer>© 2026 GitHub Inc. Order #998877</footer>`,
  },
  {
    id: 'steam',
    label: 'Steam 中文验证码',
    from: 'Steam <noreply@steampowered.com>',
    subject: '您的 Steam 令牌安全验证码',
    body: '您好，您本次登录的安全验证码为：649-102，5分钟内有效。客服电话 4001234567。',
  },
  {
    id: 'cursor',
    label: 'Cursor Magic Link',
    from: 'Cursor <no-reply@cursor.com>',
    subject: 'Sign in to Cursor',
    body: 'Your one-time verification code is 519382.\nMagic link: https://cursor.com/auth/magic?token=cur_demo_881',
  },
  {
    id: 'promo',
    label: '促销邮件防误判',
    from: 'Store <promo@store.example.com>',
    subject: 'Spring Sale 2026 - Save $1500 today!',
    body: 'Order #441239 total price $1500 USD. Copyright 2026 Store Inc.',
  },
];

const CLI_EXAMPLES: Record<CliTab, { title: string; cmd: string }> = {
  run: {
    title: '环境变量零落盘注入（告别明文 .env）',
    cmd: `# .env.tpl 仅保存引用路径，绝不存放明文密钥
OPENAI_API_KEY=np://DevOps/OpenAI/api_key
DB_PASSWORD=np://DevOps/Postgres/password

# 内存解密注入子进程，硬盘永不落盘
np run --env-file .env.tpl -- npm run dev`,
  },
  mail: {
    title: '自动化等待邮箱验证码（Playwright / AI Agent 闭环）',
    cmd: `# 通过纯 Rust TLS + WebSocket 实时等待新验证码并本地 X25519 解密
OTP=$(np mail otp --domain github.com --wait 30s)
echo "收到实时登录验证码: $OTP"`,
  },
  sa: {
    title: 'Service Account 最小权限分库隔离',
    cmd: `# 仅授权 DevOps 密码库（个人库密码无法解密）
np service-account create ci-runner --vault DevOps
export NONEPWD_TOKEN="npst_v1_..."

np read "np://DevOps/OpenAI/api_key"`,
  },
  connect: {
    title: '本地 Connect HTTP 解密网关',
    cmd: `np serve --connect --port 8788 --token my-connect-secret

curl -H "Authorization: Bearer my-connect-secret" \\
  "http://127.0.0.1:8788/v1/resolve?ref=np://DevOps/OpenAI/api_key"`,
  },
};

export const LandingPage: React.FC<LandingPageProps> = ({ onOpenVault }) => {
  const { phase, knownEmail } = useVault();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8787';

  // Live Lab State
  const [labTab, setLabTab] = useState<LabTab>('otp');

  // Tab 1: Email OTP Live Extractor
  const [otpFrom, setOtpFrom] = useState(OTP_PRESETS[0].from);
  const [otpSubject, setOtpSubject] = useState(OTP_PRESETS[0].subject);
  const [otpBody, setOtpBody] = useState(OTP_PRESETS[0].body);

  const otpResult = useMemo(
    () =>
      extractEmailOtp({
        from: otpFrom,
        to: 'github.k9x2m@mail.nonepwd.dev',
        subject: otpSubject,
        text: otpBody.includes('<') ? undefined : otpBody,
        html: otpBody.includes('<') ? otpBody : undefined,
      }),
    [otpFrom, otpSubject, otpBody]
  );

  // Tab 2: Dual-Key + X25519 Sealed Envelope Demo
  const [secretInput, setSecretInput] = useState('sk-proj-live-demo-994812a');
  const [cryptoSeed, setCryptoSeed] = useState(0);
  const [cryptoPreview, setCryptoPreview] = useState<{
    vaultBlob: string;
    emailPubKey: string;
    sealedEnvelope: SealedEnvelope;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function computeCrypto() {
      const vaultKey = generateRawAesKey();
      const vaultBlob = await encryptJson(
        vaultKey,
        { title: 'OpenAI Prod', secret: secretInput, updatedAt: new Date().toISOString() },
        AAD.vaultItem('vault-devops', 'item-openai')
      );
      const emailKp = await generateEmailKeyPair();
      const sealedEnvelope = await sealJsonForPublicKey(emailKp.publicKeyB64, {
        from: 'noreply@github.com',
        otpCode: '839204',
        note: secretInput,
      });
      if (!cancelled) {
        setCryptoPreview({
          vaultBlob,
          emailPubKey: emailKp.publicKeyB64,
          sealedEnvelope,
        });
      }
    }
    void computeCrypto();
    return () => {
      cancelled = true;
    };
  }, [secretInput, cryptoSeed]);

  // Tab 3: Live TOTP & Alias Studio
  const [totpSecret, setTotpSecret] = useState('JBSWY3DPEHPK3PXP');
  const [totpLive, setTotpLive] = useState<{
    code: string;
    remainingSeconds: number;
    period: number;
  } | null>(null);
  const [aliasSite, setAliasSite] = useState('https://cursor.com');
  const [aliasDomainInput, setAliasDomainInput] = useState('mail.yourdomain.com');
  const [samplePassword, setSamplePassword] = useState(() => generatePassword({ length: 20 }));
  const [samplePhrase, setSamplePhrase] = useState(() => generatePassphrase({ words: 4 }));
  const [sampleAlias, setSampleAlias] = useState(() =>
    generateEmailAlias('https://cursor.com', 'mail.yourdomain.com')
  );

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await generateTotp(totpSecret);
        if (!cancelled) setTotpLive(res);
      } catch {
        if (!cancelled) setTotpLive(null);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [totpSecret]);

  // CLI Tabs
  const [cliTab, setCliTab] = useState<CliTab>('run');

  const primaryCtaLabel =
    phase === 'standalone'
      ? '私有部署与快速上手'
      : phase === 'uninitialized'
      ? '立即初始化密码库'
      : phase === 'unlocked'
      ? '进入已解锁密码库'
      : '解锁 Web 密码库';

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-100">
      {/* Top Sticky Navbar */}
      <header className="sticky top-0 z-40 border-b border-slate-800/80 bg-[#0b0e14]/85 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white shadow-lg shadow-indigo-600/30">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-base font-bold tracking-tight text-white">nonepwd</span>
              <span className="hidden rounded-full border border-indigo-500/35 bg-indigo-500/10 px-2 py-0.5 text-[10px] font-semibold text-indigo-300 sm:inline-block">
                Self-Hosted · Rust + WASM
              </span>
            </div>
          </div>

          <nav className="hidden items-center gap-6 text-xs font-medium text-slate-400 md:flex">
            <a href="#live-lab" className="transition hover:text-white">
              实时 WASM 实验室
            </a>
            <a href="#extension" className="transition hover:text-white">
              浏览器插件
            </a>
            <a href="#pipeline" className="transition hover:text-white">
              OTP 全链路
            </a>
            <a href="#comparison" className="transition hover:text-white">
              架构对比
            </a>
            <a href="#cli" className="transition hover:text-white">
              原生 CLI 下载
            </a>
            <a href="#deploy" className="transition hover:text-white">
              Docker 自建
            </a>
          </nav>

          <div className="flex items-center gap-2.5">
            <a
              href="/demo-login"
              className="hidden rounded-xl border border-slate-800 bg-[#121622] px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-indigo-500/40 hover:text-white sm:inline-flex"
            >
              6 宫格沙盒
            </a>
            <button
              type="button"
              onClick={onOpenVault}
              className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white shadow-md shadow-indigo-600/25 transition hover:bg-indigo-500"
            >
              <span>{primaryCtaLabel}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden border-b border-slate-800/80 bg-[radial-gradient(ellipse_at_top,_rgba(99,102,241,0.2),_#0b0e14_65%)]">
        <div className="mx-auto max-w-6xl px-6 pb-16 pt-16 sm:pt-24">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-indigo-500/35 bg-indigo-500/10 px-3.5 py-1 text-xs font-medium text-indigo-200">
              <span
                className={`h-2 w-2 rounded-full ${
                  phase === 'unlocked' || phase === 'standalone'
                    ? 'bg-emerald-400'
                    : phase === 'locked'
                    ? 'bg-amber-400'
                    : 'bg-indigo-400'
                }`}
              />
              <span>
                {phase === 'standalone'
                  ? '零知识自建密码库官网 · 浏览器端 Rust WASM 实时运行中'
                  : phase === 'uninitialized'
                  ? '单人私有化自建实例已就绪 · 等待初始化'
                  : phase === 'unlocked'
                  ? `密码库已解锁 (${knownEmail ?? 'owner'})`
                  : `实例已初始化 (${knownEmail ?? 'locked'}) · 双密钥零知识保护`}
              </span>
            </div>

            <h1 className="text-4xl font-bold tracking-tight text-white sm:text-5xl sm:leading-[1.15]">
              nonepwd：密码归自己，
              <span className="bg-gradient-to-r from-indigo-300 via-sky-300 to-emerald-300 bg-clip-text text-transparent">
                告别云端托管与年费订阅。
              </span>
            </h1>

            <p className="mt-5 text-base leading-relaxed text-slate-300 sm:text-lg">
              单人私有化自建零知识 Vault：双密钥（<code className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-sm text-indigo-200">NP3-...</code>）+ 实时邮箱验证码自动提取（IMAP IDLE &amp; Cloudflare Worker）+ 2FA TOTP
              + 浏览器 MV3 自动填充插件 + 原生跨平台 Rust <code className="rounded bg-slate-800/80 px-1.5 py-0.5 font-mono text-sm text-indigo-200">np</code> CLI。
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={onOpenVault}
                className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-6 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/30 transition hover:bg-indigo-500"
              >
                <ShieldCheck className="h-4.5 w-4.5" />
                <span>{primaryCtaLabel}</span>
                <ArrowRight className="h-4 w-4" />
              </button>

              <a
                href="/demo-login"
                className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#121622] px-5 py-3 text-sm font-medium text-slate-200 transition hover:border-indigo-500/50 hover:text-white"
              >
                <KeyRound className="h-4 w-4 text-indigo-400" />
                <span>体验多步登录与 6 宫格沙盒</span>
              </a>
            </div>

            {/* Quick Install Pill */}
            <div className="mx-auto mt-8 flex max-w-xl items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-[#10141f]/90 px-4 py-2.5 text-left shadow-xl">
              <div className="flex min-w-0 items-center gap-2.5">
                <Terminal className="h-4 w-4 shrink-0 text-emerald-400" />
                <code className="truncate font-mono text-xs text-slate-200">
                  curl -fsSL {origin}/install.sh | bash
                </code>
              </div>
              <CopyButton value={`curl -fsSL ${origin}/install.sh | bash`} label="复制安装命令" />
            </div>
          </div>

          {/* 4 Core Pillars */}
          <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-2xl border border-slate-800/90 bg-[#121622]/80 p-5">
              <Lock className="mb-3 h-5 w-5 text-indigo-400" />
              <h3 className="text-sm font-semibold text-white">双密钥零知识加密</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                Master Password + Secret Key (<code className="text-slate-300">NP3-...</code>) 本地 PBKDF2 60万次派生，Per-Vault 密钥 + AAD 绑定。
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800/90 bg-[#121622]/80 p-5">
              <MailCheck className="mb-3 h-5 w-5 text-emerald-400" />
              <h3 className="text-sm font-semibold text-white">邮箱验证码 + 域名别名</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                IMAP IDLE 长连接 + Cloudflare Worker 无限随机别名，X25519 公钥密封后通过 WebSocket 秒级推送。
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800/90 bg-[#121622]/80 p-5">
              <Zap className="mb-3 h-5 w-5 text-amber-400" />
              <h3 className="text-sm font-semibold text-white">Shadow DOM 六宫格接力</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                MV3 扩展识别分步登录流，第 1 步填充账密后，第 2 步自动弹出 TOTP 与实时邮箱码填入 6 格输入框。
              </p>
            </div>
            <div className="rounded-2xl border border-slate-800/90 bg-[#121622]/80 p-5">
              <Cpu className="mb-3 h-5 w-5 text-sky-400" />
              <h3 className="text-sm font-semibold text-white">纯 Rust 五端同源核心</h3>
              <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                <code className="text-slate-300">nonepwd-core</code> 编译为 WASM 驱动全栈，同时产出 macOS 与 Linux 静态单二进制 <code className="text-slate-300">np</code>。
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Interactive Rust WASM Live Lab */}
      <section id="live-lab" className="border-b border-slate-800/80 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-8 flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <div className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
                <Sparkles className="h-3.5 w-3.5" />
                <span>真实运行于你当前浏览器的 nonepwd_core.wasm</span>
              </div>
              <h2 className="text-2xl font-bold text-white sm:text-3xl">Rust WASM 实时交互实验室</h2>
              <p className="mt-1.5 text-sm text-slate-400">
                无需注册即可现场测试邮箱验证码提取、零知识密文结构与 RFC 6238 动态 2FA 生成。
              </p>
            </div>

            <div className="inline-flex rounded-xl border border-slate-800 bg-[#121622] p-1">
              <button
                type="button"
                onClick={() => setLabTab('otp')}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                  labTab === 'otp' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                邮箱验证码提取
              </button>
              <button
                type="button"
                onClick={() => setLabTab('crypto')}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                  labTab === 'crypto' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                零知识密文透视
              </button>
              <button
                type="button"
                onClick={() => setLabTab('totp')}
                className={`rounded-lg px-3.5 py-1.5 text-xs font-medium transition ${
                  labTab === 'totp' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                2FA 与别名生成
              </button>
            </div>
          </div>

          {labTab === 'otp' && (
            <div className="grid grid-cols-1 gap-6 rounded-2xl border border-slate-800 bg-[#121622] p-6 lg:grid-cols-12">
              <div className="space-y-3 lg:col-span-7">
                <div className="flex flex-wrap gap-2">
                  {OTP_PRESETS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setOtpFrom(p.from);
                        setOtpSubject(p.subject);
                        setOtpBody(p.body);
                      }}
                      className="rounded-lg border border-slate-700/80 bg-[#0b0e14] px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:border-indigo-500/60 hover:text-white"
                    >
                      {p.label}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-400">
                      发件人 From
                    </label>
                    <input
                      type="text"
                      value={otpFrom}
                      onChange={(e) => setOtpFrom(e.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] font-medium text-slate-400">
                      邮件主题 Subject
                    </label>
                    <input
                      type="text"
                      value={otpSubject}
                      onChange={(e) => setOtpSubject(e.target.value)}
                      className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3 py-2 text-xs text-white outline-none focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block text-[11px] font-medium text-slate-400">
                    邮件正文（支持纯文本或完整 HTML，实时调用 Rust <code className="text-indigo-300">extract_email_otp</code>）
                  </label>
                  <textarea
                    rows={5}
                    value={otpBody}
                    onChange={(e) => setOtpBody(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2.5 font-mono text-xs leading-relaxed text-slate-200 outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div className="flex flex-col justify-between rounded-2xl border border-slate-800 bg-[#0b0e14] p-5 lg:col-span-5">
                <div>
                  <div className="mb-4 flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-300">WASM 实时提取结果</span>
                    <span className="rounded-full bg-indigo-500/15 px-2.5 py-0.5 font-mono text-[11px] text-indigo-300">
                      {otpResult.senderDomain || 'unknown'}
                    </span>
                  </div>

                  {otpResult.otpCode ? (
                    <div className="rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-4">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-emerald-300">
                          提取验证码 · 置信度 {Math.round(otpResult.confidence * 100)}%
                        </span>
                        <CopyButton value={otpResult.otpCode} label="复制" />
                      </div>
                      <div
                        data-testid="lab-otp-code"
                        className="mt-2 font-mono text-3xl font-bold tracking-[0.2em] text-white"
                      >
                        {otpResult.otpCode}
                      </div>
                    </div>
                  ) : (
                    <div
                      data-testid="lab-otp-empty"
                      className="rounded-xl border border-slate-700 bg-slate-900/70 p-4 text-xs text-slate-300"
                    >
                      未检测到高置信度验证码（已自动过滤年份、金额、订单号与 CSS 十六进制色值）。
                    </div>
                  )}

                  {otpResult.magicLink && (
                    <div className="mt-3 rounded-xl border border-slate-800 bg-[#121622] p-3">
                      <div className="text-[11px] text-slate-400">识别到登录确认链接 (Magic Link)</div>
                      <div className="mt-1 flex items-center gap-1.5 truncate font-mono text-xs text-indigo-300">
                        <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                        <span className="truncate">{otpResult.magicLink}</span>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mt-4 border-t border-slate-800 pt-3">
                  <div className="text-[11px] font-medium text-slate-500">HTML 清洗后摘要</div>
                  <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-400">
                    {otpResult.snippet || '(空)'}
                  </p>
                </div>
              </div>
            </div>
          )}

          {labTab === 'crypto' && (
            <div className="grid grid-cols-1 gap-6 rounded-2xl border border-slate-800 bg-[#121622] p-6 lg:grid-cols-2">
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    输入任意测试明文（仅在本地 WASM 内存加密）
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={secretInput}
                      onChange={(e) => setSecretInput(e.target.value)}
                      className="flex-1 rounded-xl border border-slate-700 bg-[#0b0e14] px-3.5 py-2.5 font-mono text-xs text-white outline-none focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => setCryptoSeed((n) => n + 1)}
                      className="inline-flex items-center gap-1.5 rounded-xl bg-indigo-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新密封
                    </button>
                  </div>
                </div>

                <div className="rounded-xl border border-slate-800 bg-[#0b0e14] p-4 text-xs leading-relaxed text-slate-400">
                  <div className="mb-1.5 font-semibold text-slate-200">零知识落库原则</div>
                  <ul className="list-disc space-y-1 pl-4">
                    <li>
                      Vault 条目使用随机 256-bit <code className="text-indigo-300">VaultKey</code> +{' '}
                      <code className="text-indigo-300">AES-256-GCM</code> 加密，并绑定{' '}
                      <code className="text-indigo-300">AAD(vaultId, itemId)</code> 防止跨库密文调包。
                    </li>
                    <li>
                      收到的验证码邮件由服务端或 Cloudflare 边缘 Worker 用你的{' '}
                      <code className="text-emerald-300">X25519</code> 公钥当场密封，服务端无法查看历史邮件。
                    </li>
                  </ul>
                </div>
              </div>

              <div className="space-y-3">
                <div className="rounded-xl border border-slate-800 bg-[#0b0e14] p-4">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-indigo-300">
                    <span>SQLite 存储形态：items.encrypted_data (AES-256-GCM + AAD)</span>
                    {cryptoPreview && <CopyButton value={cryptoPreview.vaultBlob} />}
                  </div>
                  <code
                    data-testid="lab-vault-blob"
                    className="block break-all font-mono text-[11px] text-slate-300"
                  >
                    {cryptoPreview?.vaultBlob ?? '计算中...'}
                  </code>
                </div>

                <div className="rounded-xl border border-slate-800 bg-[#0b0e14] p-4">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] font-semibold text-emerald-300">
                    <span>邮件密封盒：encrypted_emails.sealed_envelope (X25519 + HKDF)</span>
                  </div>
                  <pre className="overflow-x-auto font-mono text-[11px] text-slate-300">
                    {cryptoPreview
                      ? JSON.stringify(cryptoPreview.sealedEnvelope, null, 2)
                      : '计算中...'}
                  </pre>
                </div>
              </div>
            </div>
          )}

          {labTab === 'totp' && (
            <div className="grid grid-cols-1 gap-6 rounded-2xl border border-slate-800 bg-[#121622] p-6 lg:grid-cols-2">
              {/* Live TOTP */}
              <div className="flex flex-col justify-between rounded-xl border border-slate-800 bg-[#0b0e14] p-5">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-slate-300">
                    Base32 2FA 密钥或 otpauth:// URI
                  </label>
                  <input
                    type="text"
                    value={totpSecret}
                    onChange={(e) => setTotpSecret(e.target.value)}
                    className="w-full rounded-xl border border-slate-700 bg-[#121622] px-3 py-2 font-mono text-xs text-white outline-none focus:border-indigo-500"
                  />
                </div>

                <div className="mt-6 flex items-center justify-between rounded-2xl border border-indigo-500/30 bg-indigo-500/10 p-5">
                  <div className="flex items-center gap-4">
                    <svg className="h-12 w-12 -rotate-90" viewBox="0 0 36 36">
                      <circle
                        cx="18"
                        cy="18"
                        r="15"
                        fill="none"
                        stroke="rgba(148,163,184,0.2)"
                        strokeWidth="3"
                      />
                      <circle
                        cx="18"
                        cy="18"
                        r="15"
                        fill="none"
                        stroke={(totpLive?.remainingSeconds ?? 30) <= 5 ? '#f43f5e' : '#6366f1'}
                        strokeWidth="3"
                        strokeDasharray="94.25"
                        strokeDashoffset={
                          totpLive
                            ? 94.25 * (1 - totpLive.remainingSeconds / Math.max(1, totpLive.period))
                            : 0
                        }
                        strokeLinecap="round"
                      />
                    </svg>
                    <div>
                      <div className="text-xs text-indigo-200">
                        RFC 6238 动态码 · 剩余 {totpLive?.remainingSeconds ?? '-'}s
                      </div>
                      <div
                        data-testid="lab-totp-code"
                        className="mt-1 font-mono text-3xl font-bold tracking-widest text-white"
                      >
                        {totpLive
                          ? `${totpLive.code.slice(0, 3)} ${totpLive.code.slice(3)}`
                          : '无效密钥'}
                      </div>
                    </div>
                  </div>
                  {totpLive && <CopyButton value={totpLive.code} label="复制" />}
                </div>
              </div>

              {/* Password / Passphrase / Alias Generator */}
              <div className="space-y-3 rounded-xl border border-slate-800 bg-[#0b0e14] p-5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-white">强密码 & 站点别名生成器</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSamplePassword(generatePassword({ length: 20 }));
                      setSamplePhrase(generatePassphrase({ words: 4 }));
                      try {
                        setSampleAlias(generateEmailAlias(aliasSite, aliasDomainInput));
                      } catch {
                        // ignore invalid domain while typing
                      }
                    }}
                    className="inline-flex items-center gap-1 rounded-lg bg-indigo-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-indigo-500"
                  >
                    <RefreshCw className="h-3 w-3" /> 换一批
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={aliasSite}
                    onChange={(e) => {
                      setAliasSite(e.target.value);
                      try {
                        setSampleAlias(generateEmailAlias(e.target.value, aliasDomainInput));
                      } catch {
                        // ignore
                      }
                    }}
                    placeholder="目标网站"
                    className="rounded-lg border border-slate-700 bg-[#121622] px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                  <input
                    type="text"
                    value={aliasDomainInput}
                    onChange={(e) => {
                      setAliasDomainInput(e.target.value);
                      try {
                        setSampleAlias(generateEmailAlias(aliasSite, e.target.value));
                      } catch {
                        // ignore
                      }
                    }}
                    placeholder="你的域名"
                    className="rounded-lg border border-slate-700 bg-[#121622] px-2.5 py-1.5 text-xs text-white outline-none"
                  />
                </div>

                <div className="space-y-2 text-xs">
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#121622] px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500">随机 20 位高熵密码</div>
                      <div className="truncate font-mono text-indigo-200">{samplePassword}</div>
                    </div>
                    <CopyButton value={samplePassword} />
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#121622] px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500">4 词易记助记词短语</div>
                      <div className="truncate font-mono text-slate-200">{samplePhrase}</div>
                    </div>
                    <CopyButton value={samplePhrase} />
                  </div>
                  <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-800 bg-[#121622] px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-[10px] text-slate-500">域名防追踪邮箱别名</div>
                      <div className="truncate font-mono text-emerald-300">{sampleAlias}</div>
                    </div>
                    <CopyButton value={sampleAlias} />
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Full-Chain Architecture */}
      <section id="pipeline" className="border-b border-slate-800/80 bg-[#0d111a] py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-10 max-w-2xl">
            <h2 className="text-2xl font-bold text-white sm:text-3xl">从「收到邮件」到「六宫格自动填入」，不到 1 秒</h2>
            <p className="mt-2 text-sm text-slate-400">
              告别切窗口、翻收件箱、复制粘贴 6 位数字。全链路端到端加密，哪怕自建服务器被攻破也无法回溯你的历史邮件。
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            {[
              {
                step: '01',
                icon: <Cloud className="h-5 w-5 text-sky-400" />,
                title: '双通道毫秒收信',
                desc: '主力邮箱走 IMAP IDLE 长连接；自有域名别名走 Cloudflare Email Routing Worker（支持一键屏蔽垃圾别名）。',
              },
              {
                step: '02',
                icon: <Shield className="h-5 w-5 text-indigo-400" />,
                title: 'X25519 公钥密封',
                desc: '提取验证码与 Magic Link 后立即用你的 X25519 公钥密封落库；启用边缘加密模式时服务器全程零明文。',
              },
              {
                step: '03',
                icon: <Zap className="h-5 w-5 text-amber-400" />,
                title: 'WebSocket 实时推送',
                desc: '服务端通过 /api/ws 推送加密信封到已解锁的浏览器插件、Web Vault 与阻塞等待中的 np CLI。',
              },
              {
                step: '04',
                icon: <CheckCircle2 className="h-5 w-5 text-emerald-400" />,
                title: '状态接力自动填',
                desc: '第 1 步填充账密后插件记住目标账号，第 2 步自动匹配 TOTP 或最新邮箱验证码一键填满 6 宫格。',
              },
            ].map((card) => (
              <div
                key={card.step}
                className="relative rounded-2xl border border-slate-800 bg-[#121622] p-5"
              >
                <div className="mb-4 flex items-center justify-between">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#0b0e14] ring-1 ring-slate-800">
                    {card.icon}
                  </div>
                  <span className="font-mono text-xs font-bold text-slate-600">{card.step}</span>
                </div>
                <h3 className="text-sm font-semibold text-white">{card.title}</h3>
                <p className="mt-2 text-xs leading-relaxed text-slate-400">{card.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Browser Extension Showcase */}
      <section id="extension" className="border-b border-slate-800/80 bg-[#0e121c] py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
            <div className="space-y-5 lg:col-span-6">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
                <Globe className="h-3.5 w-3.5" />
                <span>Chrome · Arc · Edge · Brave MV3 扩展</span>
              </div>
              <h2 className="text-2xl font-bold text-white sm:text-3xl">
                浏览器自动填充插件（含六宫格接力）
              </h2>
              <p className="text-sm leading-relaxed text-slate-300">
                内置同源 <code className="text-indigo-300">nonepwd_core.wasm</code> 的 Manifest V3 扩展：在闭合 Shadow DOM 浮窗中安全隔离填充账号密码、TOTP 2FA、实时 WebSocket 推送的邮箱验证码，支持注册页一键生成别名邮箱与 20 位强密码。
              </p>

              <div className="flex flex-wrap gap-3 pt-1">
                <a
                  href="/downloads/nonepwd-extension.zip"
                  download="nonepwd-extension.zip"
                  className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white shadow-lg shadow-indigo-600/25 transition hover:bg-indigo-500"
                >
                  <Download className="h-4 w-4" />
                  <span>下载浏览器插件包 (nonepwd-extension.zip)</span>
                </a>
                <a
                  href="/demo-login"
                  className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#121622] px-4 py-2.5 text-xs font-medium text-slate-200 transition hover:border-indigo-500/50 hover:text-white"
                >
                  <KeyRound className="h-3.5 w-3.5 text-indigo-400" />
                  <span>体验插件自动填充沙盒</span>
                </a>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-[#0b0e14] p-4 text-xs text-slate-300">
                <div className="mb-2 font-semibold text-white">3 步本地加载扩展程序：</div>
                <ol className="list-decimal space-y-1.5 pl-4 text-slate-400">
                  <li>
                    点击上方下载 <code className="text-indigo-300">nonepwd-extension.zip</code> 并解压（源码构建目录同样位于{' '}
                    <code className="text-slate-200">packages/extension/dist</code>）。
                  </li>
                  <li>
                    在浏览器地址栏打开 <code className="text-slate-200">chrome://extensions</code>，开启右上角{' '}
                    <strong className="text-slate-200">开发者模式 (Developer mode)</strong>。
                  </li>
                  <li>
                    点击 <strong className="text-slate-200">加载已解压的扩展程序</strong> 选择解压文件夹即可启用（图标解锁后通过 WebSocket 与服务端保持同步）。
                  </li>
                </ol>
              </div>
            </div>

            <div className="space-y-3 lg:col-span-6">
              <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-500/15 text-indigo-400">
                    <Shield className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">
                      闭合 Shadow DOM 内联浮窗（<code className="font-mono text-xs text-indigo-300">data-nonepwd-overlay</code>）
                    </h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      样式与事件完全隔离于宿主网页，免疫 CSS 污染与页面脚本窃取，支持键盘 <code className="text-slate-300">↑ ↓ Enter</code> 极速选取并触发 React/Vue 受控表单事件。
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                    <Zap className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">多步登录接力 + 6 宫格一次性填入</h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      第 1 步填充账号密码后自动记录当前 Tab 关联条目；进入第 2 步验证页时，优先呈现对应 2FA TOTP 与刚通过 WebSocket 推送的邮箱验证码，一键填满 6 个独立方框。
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5">
                <div className="flex items-start gap-3.5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400">
                    <MailCheck className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="text-sm font-semibold text-white">注册页强密码 + 独立别名自动入库</h3>
                    <p className="mt-1 text-xs leading-relaxed text-slate-400">
                      识别 <code className="text-slate-300">autocomplete="new-password"</code> 注册输入框，一键申请当前域名专属 Masked Email 并生成 20 位高熵密码，自动加密保存至 Vault。
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Comparison Matrix */}
      <section id="comparison" className="border-b border-slate-800/80 py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="mb-8">
            <h2 className="text-2xl font-bold text-white sm:text-3xl">为什么自建 nonepwd？</h2>
            <p className="mt-1.5 text-sm text-slate-400">
              把双密钥零知识加密、开发者友好的 CLI/Connect 生态与实时邮箱验证码自动化，彻底整合进你自己的免费单容器服务。
            </p>
          </div>

          <div className="overflow-x-auto rounded-2xl border border-slate-800 bg-[#121622]">
            <table className="w-full min-w-[640px] border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-[#0d111a] text-slate-400">
                  <th className="px-5 py-3.5 font-semibold">核心能力维度</th>
                  <th className="px-5 py-3.5 font-semibold text-indigo-300">nonepwd (本项目)</th>
                  <th className="px-5 py-3.5 font-semibold">传统商业云密码库</th>
                  <th className="px-5 py-3.5 font-semibold">常规开源自建方案</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {[
                  ['私有化自建与零订阅费', '单容器 + 内置 SQLite，永久 0 订阅费', '闭源云托管，按年付费', '支持自建'],
                  ['双密钥架构 (Master + Secret Key)', '原生 NP3-... 双密钥 + 60万次 PBKDF2', '双密钥体系', '多数仅单主密码派生'],
                  ['邮箱验证码提取 + 6 宫格自动填充', 'IMAP IDLE + CF Worker + 实时推送', '无内置邮件码通道', '无'],
                  ['无限域名别名 + 一键拉黑防骚扰', '原生内置（不依赖第三方付费）', '需绑定付费邮箱服务', '需接第三方 Relay'],
                  ['多步登录 2FA / 邮箱码接力', 'Shadow DOM 浮窗自动接力', '基础多步填充', '需频繁手动切菜单'],
                  ['CLI / Connect API + 等待邮件码', '原生 Rust `np` + `np mail otp --wait`', '不支持阻塞等邮件码', '无内置实时邮箱等待'],
                  ['核心引擎技术', '纯 Rust 同一代码库编译 WASM + Native', '闭源客户端实现', '前后端独立实现'],
                ].map(([dim, npVal, cloudVal, ossVal]) => (
                  <tr key={dim} className="hover:bg-slate-800/25">
                    <td className="px-5 py-3.5 font-medium text-slate-200">{dim}</td>
                    <td className="px-5 py-3.5 font-medium text-emerald-300">{npVal}</td>
                    <td className="px-5 py-3.5 text-slate-400">{cloudVal}</td>
                    <td className="px-5 py-3.5 text-slate-400">{ossVal}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Native np CLI & Binary Downloads */}
      <section id="cli" className="border-b border-slate-800/80 bg-[#0d111a] py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
            <div className="space-y-5 lg:col-span-5">
              <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-300">
                <Terminal className="h-3.5 w-3.5" />
                <span>原生 Rust 单二进制 · 零 Node / 零 OpenSSL 依赖</span>
              </div>
              <h2 className="text-2xl font-bold text-white sm:text-3xl">为开发者而生的 `np` CLI</h2>
              <p className="text-sm leading-relaxed text-slate-400">
                现代命令行密钥体验：环境变量零落盘、Service Account 分库隔离、本地 Connect REST API，还能直接阻塞等待邮箱验证码，为 E2E 测试和 AI Agent 补齐登录最后一公里。
              </p>

              {/* Real Downloads / Standalone CLI Install */}
              {phase === 'standalone' ? (
                <div className="space-y-2.5 pt-2">
                  <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/80 bg-[#121622] px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white">一键安装脚本 (macOS / Linux)</div>
                      <code className="block truncate font-mono text-[11px] text-indigo-300">
                        curl -fsSL {origin}/install.sh | bash
                      </code>
                    </div>
                    <CopyButton value={`curl -fsSL ${origin}/install.sh | bash`} label="复制" />
                  </div>

                  <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-700/80 bg-[#121622] px-4 py-3">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white">npm 全局安装 (@nonepwd/cli)</div>
                      <code className="block truncate font-mono text-[11px] text-emerald-300">
                        npm install -g @nonepwd/cli
                      </code>
                    </div>
                    <CopyButton value="npm install -g @nonepwd/cli" label="复制" />
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5 pt-2">
                  <a
                    href="/downloads/np-darwin-arm64"
                    download="np-darwin-arm64"
                    className="flex items-center justify-between rounded-xl border border-slate-700/80 bg-[#121622] px-4 py-3 transition hover:border-indigo-500/60"
                  >
                    <div>
                      <div className="text-xs font-semibold text-white">macOS (Apple Silicon arm64)</div>
                      <div className="text-[11px] text-slate-400">Mach-O 64-bit 原生可执行文件 · np-darwin-arm64</div>
                    </div>
                    <Download className="h-4 w-4 text-indigo-400" />
                  </a>

                  <a
                    href="/downloads/np-linux-x86_64"
                    download="np-linux-x86_64"
                    className="flex items-center justify-between rounded-xl border border-slate-700/80 bg-[#121622] px-4 py-3 transition hover:border-emerald-500/60"
                  >
                    <div>
                      <div className="text-xs font-semibold text-white">Linux (x86_64 musl 静态二进制)</div>
                      <div className="text-[11px] text-slate-400">静态链接 ELF · np-linux-x86_64，Ubuntu / Alpine 拷贝即用</div>
                    </div>
                    <Download className="h-4 w-4 text-emerald-400" />
                  </a>
                </div>
              )}
            </div>

            <div className="rounded-2xl border border-slate-800 bg-[#121622] p-5 lg:col-span-7">
              <div className="mb-4 flex flex-wrap gap-1.5 border-b border-slate-800 pb-3">
                {(
                  [
                    ['run', 'np run 注入'],
                    ['mail', 'np mail otp 等待码'],
                    ['sa', 'Service Account'],
                    ['connect', 'Connect HTTP API'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setCliTab(key)}
                    className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                      cliTab === key
                        ? 'bg-indigo-600 text-white'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="mb-2 flex items-center justify-between">
                <span className="text-xs font-medium text-slate-300">
                  {CLI_EXAMPLES[cliTab].title}
                </span>
                <CopyButton value={CLI_EXAMPLES[cliTab].cmd} label="复制脚本" />
              </div>

              <pre className="overflow-x-auto rounded-xl border border-slate-800 bg-[#0b0e14] p-4 font-mono text-xs leading-relaxed text-indigo-100">
                {CLI_EXAMPLES[cliTab].cmd}
              </pre>
            </div>
          </div>
        </div>
      </section>

      {/* Self-Hosting Deploy Section */}
      <section id="deploy" className="py-16">
        <div className="mx-auto max-w-6xl px-6">
          <div className="rounded-3xl border border-indigo-500/30 bg-gradient-to-br from-indigo-950/40 via-[#121622] to-[#0d111a] p-8 sm:p-10">
            <div className="grid grid-cols-1 items-center gap-8 lg:grid-cols-12">
              <div className="lg:col-span-6">
                <h2 className="text-2xl font-bold text-white sm:text-3xl">30 秒私有化部署</h2>
                <p className="mt-2.5 text-sm leading-relaxed text-slate-300">
                  单容器自带内置 SQLite 持久化数据库、Web 管理台、WebSocket 推送、IMAP IDLE 守护与 Cloudflare Webhook 接口。配合 Cloudflare Tunnel 或 Caddy 即可安全接入公网。
                </p>
                <div className="mt-6 flex flex-wrap gap-3">
                  <button
                    type="button"
                    onClick={onOpenVault}
                    className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500"
                  >
                    <span>{primaryCtaLabel}</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                  <a
                    href="/demo-login"
                    className="inline-flex items-center gap-2 rounded-xl border border-slate-700 bg-[#0b0e14] px-4 py-2.5 text-xs font-medium text-slate-200 hover:border-indigo-500/50"
                  >
                    体验自动填充沙盒
                  </a>
                </div>
              </div>

              <div className="rounded-2xl border border-slate-800 bg-[#0b0e14] p-4 lg:col-span-6">
                <div className="mb-2 flex items-center justify-between text-xs text-slate-400">
                  <span>npm 一键启动 / Docker 常驻部署</span>
                  <CopyButton value="npx @nonepwd/server" label="复制" />
                </div>
                <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-slate-200">{`# 方式 1：免克隆零配置直接启动本地私有 Vault（推荐快速体验）
npx @nonepwd/server
# 浏览器访问 http://127.0.0.1:8787/vault 初始化并保存 NP3-... Secret Key

# 方式 2：全局安装 CLI 与服务端
npm install -g @nonepwd/cli @nonepwd/server

# 方式 3：Docker Compose 常驻部署
docker compose up -d --build

# 命令行一键安装跨平台原生 Rust np CLI：
curl -fsSL ${origin}/install.sh | bash`}</pre>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 py-8 text-center text-xs text-slate-500">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-6 sm:flex-row">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-indigo-400" />
            <span>nonepwd Self-Hosted Zero-Knowledge Vault · Rust + WASM</span>
          </div>
          <div className="flex items-center gap-5">
            <button type="button" onClick={onOpenVault} className="hover:text-slate-300">
              Web Vault (/vault)
            </button>
            <a href="/demo-login" className="hover:text-slate-300">
              Autofill Playground (/demo-login)
            </a>
            <a href="/install.sh" className="hover:text-slate-300">
              CLI Installer (/install.sh)
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
};
