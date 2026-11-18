import React, { useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  Cloud,
  Download,
  ExternalLink,
  FolderLock,
  Globe,
  KeyRound,
  Laptop,
  Layers,
  Lock,
  MailCheck,
  Moon,
  QrCode,
  Shield,
  Smartphone,
  Sun,
  Terminal,
  Zap,
} from 'lucide-react';
import { useTheme } from '../state/theme';
import { useVault } from '../state/VaultContext';
import { CopyButton } from './CopyButton';

interface LandingPageProps {
  onOpenVault: () => void;
}

const RELEASE_TAG = 'v0.2.0';
const RELEASE_URL = `https://github.com/charlzyx/nonepwd/releases/tag/${RELEASE_TAG}`;
const RELEASE_DOWNLOAD_BASE = `https://github.com/charlzyx/nonepwd/releases/download/${RELEASE_TAG}`;

type CliTab = 'run' | 'mail' | 'sa' | 'connect';

const CLI_EXAMPLES: Record<CliTab, { title: string; cmd: string }> = {
  run: {
    title: '内存注入子进程，告别明文 .env',
    cmd: `# 原生兼容 op:// 与 np:// 引用
OPENAI_API_KEY=op://DevOps/OpenAI/credential
DB_PASSWORD=np://DevOps/Postgres/password

np run --env-file .env.tpl -- npm run dev`,
  },
  mail: {
    title: '阻塞等待最新邮箱验证码并本地解密',
    cmd: `# 通过纯 Rust TLS + WebSocket 实时等待并 X25519 解密
OTP=$(np mail otp --domain github.com --wait 30s)
echo "$OTP"`,
  },
  sa: {
    title: '签发仅限 DevOps 库的最小权限令牌',
    cmd: `np service-account create ci-runner --vault DevOps
export NONEPWD_TOKEN="npst_v1_..."

np read "np://DevOps/OpenAI/api_key"`,
  },
  connect: {
    title: '启动本地 HTTP 密钥解析网关',
    cmd: `np serve --connect --port 8788 --token my-connect-secret

curl -H "Authorization: Bearer my-connect-secret" \\
  "http://127.0.0.1:8788/v1/resolve?ref=np://DevOps/OpenAI/api_key"`,
  },
};

const FAQ_ITEMS = [
  {
    q: '服务端能看到我的密码或邮件内容吗？',
    a: '不能。主密码与 NP3 密钥仅在本地内存派生，密码库采用 AES-256-GCM 独立加密，验证码邮件以 X25519 公钥密封存储。',
  },
  {
    q: '实时邮箱验证码支持哪些收信方式？',
    a: '支持同时挂载 Gmail、QQ、163、iCloud、Outlook 等多账号 IMAP，以及绑定自有域名的 Cloudflare Email Routing 无限别名。',
  },
  {
    q: '如何从其他密码器或验证器迁移？',
    a: '支持 Chrome / 1Password CSV 批量导入，以及 Google Authenticator 导出二维码、桌面屏幕框选与手机扫码导入。',
  },
  {
    q: 'Cloudflare 部署会产生费用吗？',
    a: '个人日常使用完全在 Workers、D1、R2 与 Email Routing 免费额度内，无需购买服务器或订阅服务。',
  },
];

