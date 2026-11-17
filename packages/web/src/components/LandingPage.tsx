import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  Cpu,
  Download,
  ExternalLink,
  KeyRound,
  Layers,
  Lock,
  MailCheck,
  Moon,
  RefreshCw,
  Shield,
  Sun,
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

type LabTab = 'otp' | 'crypto' | 'totp' | 'cli';
type CliTab = 'run' | 'mail' | 'sa' | 'connect';

const OTP_PRESETS = [
  {
    id: 'github',
    label: 'GitHub HTML',
    from: 'GitHub <noreply@github.com>',
    subject: '[GitHub] Please verify your device',
    body: `<div style="color:#445566">Your GitHub verification code is:</div>\n<div style="font-size:28px;color:#112233">839204</div>\n<p>Or verify directly: https://github.com/login/verify?token=gh_91a2</p>\n<footer>© 2026 GitHub Inc. Order #998877</footer>`,
  },
  {
    id: 'steam',
    label: 'Steam 中文',
    from: 'Steam <noreply@steampowered.com>',
    subject: '您的 Steam 令牌安全验证码',
    body: '您好，您本次登录的安全验证码为：649-102，5分钟内有效。客服电话 4001234567。',
  },
  {
    id: 'cursor',
    label: 'Magic Link',
    from: 'Cursor <no-reply@cursor.com>',
    subject: 'Sign in to Cursor',
    body: 'Your one-time verification code is 519382.\nMagic link: https://cursor.com/auth/magic?token=cur_demo_881',
  },
  {
    id: 'promo',
    label: '防误判过滤',
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

const FAQ_ITEMS = [
  {
    q: '服务端真的拿不到我的任何密码或邮件内容吗？',
    a: '是的。主密码与 Secret Key (NP3-...) 仅在本地浏览器 WASM 或原生 Rust CLI 内存中完成 60 万次 PBKDF2 派生；每条条目再以独立的 256-bit VaultKey + AES-256-GCM 加密，并绑定 AAD(vaultId, itemId)。收到的验证码邮件也会被 X25519 公钥当场密封落库。',
  },
  {
    q: '邮箱验证码和 6 宫格自动填充是怎么串起来的？',
    a: '主力邮箱走 IMAP IDLE 长连接，自有域名别名走 Cloudflare Email Routing Worker。服务端解析验证码并密封后通过 WebSocket 秒级推送到已解锁的浏览器扩展和 np CLI；多步登录在第 1 步填完账密后，第 2 步会自动弹出 2FA TOTP 或刚收到的 6 位邮箱码一次填满 6 格输入框。',
  },
  {
    q: '浏览器扩展和原生命令行共用一套加密核心吗？',
    a: '完全同源。核心密码学、RFC 6238 TOTP、邮件验证码清洗与 np:// 引用解析全部由 crates/nonepwd-core 用纯 Rust 编写：同一份代码编译为 nonepwd_core.wasm 驱动 Web 与浏览器插件，同时静态链接产出 macOS arm64 / Linux x86_64 原生 np 单二进制。',
  },
  {
    q: '自建需要重型数据库或外部依赖吗？',
    a: '不需要。@nonepwd/server 内置 Node SQLite 持久化数据库，一条 npx @nonepwd/server 即可在本机运行，也提供轻量单容器 Docker 镜像（配合 Cloudflare Tunnel 或 Caddy 即可安全接入公网多端同步）。',
  },
  {
    q: '和商业云密码管理器有什么区别？',
    a: '没有云端账户体系、没有按年订阅费，所有密文、别名策略与邮箱收信通道全部掌握在你自己的设备或服务器上，同时原生补齐了开发者和 AI Agent 最常卡住的「阻塞等待实时邮箱验证码」最后一公里。',
  },
];

const BrandMark: React.FC<{ className?: string }> = ({ className = 'size-8' }) => (
  <span
    className={`inline-flex shrink-0 items-center justify-center rounded-[6px] bg-primary text-primary-foreground ${className}`}
    aria-hidden="true"
  >
    <svg viewBox="0 0 24 24" className="size-[58%]" fill="none" stroke="currentColor" strokeWidth="2.1">
      <circle cx="12" cy="9.5" r="3.2" />
      <path d="M12 12.7v5.3" strokeLinecap="round" />
      <path d="M12 15.5h2.5" strokeLinecap="round" />
    </svg>
  </span>
);

export const LandingPage: React.FC<LandingPageProps> = ({ onOpenVault }) => {
  const { phase, knownEmail } = useVault();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8787';

  // Sync light/dark theme toggle with documentElement.classList('dark')
  const [isDark, setIsDark] = useState(() =>
    typeof document !== 'undefined' ? document.documentElement.classList.contains('dark') : false
  );

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('nonepwd.theme', next ? 'dark' : 'light');
    } catch {
      // ignore storage failure
    }
  };

  // Workbench Tabs
  const [labTab, setLabTab] = useState<LabTab>('otp');
  const [cliTab, setCliTab] = useState<CliTab>('run');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

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

  const primaryCtaLabel =
    phase === 'standalone'
      ? '私有部署与上手'
      : phase === 'uninitialized'
      ? '初始化密码库'
      : phase === 'unlocked'
      ? '进入密码库'
      : '解锁密码库';

  const statusPillText =
    phase === 'standalone'
      ? 'Zero-knowledge · Self-hosted · 0 订阅费'
      : phase === 'uninitialized'
      ? '本地私有实例已就绪 · 等待初始化'
      : phase === 'unlocked'
      ? `Vault 已解锁 (${knownEmail ?? 'owner'})`
      : `实例已初始化 (${knownEmail ?? 'locked'}) · 双密钥保护`;

  return (
    <div className="min-h-dvh bg-background text-foreground antialiased">
      <div className="mx-auto w-full max-w-[1100px] border-border/70 md:border-x">
        {/* Header */}
        <header className="flex h-16 items-center justify-between px-5 md:px-10">
          <a href="/" className="flex items-center gap-2.5">
            <BrandMark className="size-8" />
            <span className="text-[15px] font-semibold tracking-tight">nonepwd</span>
          </a>

          <div className="flex items-center gap-4">
            <nav className="hidden items-center gap-5 text-[13px] text-muted-foreground sm:flex">
              <a href="#live-lab" className="transition-colors hover:text-foreground">
                WASM 实验室
              </a>
              <a href="/demo-login" className="transition-colors hover:text-foreground">
                6 宫格沙盒
              </a>
              <a
                href="/downloads/nonepwd-extension.zip"
                download="nonepwd-extension.zip"
                className="transition-colors hover:text-foreground"
              >
                浏览器插件
              </a>
            </nav>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="切换明暗主题"
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              {isDark ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
            </button>

            <button
              type="button"
              onClick={onOpenVault}
              className="inline-flex h-7 items-center gap-1 rounded-[8px] bg-primary px-2.5 text-[0.8rem] font-medium text-primary-foreground transition-colors hover:bg-primary/85"
            >
              <span>{primaryCtaLabel}</span>
            </button>
          </div>
        </header>

        <main>
          {/* Left-aligned Hero Section */}
          <section className="px-5 pt-14 pb-14 md:px-10 md:pt-24">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
              <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-foreground text-[10px] font-bold text-background">
                N
              </span>
              <span>{statusPillText}</span>
            </div>

            <h1 className="max-w-4xl text-4xl font-semibold tracking-[-0.03em] text-balance md:text-[3.35rem] md:leading-[1.06]">
              一个私有实例，接管你的全部密码与验证码。
            </h1>

            <p className="mt-5 max-w-[38rem] text-[17px] leading-relaxed text-pretty text-muted-foreground">
              双密钥零知识加密（<code className="font-mono text-[15px] text-foreground">NP3-...</code>）、实时邮箱验证码提取、2FA
              动态口令、MV3 浏览器自动填充与原生 Rust <code className="font-mono text-[15px] text-foreground">np</code> CLI —
              完全运行在你自己的机器上。
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-x-3.5 gap-y-3">
              <button
                type="button"
                onClick={onOpenVault}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
              >
                <span>{primaryCtaLabel}</span>
                <ArrowRight className="size-4" />
              </button>

              <a
                href="/downloads/nonepwd-extension.zip"
                download="nonepwd-extension.zip"
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-4" />
                <span>下载浏览器插件</span>
              </a>

              <div className="inline-flex h-10 items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 font-mono text-xs text-muted-foreground">
                <span>npx @nonepwd/server</span>
                <CopyButton value="npx @nonepwd/server" variant="minimal" />
              </div>
            </div>

            <div className="mt-16">
              <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
                Built on one pure-Rust core across every surface
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-7 gap-y-2.5 font-mono text-xs text-muted-foreground">
                <span>Rust + WASM</span>
                <span>AES-256-GCM</span>
                <span>X25519 Sealed Box</span>
                <span>Chrome / Arc / Edge MV3</span>
                <span>IMAP IDLE</span>
                <span>Cloudflare Workers</span>
                <span>macOS &amp; Linux CLI</span>
              </div>
            </div>
          </section>

          {/* Flush Interactive Workbench Showcase */}
          <section id="live-lab" className="border-t border-border/70">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/30 px-5 py-3 md:px-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  nonepwd_core.wasm · 本地浏览器实时运行中
                </span>
              </div>

              <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-border bg-background p-0.5">
                {(
                  [
                    ['otp', '邮箱验证码提取'],
                    ['crypto', '零知识密文'],
                    ['totp', '2FA 与别名'],
                    ['cli', 'np CLI'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setLabTab(key)}
                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                      labTab === key
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {labTab === 'otp' && (
              <div className="grid grid-cols-1 gap-px bg-border/70 lg:grid-cols-12">
                <div className="space-y-4 bg-background p-5 md:p-8 lg:col-span-7">
                  <div className="flex flex-wrap gap-1.5">
                    {OTP_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => {
                          setOtpFrom(p.from);
                          setOtpSubject(p.subject);
                          setOtpBody(p.body);
                        }}
                        className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label className="mb-1.5 block font-mono text-[11px] text-muted-foreground uppercase">
                        From
                      </label>
                      <input
                        type="text"
                        value={otpFrom}
                        onChange={(e) => setOtpFrom(e.target.value)}
                        className="w-full rounded-md border border-input bg-muted/25 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block font-mono text-[11px] text-muted-foreground uppercase">
                        Subject
                      </label>
                      <input
                        type="text"
                        value={otpSubject}
                        onChange={(e) => setOtpSubject(e.target.value)}
                        className="w-full rounded-md border border-input bg-muted/25 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mb-1.5 block font-mono text-[11px] text-muted-foreground uppercase">
                      Body · <span className="normal-case">extract_email_otp(mime)</span>
                    </label>
                    <textarea
                      rows={5}
                      value={otpBody}
                      onChange={(e) => setOtpBody(e.target.value)}
                      className="w-full rounded-md border border-input bg-muted/25 px-3 py-2.5 font-mono text-xs leading-relaxed text-foreground outline-none focus:border-ring"
                    />
                  </div>
                </div>

                <div className="flex flex-col justify-between bg-background p-5 md:p-8 lg:col-span-5">
                  <div>
                    <div className="mb-4 flex items-center justify-between">
                      <span className="font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                        Extraction Output
                      </span>
                      <span className="rounded border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                        {otpResult.senderDomain || 'unknown'}
                      </span>
                    </div>

                    {otpResult.otpCode ? (
                      <div className="rounded-lg border border-border bg-muted/30 p-4">
                        <div className="flex items-center justify-between">
                          <span className="font-mono text-xs text-muted-foreground">
                            OTP · 置信度 {Math.round(otpResult.confidence * 100)}%
                          </span>
                          <CopyButton value={otpResult.otpCode} label="复制" variant="minimal" />
                        </div>
                        <div
                          data-testid="lab-otp-code"
                          className="mt-2 font-mono text-3xl font-semibold tracking-[0.2em] text-foreground"
                        >
                          {otpResult.otpCode}
                        </div>
                      </div>
                    ) : (
                      <div
                        data-testid="lab-otp-empty"
                        className="rounded-lg border border-border bg-muted/25 p-4 text-xs leading-relaxed text-muted-foreground"
                      >
                        未检测到高置信度验证码（已自动过滤年份、金额、订单号与 CSS 十六进制色值）。
                      </div>
                    )}

                    {otpResult.magicLink && (
                      <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
                        <div className="font-mono text-[11px] text-muted-foreground uppercase">
                          Magic Link
                        </div>
                        <div className="mt-1 flex items-center gap-1.5 truncate font-mono text-xs text-foreground">
                          <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
                          <span className="truncate">{otpResult.magicLink}</span>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-6 border-t border-border/70 pt-4">
                    <div className="font-mono text-[11px] text-muted-foreground uppercase">
                      Sanitized Snippet
                    </div>
                    <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
                      {otpResult.snippet || '(空)'}
                    </p>
                  </div>
                </div>
              </div>
            )}

            {labTab === 'crypto' && (
              <div className="grid grid-cols-1 gap-px bg-border/70 lg:grid-cols-2">
                <div className="space-y-4 bg-background p-5 md:p-8">
                  <div>
                    <label className="mb-1.5 block font-mono text-[11px] text-muted-foreground uppercase">
                      测试明文（仅在当前浏览器 WASM 内存加密）
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={secretInput}
                        onChange={(e) => setSecretInput(e.target.value)}
                        className="flex-1 rounded-md border border-input bg-muted/25 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                      />
                      <button
                        type="button"
                        onClick={() => setCryptoSeed((n) => n + 1)}
                        className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85"
                      >
                        <RefreshCw className="size-3.5" />
                        <span>重新密封</span>
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-4 text-xs leading-relaxed text-muted-foreground">
                    <div className="font-medium text-foreground">零知识落库原则</div>
                    <p>
                      Vault 条目使用随机 256-bit <code className="text-foreground">VaultKey</code> +{' '}
                      <code className="text-foreground">AES-256-GCM</code> 加密，绑定{' '}
                      <code className="text-foreground">AAD(vaultId, itemId)</code> 防止跨库密文调包。
                    </p>
                    <p>
                      邮件验证码进入服务端或 Cloudflare 边缘 Worker 时，立刻使用你的{' '}
                      <code className="text-foreground">X25519</code> 公钥密封。
                    </p>
                  </div>
                </div>

                <div className="space-y-3 bg-background p-5 md:p-8">
                  <div className="rounded-lg border border-border bg-muted/25 p-4">
                    <div className="mb-1.5 flex items-center justify-between font-mono text-[11px] text-muted-foreground">
                      <span>SQLite · items.encrypted_data</span>
                      {cryptoPreview && <CopyButton value={cryptoPreview.vaultBlob} variant="minimal" />}
                    </div>
                    <code
                      data-testid="lab-vault-blob"
                      className="block break-all font-mono text-[11px] text-foreground"
                    >
                      {cryptoPreview?.vaultBlob ?? '计算中...'}
                    </code>
                  </div>

                  <div className="rounded-lg border border-border bg-muted/25 p-4">
                    <div className="mb-1.5 font-mono text-[11px] text-muted-foreground">
                      SQLite · encrypted_emails.sealed_envelope (X25519 + HKDF)
                    </div>
                    <pre className="overflow-x-auto font-mono text-[11px] text-foreground">
                      {cryptoPreview
                        ? JSON.stringify(cryptoPreview.sealedEnvelope, null, 2)
                        : '计算中...'}
                    </pre>
                  </div>
                </div>
              </div>
            )}

            {labTab === 'totp' && (
              <div className="grid grid-cols-1 gap-px bg-border/70 lg:grid-cols-2">
                <div className="flex flex-col justify-between bg-background p-5 md:p-8">
                  <div>
                    <label className="mb-1.5 block font-mono text-[11px] text-muted-foreground uppercase">
                      Base32 2FA Secret / otpauth:// URI
                    </label>
                    <input
                      type="text"
                      value={totpSecret}
                      onChange={(e) => setTotpSecret(e.target.value)}
                      className="w-full rounded-md border border-input bg-muted/25 px-3 py-2 font-mono text-xs text-foreground outline-none focus:border-ring"
                    />
                  </div>

                  <div className="mt-6 flex items-center justify-between rounded-lg border border-border bg-muted/30 p-5">
                    <div className="flex items-center gap-4">
                      <svg className="size-11 -rotate-90" viewBox="0 0 36 36">
                        <circle
                          cx="18"
                          cy="18"
                          r="15"
                          fill="none"
                          stroke="currentColor"
                          className="text-border"
                          strokeWidth="3"
                        />
                        <circle
                          cx="18"
                          cy="18"
                          r="15"
                          fill="none"
                          stroke="currentColor"
                          className="text-foreground transition-all"
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
                        <div className="font-mono text-[11px] text-muted-foreground">
                          RFC 6238 TOTP · {totpLive?.remainingSeconds ?? '-'}s
                        </div>
                        <div
                          data-testid="lab-totp-code"
                          className="mt-1 font-mono text-3xl font-semibold tracking-widest text-foreground"
                        >
                          {totpLive
                            ? `${totpLive.code.slice(0, 3)} ${totpLive.code.slice(3)}`
                            : '无效密钥'}
                        </div>
                      </div>
                    </div>
                    {totpLive && <CopyButton value={totpLive.code} label="复制" variant="minimal" />}
                  </div>
                </div>

                <div className="space-y-3 bg-background p-5 md:p-8">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] text-muted-foreground uppercase">
                      Password &amp; Alias Generator
                    </span>
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
                      className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted"
                    >
                      <RefreshCw className="size-3" /> 换一批
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
                      className="rounded-md border border-input bg-muted/25 px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-ring"
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
                      className="rounded-md border border-input bg-muted/25 px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus:border-ring"
                    />
                  </div>

                  <div className="space-y-2 text-xs">
                    {[
                      ['20 位高熵密码', samplePassword],
                      ['4 词助记词', samplePhrase],
                      ['域名防追踪别名', sampleAlias],
                    ].map(([label, val]) => (
                      <div
                        key={label}
                        className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-3 py-2"
                      >
                        <div className="min-w-0">
                          <div className="font-mono text-[10px] text-muted-foreground">{label}</div>
                          <div className="truncate font-mono text-foreground">{val}</div>
                        </div>
                        <CopyButton value={val} variant="minimal" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {labTab === 'cli' && (
              <div className="grid grid-cols-1 gap-px bg-border/70 lg:grid-cols-12">
                <div className="space-y-2 bg-background p-5 md:p-8 lg:col-span-5">
                  <div className="mb-3 font-mono text-[11px] tracking-[0.12em] text-muted-foreground uppercase">
                    Native Rust `np` CLI
                  </div>
                  {(
                    [
                      ['run', 'np run 零落盘注入'],
                      ['mail', 'np mail otp 阻塞等待'],
                      ['sa', 'Service Account 隔离'],
                      ['connect', 'Connect HTTP API'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setCliTab(key)}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-xs font-medium transition-colors ${
                        cliTab === key
                          ? 'border-foreground bg-primary text-primary-foreground'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                      }`}
                    >
                      <span>{label}</span>
                      <ArrowRight className="size-3.5" />
                    </button>
                  ))}
                </div>

                <div className="bg-background p-5 md:p-8 lg:col-span-7">
                  <div className="mb-3 flex items-center justify-between">
                    <span className="text-xs font-medium text-muted-foreground">
                      {CLI_EXAMPLES[cliTab].title}
                    </span>
                    <CopyButton value={CLI_EXAMPLES[cliTab].cmd} label="复制" variant="minimal" />
                  </div>
                  <pre className="overflow-x-auto rounded-lg border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed text-foreground">
                    {CLI_EXAMPLES[cliTab].cmd}
                  </pre>
                </div>
              </div>
            )}
          </section>

          {/* 6-Cell Hairline Feature Grid (Waku Style) */}
          <section id="pipeline" className="border-t border-border/70">
            <div className="px-5 pt-14 md:px-10">
              <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
                Why self-hosted
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-px border-t border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-3">
              {[
                {
                  icon: Lock,
                  title: '双密钥零知识加密',
                  desc: 'Master Password + Secret Key (NP3-...) 本地 60 万次 PBKDF2 派生，Per-Vault 独立密钥与 AAD 绑定，数据库失窃也不泄露明文。',
                },
                {
                  icon: MailCheck,
                  title: '邮箱验证码秒级提取',
                  desc: '主力邮箱走 IMAP IDLE 长连接，自有域名走 Cloudflare Email Routing；X25519 公钥当场密封并通过 WebSocket 实时推送。',
                },
                {
                  icon: Zap,
                  title: '闭合 Shadow DOM 六宫格接力',
                  desc: 'MV3 扩展隔离宿主网页 CSS 与脚本。第 1 步填入账密后记住目标条目，第 2 步自动弹出 2FA 与最新邮箱码一键填满 6 格输入框。',
                },
                {
                  icon: Terminal,
                  title: '原生跨平台 np 命令行',
                  desc: '支持 np run 环境变量零落盘注入、Service Account 分库授权、Connect HTTP API，以及 np mail otp --wait 为脚本与 Agent 等码。',
                },
                {
                  icon: Shield,
                  title: '无限域名邮箱别名',
                  desc: '注册页聚焦输入框一键为当前站点派生专属 Masked Email 与 20 位强密码，并支持按别名一键拒收骚扰邮件。',
                },
                {
                  icon: Layers,
                  title: '单文件轻量化自建',
                  desc: '纯 Rust 核心（nonepwd-core）驱动全端 + 内置 Node SQLite 持久化。一条 npx @nonepwd/server 即可跑起来，永久 0 订阅费。',
                },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="bg-background p-6 md:p-8">
                    <div className="flex items-center gap-2.5">
                      <Icon className="size-4 text-muted-foreground" />
                      <h3 className="text-sm font-medium text-foreground">{item.title}</h3>
                    </div>
                    <p className="mt-2.5 text-sm leading-relaxed text-muted-foreground">
                      {item.desc}
                    </p>
                  </div>
                );
              })}
            </div>
          </section>

          {/* 3-Step Installation & Downloads */}
          <section id="deploy" className="border-t border-border/70 px-5 py-16 md:px-10 md:py-20">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Get nonepwd
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">三步跑通你的私有密码库</h2>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70 lg:grid-cols-3">
              {/* 01 Server */}
              <div className="flex flex-col justify-between bg-background p-6">
                <div>
                  <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>01 / SERVER</span>
                    <Cpu className="size-4" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">启动私有零知识服务端</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    免克隆零配置启动本地 SQLite 服务端，也支持 Docker Compose 部署配合隧道接入公网。
                  </p>
                </div>

                <div className="mt-5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                    <span className="truncate">npx @nonepwd/server</span>
                    <CopyButton value="npx @nonepwd/server" variant="minimal" />
                  </div>
                  <button
                    type="button"
                    onClick={onOpenVault}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground hover:bg-primary/85"
                  >
                    <span>{primaryCtaLabel}</span>
                    <ArrowRight className="size-3.5" />
                  </button>
                </div>
              </div>

              {/* 02 Browser Extension */}
              <div id="extension" className="flex flex-col justify-between bg-background p-6">
                <div>
                  <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>02 / EXTENSION</span>
                    <KeyRound className="size-4" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">加载 Chrome / Arc MV3 插件</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    下载插件包并解压，打开 <code className="text-foreground">chrome://extensions</code>{' '}
                    开启开发者模式后选择解压文件夹即可。
                  </p>
                </div>

                <div className="mt-5 space-y-2">
                  <a
                    href="/downloads/nonepwd-extension.zip"
                    download="nonepwd-extension.zip"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/60"
                  >
                    <Download className="size-3.5" />
                    <span>下载 nonepwd-extension.zip</span>
                  </a>
                  <a
                    href="/demo-login"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border/70 bg-muted/25 px-3 py-2 text-xs text-muted-foreground hover:text-foreground"
                  >
                    <span>打开 6 宫格自动填充沙盒</span>
                    <ArrowRight className="size-3.5" />
                  </a>
                </div>
              </div>

              {/* 03 Native CLI */}
              <div id="cli" className="flex flex-col justify-between bg-background p-6">
                <div>
                  <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>03 / CLI</span>
                    <Terminal className="size-4" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">安装原生 np 命令行</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    macOS 与 Linux 通用命令，支持加密会话登录、注入环境变量与实时接收邮件验证码。
                  </p>
                </div>

                <div className="mt-5 space-y-2">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                    <span className="truncate">curl -fsSL {origin}/install.sh | bash</span>
                    <CopyButton value={`curl -fsSL ${origin}/install.sh | bash`} variant="minimal" />
                  </div>

                  {phase === 'standalone' ? (
                    <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                      <span className="truncate">npm install -g @nonepwd/cli</span>
                      <CopyButton value="npm install -g @nonepwd/cli" variant="minimal" />
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 gap-2">
                      <a
                        href="/downloads/np-darwin-arm64"
                        download="np-darwin-arm64"
                        className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2.5 py-2 font-mono text-[11px] text-foreground hover:bg-muted/60"
                      >
                        <Download className="size-3" />
                        <span>macOS</span>
                      </a>
                      <a
                        href="/downloads/np-linux-x86_64"
                        download="np-linux-x86_64"
                        className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2.5 py-2 font-mono text-[11px] text-foreground hover:bg-muted/60"
                      >
                        <Download className="size-3" />
                        <span>Linux</span>
                      </a>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </section>

          {/* Minimal Accordion FAQ (Waku Style) */}
          <section className="border-t border-border/70 px-5 py-16 md:px-10">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Questions
            </div>

            <div className="mt-6 flex w-full max-w-2xl flex-col">
              {FAQ_ITEMS.map((item, idx) => {
                const opened = openFaq === idx;
                return (
                  <div key={item.q} className="border-b border-border/70 last:border-b-0">
                    <h3>
                      <button
                        type="button"
                        aria-expanded={opened}
                        onClick={() => setOpenFaq(opened ? null : idx)}
                        className="flex w-full items-center justify-between gap-4 py-3.5 text-left text-[15px] font-medium text-foreground transition-colors hover:underline"
                      >
                        <span>{item.q}</span>
                        <ChevronDown
                          className={`size-4 shrink-0 text-muted-foreground transition-transform ${
                            opened ? 'rotate-180' : ''
                          }`}
                        />
                      </button>
                    </h3>
                    {opened && (
                      <p className="pb-4 text-sm leading-relaxed text-muted-foreground">{item.a}</p>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        </main>

        {/* Footer */}
        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border/70 px-5 py-10 text-xs text-muted-foreground md:px-10">
          <div className="flex items-center gap-2">
            <BrandMark className="size-4 rounded-[4px] opacity-80 grayscale" />
            <span>© 2026 nonepwd · Zero-Knowledge Self-Hosted Vault</span>
          </div>

          <div className="flex items-center gap-5 font-mono text-[11px]">
            <button type="button" onClick={onOpenVault} className="hover:text-foreground">
              /vault
            </button>
            <a href="/demo-login" className="hover:text-foreground">
              /demo-login
            </a>
            <a href="/install.sh" className="hover:text-foreground">
              /install.sh
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};
