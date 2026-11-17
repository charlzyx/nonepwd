import React, { useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  Cloud,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FolderLock,
  HardDrive,
  KeyRound,
  Layers,
  Lock,
  MailCheck,
  Moon,
  Shield,
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

type CliTab = 'run' | 'mail' | 'sa' | 'connect';

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
    q: '邮箱验证码和自动填充是怎么串起来的？',
    a: '主力邮箱走 IMAP IDLE 长连接，自有域名别名走 Cloudflare Email Routing Worker。服务端解析验证码并密封后通过 WebSocket 秒级推送到已解锁的浏览器扩展和 np CLI；多步登录在第 1 步填完账密后，第 2 步会自动弹出 2FA TOTP 或刚收到的 6 位邮箱码一次填满验证码输入框。',
  },
  {
    q: '浏览器扩展和原生命令行共用一套加密核心吗？',
    a: '完全同源。核心密码学、RFC 6238 TOTP、邮件验证码清洗与 np:// 引用解析全部由 crates/nonepwd-core 用纯 Rust 编写：同一份代码编译为 nonepwd_core.wasm 驱动 Web 与浏览器插件，同时静态链接产出 macOS arm64 / Linux x86_64 原生 np 单二进制。',
  },
  {
    q: '自建支持哪些运行方式？需要重型数据库或按年付费吗？',
    a: '不需要重型依赖，永久 0 订阅费。你可以用纯 Rust 单二进制 np server + 内置 SQLite 在本机或 VPS 一键运行；也可以使用新版 @nonepwd/cf-server 直接部署到 Cloudflare Workers + D1 + R2 + Durable Objects，绑定自有域名并免服务器运维。',
  },
  {
    q: '绑定自有域名部署 Cloudflare Worker + D1 + R2 安全吗？费用如何？',
    a: '零知识边界完全不变：主密码与 VaultKey 仍在你本地浏览器/客户端内存中派生与解密，D1 与 R2 仅存储 AES-256-GCM 密文与 X25519 密封邮件；Worker、D1、R2、Email Routing 与 SQLite-backed Durable Objects 均有个人免费额度，且支持 Web 管理台一键 R2 快照备份与恢复。',
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
  const { phase } = useVault();
  const { isDark, toggleTheme } = useTheme();
  const origin = typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8787';

  const [cliTab, setCliTab] = useState<CliTab>('run');
  const [openFaq, setOpenFaq] = useState<number | null>(0);

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
      ? '私有实例已就绪 · 等待初始化'
      : phase === 'unlocked'
      ? 'Vault 已解锁 · 双密钥零知识保护'
      : '私有实例已就绪 · 双密钥零知识保护';

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
                核心能力
              </a>
              <a href="#cli" className="transition-colors hover:text-foreground">
                命令行
              </a>
              <a href="#cloudflare" className="transition-colors hover:text-foreground">
                Cloudflare 部署
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

            <p className="mt-5 max-w-[42rem] text-[17px] leading-relaxed text-pretty text-muted-foreground">
              双密钥零知识加密（<code className="font-mono text-[15px] text-foreground">NP3-...</code>）、Rust 单二进制服务端{' '}
              <code className="font-mono text-[15px] text-foreground">np server</code>、自有域名{' '}
              <code className="font-mono text-[15px] text-foreground">Cloudflare Worker + D1 + R2</code> Serverless 部署、macOS 原生 SwiftUI 客户端（菜单栏 2FA / 邮箱码 · Touch ID · AI 提取）与 MV3 自动填充扩展 — 完全掌握在你自己手中。
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
                <span>np server</span>
                <CopyButton value="np server" variant="minimal" />
              </div>
            </div>

            <div className="mt-16">
              <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
                Built on one pure-Rust core across every surface
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-7 gap-y-2.5 font-mono text-xs text-muted-foreground">
                <span>Rust + WASM + C ABI</span>
                <span>CF Worker + D1 + R2</span>
                <span>np server (SQLite)</span>
                <span>macOS Native (SwiftUI)</span>
                <span>AES-256-GCM</span>
                <span>X25519 Sealed Box</span>
                <span>Chrome / Brave MV3</span>
                <span>IMAP + Email Routing</span>
              </div>
            </div>
          </section>

          {/* Flush Architectural Product Preview Window */}
          <section className="border-t border-border/70">
            <div className="flex items-center justify-between border-b border-border/70 bg-muted/35 px-5 py-2.5 md:px-10">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-1.5" aria-hidden="true">
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                  <span className="size-2.5 rounded-full bg-foreground/15" />
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  nonepwd — 127.0.0.1:8787/vault
                </span>
              </div>
              <span className="font-mono text-[11px] text-muted-foreground">
                WebSocket Live · AES-256-GCM
              </span>
            </div>

            <div className="grid grid-cols-1 gap-px bg-border/70 md:grid-cols-12">
              {/* Column 1: Vaults Sidebar */}
              <div className="space-y-4 bg-card/60 p-5 md:col-span-3">
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

                <div className="border-t border-border/70 pt-3 font-mono text-[11px] text-muted-foreground">
                  IMAP IDLE: listening
                </div>
              </div>

              {/* Column 2: Items */}
              <div className="space-y-2 bg-background p-5 md:col-span-4">
                <div className="mb-3 font-mono text-[10px] tracking-[0.12em] text-muted-foreground uppercase">
                  Credentials
                </div>
                {[
                  { title: 'GitHub', sub: 'github.a8f2@mail.domain', tag: '2FA · OTP', active: true },
                  { title: '招商银行 Visa', sub: '•••• 4242 · 08/28', tag: '银行卡', active: false },
                  { title: 'OpenAI Platform', sub: 'sk-proj-••••••••••••', tag: 'np://', active: false },
                ].map((row) => (
                  <div
                    key={row.title}
                    className={`flex items-center justify-between rounded-md border px-3 py-2.5 text-xs ${
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

              {/* Column 3: Item Detail + Live OTP */}
              <div className="space-y-3 bg-background p-5 md:col-span-5">
                <div className="flex items-center justify-between border-b border-border/70 pb-3">
                  <div>
                    <div className="text-sm font-semibold text-foreground">GitHub</div>
                    <div className="font-mono text-[11px] text-muted-foreground">
                      Personal / github.com
                    </div>
                  </div>
                  <span className="rounded border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground">
                    已实时关联邮件码
                  </span>
                </div>

                <div className="flex items-center justify-between rounded-md border border-border bg-muted/35 px-3.5 py-2.5">
                  <div>
                    <div className="font-mono text-[10px] text-muted-foreground uppercase">
                      X25519 Sealed Email OTP
                    </div>
                    <div className="mt-0.5 font-mono text-xl font-semibold tracking-[0.2em] text-foreground">
                      839204
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-muted-foreground">WebSocket 推送</span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                    <div className="font-mono text-[10px] text-muted-foreground">2FA TOTP</div>
                    <div className="mt-0.5 font-mono font-medium text-foreground">482 910</div>
                  </div>
                  <div className="rounded-md border border-border bg-muted/20 px-3 py-2">
                    <div className="font-mono text-[10px] text-muted-foreground">SECRET REF</div>
                    <div className="mt-0.5 truncate font-mono text-foreground">
                      np://Personal/GitHub
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* 6-Cell Hairline Feature Grid (Waku Style) */}
          <section id="features" className="border-t border-border/70">
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
                  title: '邮箱验证码提取 & 正则过滤',
                  desc: '支持 IMAP IDLE 与 Cloudflare Email Routing；内置 Allow/Deny 多字段正则过滤与仅保留验证码模式，X25519 密封后经 WebSocket 秒级推送。',
                },
                {
                  icon: Zap,
                  title: '账密、银行卡、地址与 2FA 填充',
                  desc: 'MV3 扩展通过闭合 Shadow DOM 自动填充账密、2FA、银行卡与地址身份（CVV 仅点击时填充）；支持浏览器 CSV 与 2FA 验证器导出导入。',
                },
                {
                  icon: Terminal,
                  title: 'macOS 原生客户端 & np CLI',
                  desc: '原生 SwiftUI macOS 桌面应用（Liquid Glass 视觉、菜单栏 2FA/邮箱码 Cron + AI 提取、Touch ID 与可配置免密时长），配合 np run 零落盘注入与 Service Account 隔离。',
                },
                {
                  icon: Shield,
                  title: '无限域名邮箱别名',
                  desc: '注册页聚焦输入框一键为当前站点派生专属 Masked Email 与 20 位强密码，并支持按别名一键拒收骚扰邮件。',
                },
                {
                  icon: Layers,
                  title: '单二进制或 Cloudflare Serverless',
                  desc: '既可用纯 Rust 单二进制 np server + SQLite 在本机或 VPS 运行，也可部署为 Cloudflare Worker + D1 + R2 + Durable Objects 绑定自有域名，永久 0 订阅费。',
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

          {/* Developer CLI Showcase */}
          <section id="cli" className="border-t border-border/70 px-5 py-16 md:px-10 md:py-20">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Developer Workflow
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">原生 Rust `np` 命令行</h2>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70 lg:grid-cols-12">
              <div className="space-y-2 bg-background p-5 lg:col-span-5">
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

          {/* Cloudflare Workers + D1 + R2 Serverless Edition */}
          <section id="cloudflare" className="border-t border-border/70 px-5 py-16 md:px-10 md:py-20">
            <div className="font-mono text-[11px] tracking-[0.14em] text-muted-foreground/80 uppercase">
              Cloudflare Serverless
            </div>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight">
              自有域名一键上云：Worker + D1 + R2
            </h2>
            <p className="mt-3 max-w-3xl text-sm leading-relaxed text-muted-foreground">
              无需购买 VPS 或配置反向代理与 TLS 证书。将你的域名绑定到{' '}
              <code className="font-mono text-foreground">@nonepwd/cf-server</code>
              ，静态 Web Vault、零知识接口、D1 结构化存储、R2 定时加密快照与域名 Catch-All 邮件收信全部运行在同一个 Cloudflare 域名下，macOS 桌面端、浏览器插件与{' '}
              <code className="font-mono text-foreground">np</code> CLI 协议 100% 互通。
            </p>

            <div className="mt-8 grid grid-cols-1 gap-px border border-border/70 bg-border/70 sm:grid-cols-2 lg:grid-cols-4">
              {[
                {
                  icon: Cloud,
                  tag: 'EDGE API + SPA',
                  title: 'Worker + 同域托管',
                  desc: '基于 Hono + 预编译 Rust WASM 托管全部 API 与 Web Vault（custom_domain 直绑 vault.yourdomain.com）。',
                },
                {
                  icon: Database,
                  tag: 'SQLITE AT EDGE',
                  title: 'D1 零知识结构化库',
                  desc: '存储加密 Vault/Item、会话凭证、Service Account 授权、域名别名与邮件过滤规则，服务端永不接触明文。',
                },
                {
                  icon: HardDrive,
                  tag: 'SNAPSHOTS + ARCHIVE',
                  title: 'R2 定时快照与邮件归档',
                  desc: '每封密封邮件同步归档至 R2（emails/<id>.json），Cron 每 6 小时生成零知识快照并在设置页一键恢复。',
                },
                {
                  icon: MailCheck,
                  tag: 'DIRECT EMAIL + DO WS',
                  title: 'Email Routing 实时推送',
                  desc: '*@yourdomain.com 邮件直达 Worker email() 边缘提取 X25519 密封，由 Durable Objects WebSocket 秒级推送。',
                },
              ].map((card) => {
                const CardIcon = card.icon;
                return (
                  <div key={card.title} className="bg-background p-5">
                    <div className="flex items-center justify-between font-mono text-[10px] tracking-[0.08em] text-muted-foreground">
                      <span>{card.tag}</span>
                      <CardIcon className="size-3.5" />
                    </div>
                    <h3 className="mt-3 text-sm font-medium text-foreground">{card.title}</h3>
                    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                      {card.desc}
                    </p>
                  </div>
                );
              })}
            </div>

            <div className="mt-6 rounded-lg border border-border bg-muted/30 p-4">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2.5">
                  <a
                    href="https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/85"
                  >
                    <Cloud className="size-3.5" />
                    <span>一键部署到 Cloudflare</span>
                    <ExternalLink className="size-3" />
                  </a>
                  <span className="font-mono text-xs text-muted-foreground">
                    或手动 CLI 部署 packages/cf-server
                  </span>
                </div>
                <CopyButton
                  value={`pnpm run build:rust && pnpm run build:cf-server
cd packages/cf-server
npx wrangler d1 create nonepwd-db
npx wrangler r2 bucket create nonepwd-vault-blobs
# 将 database_id 与 custom_domain 填入 wrangler.jsonc 后执行：
pnpm run db:migrate:remote && pnpm run deploy`}
                  label="复制部署命令"
                  variant="minimal"
                />
              </div>
              <pre className="overflow-x-auto font-mono text-xs leading-relaxed text-foreground">
{`pnpm run build:rust && pnpm run build:cf-server
cd packages/cf-server
npx wrangler d1 create nonepwd-db
npx wrangler r2 bucket create nonepwd-vault-blobs
# 将 database_id 与 custom_domain 填入 wrangler.jsonc 后执行：
pnpm run db:migrate:remote && pnpm run deploy`}
              </pre>
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
                  <h3 className="mt-3 text-sm font-medium text-foreground">
                    启动服务端（np server 或 CF Worker）
                  </h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    本机执行 <code className="text-foreground">np server</code> 启动内置 SQLite 的单二进制服务端；自有域名免服务器部署可使用上方 <code className="text-foreground">@nonepwd/cf-server</code>（Worker + D1 + R2）。
                  </p>
                </div>

                <div className="mt-5 space-y-2.5">
                  <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 font-mono text-xs text-foreground">
                    <span className="truncate">np server</span>
                    <CopyButton value="np server" variant="minimal" />
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

              {/* 02 Desktop & Browser Extension */}
              <div id="extension" className="flex flex-col justify-between bg-background p-6">
                <div>
                  <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>02 / DESKTOP &amp; EXTENSION</span>
                    <KeyRound className="size-4" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">macOS 原生客户端 &amp; MV3 插件</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    基于 SwiftUI 打造的原生 macOS 桌面端（菜单栏 2FA / 邮箱码、Touch ID、AI 提取），搭配 Chrome / Brave / Arc MV3 插件自动填充。
                  </p>
                </div>

                <div className="mt-5">
                  <a
                    href="/downloads/nonepwd-extension.zip"
                    download="nonepwd-extension.zip"
                    className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 py-2 text-xs font-medium text-foreground hover:bg-muted/60"
                  >
                    <Download className="size-3.5" />
                    <span>下载 nonepwd-extension.zip</span>
                  </a>
                </div>
              </div>

              {/* 03 Native CLI */}
              <div className="flex flex-col justify-between bg-background p-6">
                <div>
                  <div className="flex items-center justify-between font-mono text-xs text-muted-foreground">
                    <span>03 / CLI</span>
                    <Terminal className="size-4" />
                  </div>
                  <h3 className="mt-3 text-sm font-medium text-foreground">安装原生 np 单二进制</h3>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    集成 <code className="text-foreground">np server</code>、CSV/2FA 导入、环境变量注入与实时接收邮件验证码。
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
            <a href="/install.sh" className="hover:text-foreground">
              /install.sh
            </a>
          </div>
        </footer>
      </div>
    </div>
  );
};