const FEATURES = [
  {
    icon: Lock,
    title: '双密钥零知识',
    desc: '主密码 + Secret Key 本地派生，Per-Vault AES-256-GCM 独立加密，服务端零明文。',
  },
  {
    icon: MailCheck,
    title: '实时邮箱接码',
    desc: '多账号 IMAP 与 Cloudflare 邮件路由双通道，X25519 密封后经 WebSocket 秒级推送。',
  },
  {
    icon: QrCode,
    title: '框选与扫码 2FA',
    desc: '支持桌面屏幕框选、网页划区识别与手机相机扫码，一键迁移 Google Authenticator。',
  },
  {
    icon: Zap,
    title: '全端自动填充',
    desc: 'Android 系统级 AutofillService 与 Shadow DOM 浏览器扩展，支持六宫格接力填充。',
  },
  {
    icon: Shield,
    title: '全品类密钥与别名',
    desc: '统一托管密码、API Key、SSH 密钥、银行卡与无限域名别名，骚扰邮件一键拒收。',
  },
  {
    icon: Layers,
    title: '零订阅费自建',
    desc: '单二进制 np server 开箱即用，或一键部署至 Cloudflare Worker + D1 + R2。',
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
  const { phase } = useVault();
  const { isDark, toggleTheme } = useTheme();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8787';

  const [cliTab, setCliTab] = useState<CliTab>('run');
  const [openFaq, setOpenFaq] = useState<number | null>(null);

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
      ? `${RELEASE_TAG} · Zero-Knowledge · Self-Hosted`
      : phase === 'uninitialized'
      ? `${RELEASE_TAG} · 实例就绪 · 待初始化`
      : phase === 'unlocked'
      ? `${RELEASE_TAG} · Vault 已解锁`
      : `${RELEASE_TAG} · 实例就绪 · 已锁定`;

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
              <a href="#features" className="transition-colors hover:text-foreground">
                特性
              </a>
              <a href="#clients" className="transition-colors hover:text-foreground">
                下载
              </a>
              <a href="#cli" className="transition-colors hover:text-foreground">
                CLI
              </a>
              <a href="#deploy" className="transition-colors hover:text-foreground">
                部署
              </a>
              <a
                href={RELEASE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
              >
                <span>GitHub</span>
                <ExternalLink className="size-3" />
              </a>
            </nav>

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="切换亮暗模式"
              title={isDark ? '切换到亮色模式' : '切换到暗色模式'}
              className="inline-flex size-7 items-center justify-center rounded-md border border-border/80 bg-background text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
          {/* Hero */}
          <section className="px-5 pt-16 pb-16 md:px-10 md:pt-24 md:pb-20">
            <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
              <span className="flex size-3.5 items-center justify-center rounded-[3px] bg-foreground text-[10px] font-bold text-background">
                N
              </span>
              <span>{statusPillText}</span>
            </div>

            <h1 className="max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-balance md:text-[3.35rem] md:leading-[1.08]">
              一个私有实例，接管你的全部密码与验证码。
            </h1>

            <p className="mt-5 max-w-[36rem] text-[16px] leading-relaxed text-pretty text-muted-foreground">
              纯 Rust 零知识加密核心，内置多邮箱实时接码与域名别名。原生覆盖 macOS、iOS、Android、浏览器扩展与 CLI。
            </p>

            <div className="mt-9 flex flex-wrap items-center gap-3.5">
              <button
                type="button"
                onClick={onOpenVault}
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/85"
              >
                <span>{primaryCtaLabel}</span>
                <ArrowRight className="size-4" />
              </button>

              <a
                href="#clients"
                className="inline-flex h-10 items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-4 text-sm font-medium text-foreground transition-colors hover:bg-muted/60"
              >
                <Download className="size-4" />
                <span>下载客户端</span>
              </a>

              <div className="inline-flex h-10 items-center gap-2.5 rounded-lg border border-border bg-muted/40 px-3 font-mono text-xs text-muted-foreground">
                <span>np server</span>
                <CopyButton value="np server" variant="minimal" />
              </div>
            </div>
          </section>

          {/* Architectural Product Preview Window */}
          <section className="border-t border-border/70">
            <div className="flex items-center justify-between border-b border-border/70 bg-muted/35 px-5 py-2.5 md:px-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  nonepwd — /vault
                </span>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                WebSocket Live · AES-256-GCM
              </span>
            </div>

            <div className="grid grid-cols-1 gap-px bg-border/70 md:grid-cols-12">
              {/* Vaults */}
              <div className="flex flex-col justify-between space-y-4 bg-card/60 p-5 md:col-span-3">
                <div className="space-y-3">
                  <div className="font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                    Vaults
                  </div>
                  <div className="space-y-1 text-xs">
                    <div className="flex items-center justify-between rounded-md bg-muted px-2.5 py-1.5 font-medium text-foreground">
                      <span className="flex items-center gap-2">
                        <FolderLock className="size-3.5 text-muted-foreground" />
                        Personal
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">14</span>
                    </div>
                    <div className="flex items-center justify-between rounded-md px-2.5 py-1.5 text-muted-foreground">
                      <span className="flex items-center gap-2">
                        <Terminal className="size-3.5" />
                        DevOps
                      </span>
                      <span className="font-mono text-[11px]">9</span>
                    </div>
                  </div>
                </div>

                <div className="border-t border-border/70 pt-3 font-mono text-[11px] text-muted-foreground">
                  3 个邮箱监听中
                </div>
              </div>

              {/* Credentials */}
              <div className="space-y-2 bg-background p-5 md:col-span-4">
                <div className="mb-3 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                  Credentials
                </div>
                {[
                  { title: 'GitHub', sub: 'github.a8f2@mail.domain', tag: '2FA', active: true },
                  { title: 'OpenAI Platform', sub: 'sk-proj-••••••••••••', tag: 'API', active: false },
                  { title: 'Prod Bastion', sub: 'ssh-ed25519 · root@prod', tag: 'SSH', active: false },
                ].map((row) => (
                  <div
                    key={row.title}
                    className={`flex items-center justify-between rounded-md border px-3 py-2 text-xs ${
                      row.active
                        ? 'border-foreground/25 bg-muted/50 text-foreground'
                        : 'border-border/70 bg-background text-muted-foreground'
                    }`}
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">{row.title}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground">
                        {row.sub}
                      </div>
                    </div>
                    <span className="shrink-0 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      {row.tag}
                    </span>
                  </div>
                ))}
              </div>

              {/* Detail + Live OTP */}
              <div className="flex flex-col justify-between space-y-3 bg-background p-5 md:col-span-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-border/70 pb-3">
                    <div>
                      <div className="text-sm font-semibold text-foreground">GitHub</div>
                      <div className="font-mono text-[11px] text-muted-foreground">
                        Personal / github.com
                      </div>
                    </div>
                    <span className="rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground">
                      Live OTP
                    </span>
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border bg-muted/35 px-3.5 py-2.5">
                    <div>
                      <div className="font-mono text-[10px] text-muted-foreground uppercase">
                        Email OTP
                      </div>
                      <div className="mt-0.5 font-mono text-xl font-semibold tracking-[0.2em] text-foreground">
                        839204
                      </div>
                    </div>
                    <span className="font-mono text-[11px] text-muted-foreground">X25519 Sealed</span>
                  </div>

                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="font-mono text-[10px] text-muted-foreground">TOTP</div>
                      <div className="mt-0.5 font-mono font-medium text-foreground">482 910</div>
                    </div>
                    <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                      <div className="font-mono text-[10px] text-muted-foreground">REF</div>
                      <div className="mt-0.5 truncate font-mono text-foreground">
                        np://Personal/GitHub
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 6-Cell Hairline Feature Grid */}
          <section id="features" className="border-t border-border/70">
            <div className="px-5 pt-14 md:px-10">
              <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
                Core
              </div>
              <h2 className="mt-2.5 text-2xl font-semibold tracking-tight">核心能力</h2>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-px border-t border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((item) => {
                const Icon = item.icon;
                return (
                  <div key={item.title} className="bg-background p-7 md:p-9">
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

          {/* All-Platform Downloads */}
          <section id="clients" className="border-t border-border/70 px-5 py-16 md:px-10 md:py-24">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
                  Clients
                </div>
                <h2 className="mt-2.5 text-2xl font-semibold tracking-tight">全端下载</h2>
              </div>
              <a
                href={RELEASE_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-3 py-1 font-mono text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>GitHub Release {RELEASE_TAG}</span>
                <ExternalLink className="size-3" />
              </a>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-3">
              {/* macOS */}
              <div className="flex flex-col justify-between bg-background p-6 md:p-7">
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                    <span>MACOS 14+ · ARM64</span>
                    <Laptop className="size-3.5" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">macOS</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    SwiftUI 原生，Touch ID、菜单栏接码与屏幕框选扫码。
                  </p>
                </div>
                <div className="mt-6">
                  <a
                    href={`${RELEASE_DOWNLOAD_BASE}/NonePwd-macos-arm64.zip`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                  >
                    <Download className="size-3.5" />
                    <span>下载 .zip</span>
                  </a>
                </div>
              </div>

              {/* Android */}
              <div className="flex flex-col justify-between bg-background p-6 md:p-7">
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                    <span>ANDROID 8.0+ · AUTOFILL</span>
                    <Smartphone className="size-3.5" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">Android</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    系统级自动填充服务、Keystore 加密缓存与相机扫码。
                  </p>
                </div>
                <div className="mt-6">
                  <a
                    href={`${RELEASE_DOWNLOAD_BASE}/NonePwd-android.apk`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                  >
                    <Download className="size-3.5" />
                    <span>下载 .apk</span>
                  </a>
                </div>
              </div>

              {/* iOS */}
              <div className="flex flex-col justify-between bg-background p-6 md:p-7">
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                    <span>IOS · IPA &amp; SIM</span>
                    <Smartphone className="size-3.5" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">iOS</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    原生端到端同步、实时 TOTP 倒计时与相册/相机扫码。
                  </p>
                </div>
                <div className="mt-6 grid grid-cols-2 gap-2">
                  <a
                    href={`${RELEASE_DOWNLOAD_BASE}/NonePwd-ios-unsigned.ipa`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                  >
                    <Download className="size-3" />
                    <span>未签名 IPA</span>
                  </a>
                  <a
                    href={`${RELEASE_DOWNLOAD_BASE}/NonePwd-ios-sim-arm64.app.zip`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center gap-1 rounded-md border border-border bg-background px-2.5 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                  >
                    <Download className="size-3" />
                    <span>Simulator</span>
                  </a>
                </div>
              </div>

              {/* Browser Extension */}
              <div id="extension" className="flex flex-col justify-between bg-background p-6 md:p-7">
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                    <span>CHROME / ARC / BRAVE · MV3</span>
                    <KeyRound className="size-3.5" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">浏览器扩展</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    内联自动填充、六宫格验证码接力与网页框选 2FA。
                  </p>
                </div>
                <div className="mt-6">
                  <a
                    href="/downloads/nonepwd-extension.zip"
                    download="nonepwd-extension.zip"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted/60"
                  >
                    <Download className="size-3.5" />
                    <span>下载 .zip</span>
                  </a>
                </div>
              </div>

              {/* Native Rust CLI */}
              <div className="flex flex-col justify-between bg-background p-6 md:p-7">
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                    <span>MACOS / LINUX / WIN</span>
                    <Terminal className="size-3.5" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">np CLI</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    零依赖单二进制，兼容 op:// 语法、内存注入与邮件接码。
                  </p>
                </div>
                <div className="mt-6 space-y-2">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-[11px] text-foreground">
                    <span className="truncate">curl -fsSL {origin}/install.sh | bash</span>
                    <CopyButton value={`curl -fsSL ${origin}/install.sh | bash`} variant="minimal" />
                  </div>
                  {phase !== 'standalone' && (
                    <div className="grid grid-cols-2 gap-2">
                      <a
                        href="/downloads/np-darwin-arm64"
                        download="np-darwin-arm64"
                        className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 font-mono text-[11px] text-foreground hover:bg-muted/60"
                      >
                        <Download className="size-3" />
                        <span>macOS</span>
                      </a>
                      <a
                        href="/downloads/np-linux-x86_64"
                        download="np-linux-x86_64"
                        className="inline-flex items-center justify-center gap-1 rounded-md border border-border px-2 py-1.5 font-mono text-[11px] text-foreground hover:bg-muted/60"
                      >
                        <Download className="size-3" />
                        <span>Linux</span>
                      </a>
                    </div>
                  )}
                </div>
              </div>

              {/* Web Vault */}
              <div className="flex flex-col justify-between bg-background p-6 md:p-7">
                <div>
                  <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                    <span>BUILT-IN /VAULT</span>
                    <Globe className="size-3.5" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">Web Vault</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    服务端内置响应式三栏工作台，免安装管理密码库与快照。
                  </p>
                </div>
                <div className="mt-6">
                  <button
                    type="button"
                    onClick={onOpenVault}
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                  >
                    <span>{primaryCtaLabel}</span>
                    <ArrowRight className="size-3.5" />
                  </button>
                </div>
              </div>
            </div>
          </section>

          {/* Developer CLI Showcase */}
          <section id="cli" className="border-t border-border/70 px-5 py-16 md:px-10 md:py-24">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
                  CLI &amp; Agent
                </div>
                <h2 className="mt-2.5 text-2xl font-semibold tracking-tight">
                  兼容 op:// 的原生命令行
                </h2>
              </div>
              <div className="flex items-center gap-2 font-mono text-xs">
                <a
                  href="/llms.txt"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span>/llms.txt</span>
                  <ExternalLink className="size-3" />
                </a>
                <a
                  href="/SKILL.md"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
                >
                  <span>/SKILL.md</span>
                  <ExternalLink className="size-3" />
                </a>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70 lg:grid-cols-12">
              <div className="space-y-2 bg-background p-5 lg:col-span-5">
                {(
                  [
                    ['run', 'np run 零落盘注入'],
                    ['mail', 'np mail otp 等待接码'],
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
                        ? 'border-foreground/30 bg-muted text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                    }`}
                  >
                    <span>{label}</span>
                    <ArrowRight className="size-3.5" />
                  </button>
                ))}
              </div>

              <div className="bg-background p-5 lg:col-span-7">
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
          </section>

          {/* Unified Self-Host Deploy Section */}
          <section id="deploy" className="border-t border-border/70 px-5 py-16 md:px-10 md:py-24">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Deploy
            </div>
            <h2 className="mt-2.5 text-2xl font-semibold tracking-tight">
              两种自建方式，永久 0 订阅费
            </h2>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70 lg:grid-cols-2">
              {/* Local / Docker / VPS */}
              <div className="flex flex-col justify-between bg-background p-6 md:p-8">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                    LOCAL / DOCKER / VPS
                  </div>
                  <h3 className="mt-2.5 text-base font-medium text-foreground">Rust 单二进制</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    单文件内置 SQLite、多账号 IMAP 与 Web Vault，一条命令启动。
                  </p>
                </div>

                <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      127.0.0.1:8787
                    </span>
                    <CopyButton
                      value={`npx @nonepwd/server\n# 或已安装原生 CLI：\nnp server`}
                      label="复制"
                      variant="minimal"
                    />
                  </div>
                  <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-foreground">
{`npx @nonepwd/server
# 或已安装原生 CLI：
np server`}
                  </pre>
                </div>
              </div>

              {/* Cloudflare Serverless */}
              <div id="cloudflare" className="flex flex-col justify-between bg-background p-6 md:p-8">
                <div>
                  <div className="font-mono text-[10px] tracking-[0.08em] text-muted-foreground uppercase">
                    CLOUDFLARE SERVERLESS
                  </div>
                  <h3 className="mt-2.5 text-base font-medium text-foreground">
                    Worker + D1 + R2 自有域名
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    点击按钮自动 Fork 仓库并创建 Worker + D1 + R2，绑定自有域名即用。
                  </p>
                </div>

                <div className="mt-6 space-y-3">
                  <a
                    href="https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-3.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                  >
                    <Cloud className="size-3.5" />
                    <span>一键 Fork 并部署到 Cloudflare</span>
                    <ExternalLink className="size-3" />
                  </a>

                  <div className="rounded-lg border border-border bg-muted/30 p-3.5">
                    <div className="mb-2 flex items-center justify-between">
                      <span className="font-mono text-[11px] text-muted-foreground">
                        Fork / Clone 手动部署
                      </span>
                      <CopyButton
                        value={`pnpm install && pnpm build:cf-server\ncd packages/cf-server && npx wrangler deploy`}
                        label="复制"
                        variant="minimal"
                      />
                    </div>
                    <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-foreground">
{`pnpm install && pnpm build:cf-server
cd packages/cf-server && npx wrangler deploy`}
                    </pre>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Concise Accordion FAQ */}
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

          <div className="flex flex-wrap items-center gap-5 font-mono text-[11px]">
            <button type="button" onClick={onOpenVault} className="hover:text-foreground">
              /vault
            </button>
            <a
              href={RELEASE_URL}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
            >
              releases/{RELEASE_TAG}
            </a>
            <a href="/install.sh" className="hover:text-foreground">
              /install.sh
            </a>
            <a href="/llms.txt" className="hover:text-foreground">
              /llms.txt
            </a>
            <a href="/SKILL.md" className="hover:text-foreground">
              /SKILL.md
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};
