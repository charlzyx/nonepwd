# nonepwd — 私有化自建零知识密码管理器（Rust 核心 + WASM + 多端原生客户端 + 浏览器 MV3 插件）

**nonepwd** 是一个专为**单用户私有化自建**打造的全栈零知识密码管理器：
- **核心引擎由纯 Rust (`crates/nonepwd-core`) 编写**：同时编译为 **WASM（供 Node/CF Server / React Web / Chrome 插件共用）**、**C ABI 原生动态库 (`libnonepwd_core.dylib`，供 macOS SwiftUI 原生客户端调用)** 与 **原生无依赖二进制 CLI（macOS / Linux musl / Windows）**，一套加密与验证码提取逻辑全端一致；
- **通用多账号邮箱验证码 (`imap_accounts`)**：同时监听多个 Gmail、QQ、163/126、iCloud、Outlook 及自定义 IMAP 邮箱，支持按收件邮箱过滤与 WebSocket 实时推送；
- **全端 2FA 二维码导入 + 动态码（TOTP）**：支持 `otpauth://`、`otpauth-migration://` 与原始 Base32 密钥，覆盖 macOS 桌面端、Web Vault、Chrome 扩展与 NSH 移动/桌面客户端；
- **多端原生客户端矩阵**：macOS 原生 SwiftUI `NonePwd.app`、NSH 跨平台客户端（Android `.apk` / iOS `.ipa` & Simulator `.app` / Windows `.zip`）、Chrome MV3 自动填充插件与原生 `np` CLI。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server)

> 点击上方按钮可将 `@nonepwd/cf-server`（Worker + D1 + R2 + Durable Objects）一键部署到你自己的 Cloudflare 账号；部署后绑定自定义域名与 Email Routing Catch-All 即可使用。

---

## 核心特性

1. **双密钥零知识架构（Rust 核心实现）**
   - `Master Password` + `Secret Key (NP3-XXXXXX-...)` 经 **PBKDF2-HMAC-SHA256 (600,000 次)** 本地派生，服务端绝不接触主密码或明文 Vault 密钥。
   - **Per-Vault 独立对称密钥 + AAD 绑定**：每个密码库（如 `Personal`、`DevOps`）拥有独立的 `AES-256-GCM` 密钥，支持向 CI/自动化工具签发仅解密指定库的 `Service Account Token (npst_v1_...)`。
   - **邮件零知识密封盒（X25519 + HKDF + AES-GCM）**：无论来自 IMAP 还是 Cloudflare Worker，提取验证码后立刻用你的 `X25519` 公钥加密存储并通过 WebSocket 实时推送到各客户端内存解密。

2. **通用多账号 IMAP (`imap_accounts`) + Cloudflare Email 别名**
   - **通道 A：多账号 IMAP IDLE 长连接 (`imap_accounts`)**
     - 支持同时添加与启用多个 **Gmail**（`imap.gmail.com`）、**QQ 邮箱**（`imap.qq.com`）、**163 / 126 邮箱**（`imap.163.com` / `imap.126.com`，内置 NetEase RFC 2971 `ID` 握手）、**iCloud**（`imap.mail.me.com`）、**Outlook**（`outlook.office365.com`）及任意自定义企业 IMAP 服务器（支持自定义标签、端口与 TLS）。
     - 每个账号独立维护连接状态（`listening` / `connecting` / `error` / `disabled`）、同步游标 (`last_uid`) 与密码密文，兼容旧版单账号 `imap_config` 自动迁移，并在收件流视图支持**按收件邮箱筛选（Per-Mailbox Filtering）**。
     - 高精度提取中英文验证码与 Magic Link（自动过滤 CSS 颜色、年份、金额、订单号），并可叠加全局正则过滤规则（Allow/Block + `otpOnly`）。
   - **通道 B：Cloudflare Email Routing Worker**
     - 绑定自有域名无限生成随机别名（如 `cursor.k9x2m@mail.yourdomain.com`），支持**标准 HMAC 转发模式**与**边缘直接 X25519 零知识加密模式**，并支持对已泄露别名一键屏蔽拒收。

3. **全端 2FA 二维码导入（`otpauth://` / `otpauth-migration://`）**
   - **macOS 原生桌面端 (`apps/desktop`)**：支持 `⌘V` 粘贴剪贴板图片、**屏幕区域框选截图识别（Screen Region-Snip）** 以及文件选择/拖拽图片导入（结合 Apple `Vision`、`CoreImage` 与纯 Swift CPU QR 解码器）。
   - **Web Vault (`packages/web`)**：支持 `⌘V` 剪贴板图片粘贴、图片文件上传/拖拽，以及基于浏览器 `BarcodeDetector` + `getUserMedia` 的**实时摄像头扫码**（同时覆盖单条目编辑与批量 2FA 导入向导）。
   - **Chrome / MV3 浏览器扩展 (`packages/extension`)**：支持在任意网页内直接唤起**拖拽框选区域截图（Closed Shadow DOM 浮层 + `captureVisibleTab` 裁剪识别）**，以及在扩展弹窗内粘贴剪贴板截图 / 上传本地二维码图片一键导入。
   - **NSH 跨平台客户端 (`apps/nsh`)**：支持移动与桌面场景下的相机扫码、相册/图片选取及剪贴板识别导入（离线本地解码与加密落库）。

4. **Manifest V3 浏览器自动填充扩展（Chrome / Arc / Edge / Brave）**
   - 构建产物同时生成解压目录 [`packages/extension/dist`](./packages/extension/dist) 与可直接下载的压缩包 [`dist/bin/nonepwd-extension.zip`](./dist/bin/nonepwd-extension.zip)。
   - 闭合 `Shadow DOM` 内联浮窗（`data-nonepwd-overlay`），完全隔离宿主网页样式，支持 `↑` `↓` `Enter` 键盘选择。
   - **多步登录状态接力**：第 1 页填充账号密码后，第 2 页自动突出展示对应条目的 TOTP 或刚推送到达的邮箱验证码，**原生支持六宫格 `<input maxlength="1">` 验证码自动填入**。
   - **注册页强密码 + 独立域名别名**：聚焦 `new-password` 输入框可一键生成 20 位强密码与专属域名别名并加密落库。

5. **原生跨平台 `np` CLI（macOS / Linux / Windows 单二进制）**
   - 零 Node / 零 OpenSSL 动态库依赖：macOS 原生 `Mach-O`（`arm64` / `x86_64`）、Linux `musl` 100% 静态链接 ELF（`x86_64` / `arm64`）与 Windows 原生 `np-windows-x64.exe`。
   - 完整支持 `XDG_CONFIG_HOME` / `~/.config/nonepwd` 与 `0700`/`0600` 原子文件权限保护。
   - `np://<vault>/<item>/<field>` 统一密钥寻址（支持 `totp` 与 `email_otp?wait=30`）、`np run --env-file=.env.tpl -- <cmd>` 内存注入、`np mail otp --wait` 实时 WS 等待与 `np serve --connect` 本地 REST 网关。

---

## 多端客户端与分发矩阵

| 平台 / 载体 | 技术栈与目录 | 发行产物 | 核心能力与说明 |
| :--- | :--- | :--- | :--- |
| **macOS Desktop** | SwiftUI + `libnonepwd_core.dylib` (`apps/desktop`) | `NonePwd-macos-arm64.zip` (`NonePwd.app`) | Touch ID 解锁、菜单栏快速访问、多账号 IMAP 配置、`⌘V`/框选屏幕/拖拽二维码导入、内嵌扩展包 |
| **Android** | NSH TSX/QuickJS (`apps/nsh`) | `NonePwd-android.apk` | 零知识加密同步（PBKDF2/HKDF/AES-GCM/X25519）、多邮箱 OTP 收件、2FA 相机/相册/剪贴板导入 |
| **iOS** | NSH TSX/QuickJS (`apps/nsh`) | `NonePwd-ios-unsigned.ipa` / `NonePwd-ios-sim-arm64.app.zip` | 提供未签名 `.ipa`（适用于 sideload / PiperPlay）及 arm64 Simulator `.app` 包 |
| **Windows** | NSH (`apps/nsh`) + Rust CLI (`crates/nonepwd-cli`) | `NonePwd-windows-x64.zip` + `np-windows-x64.exe` | 原生 Windows 应用包与独立 `np.exe` 命令行工具 |
| **Linux** | Rust 静态链接 CLI (`crates/nonepwd-cli`) + Docker | `np-linux-x86_64` / `np-linux-arm64` | Linux 以无依赖静态 CLI `np` 与容器化服务端部署为主（不单独构建桌面 GUI） |
| **Web Vault & Extension** | React 19 + TailwindCSS v4 + MV3 (`packages/web`, `packages/extension`) | 服务端内置 `/vault` + `nonepwd-extension.zip` | 网页三栏管理台（摄像头/粘贴/文件扫码）+ 浏览器自动填充与网页框选 2FA 二维码 |

---

## 仓库结构

```text
nonepwd/
├── crates/
│   ├── nonepwd-core/          # 纯 Rust 核心库（Native dylib/rlib + wasm32-unknown-unknown cdylib）
│   ├── nonepwd-cli/           # 原生独立 `np` CLI（macOS / Linux musl / Windows）
│   └── nonepwd-server/        # Rust Axum + SQLite + 多账号 IMAP IDLE + WebSocket 服务端
├── apps/
│   ├── desktop/               # macOS 原生 SwiftUI 客户端 (`NonePwd.app`，链接 libnonepwd_core.dylib)
│   └── nsh/                   # NSH 跨平台客户端（打包 Android APK / iOS IPA & Simulator / Windows）
├── packages/
│   ├── core/                  # @nonepwd/core：封装 Rust WASM 引擎（含 Cloudflare Worker 无内联入口）
│   ├── server/                # @nonepwd/server：Hono + Node 26 内置 SQLite + WebSocket + IMAP + Webhook
│   ├── cf-server/             # @nonepwd/cf-server：Cloudflare Worker + D1 + R2 + Durable Objects 全栈服务端
│   ├── cf-email-worker/       # Cloudflare Email Routing Worker（独立转发外部服务端用，含 wrangler.toml）
│   ├── cli/                   # @nonepwd/cli：Node 包装与 E2E 测试
│   ├── web/                   # React 19 + TailwindCSS v4 官网 & 三栏式 Web Vault
│   └── extension/             # Chrome / Arc / Edge Manifest V3 自动填充与框选扫码扩展
├── scripts/
│   ├── build-rust.mjs         # 构建 Rust WASM、libnonepwd_core 动态库与各平台 `np` CLI
│   ├── build-cf-site.mjs      # 构建 Cloudflare Pages 静态展示站
│   └── install-cli.sh         # macOS / Linux 一键安装 `np` 到 ~/.local/bin
└── .github/workflows/
    ├── ci.yml                 # PR / main 持续集成（Rust 单测 + pnpm 构建/类型检查/测试 + NSH 检查）
    ├── clients.yml            # 多端客户端独立构建工作流（Android / iOS / macOS / Windows）
    └── release.yml            # v* 标签全平台发布（多端应用 + CLI + npm + GHCR + SHA256SUMS.txt）
```

---

## 快速启动

### 方式零：通过 npm 一键安装启动（推荐）

> 环境要求：Node.js >= 22.13 / 26

```bash
# 直接通过 npx 启动自建零知识服务端（内置 Web Vault 官网与浏览器插件包下载，默认端口 8787）
NONEPWD_DATA_DIR=./data npx @nonepwd/server

# 或全局安装客户端 CLI 与服务端
npm install -g @nonepwd/cli @nonepwd/server
nonepwd-server
np version
```

### 方式一：本地全量源码构建与运行

> 环境要求：Rust (`rustc` / `cargo`，需 `wasm32-unknown-unknown`；macOS 上交叉编译 Linux 可选 `x86_64-unknown-linux-musl`) + Node.js >= 24/26 + `pnpm`。

```bash
# 1. 安装 JS 依赖并全量构建（自动构建 Rust WASM + native dylib + np + 前端 + 服务端 + 浏览器插件包）
pnpm install
pnpm build

# 2. 启动 nonepwd 自建服务端（默认端口 8787，数据持久化在 ./data/nonepwd.db）
pnpm --filter @nonepwd/server start
```

打开浏览器访问：
- **nonepwd 官网、插件下载与 WASM 实时实验室**：`http://127.0.0.1:8787/`
- **Web Vault 管理台**：`http://127.0.0.1:8787/vault`（首次打开会进入双密钥初始化向导，请务必下载 Emergency Kit `.json`）
- **多步登录 & 六宫格自动填充沙盒**：`http://127.0.0.1:8787/demo-login`

### 方式二：构建与运行 macOS 原生客户端（`apps/desktop`）

```bash
# 1. 构建 libnonepwd_core.dylib、@nonepwd/core 与浏览器扩展（供内置分发）
pnpm build:rust
pnpm --filter @nonepwd/core build
pnpm --filter @nonepwd/extension build

# 2. 运行 Swift 核心单元测试并打包签名 apps/desktop/dist/NonePwd.app
./apps/desktop/scripts/test.sh
./apps/desktop/scripts/build-app.sh
open apps/desktop/dist/NonePwd.app
```

### 方式三：NSH 跨平台客户端构建与 PiperPlay 本地安装（`apps/nsh`）

> 安装 NSH CLI：macOS 可通过 `brew install longbridge/tap/nsh`；Linux 使用 `curl -fsSL https://nsh.dev/install.sh | sh`；Windows 使用 `irm https://nsh.dev/install.ps1 | iex`。Android 打包需安装 JDK 17 与 Android SDK（`platforms;android-35`、`build-tools;35.0.0`）。

```bash
# 1. 类型检查与无头测试
cd apps/nsh
nsh check
nsh test

# 2. 按目标平台打包
# Android APK
nsh package --target android -o dist-android .
# 输出: dist-android/NonePwd.apk

# iOS 真机未签名 .app（可封装为 Payload/NonePwd.app -> NonePwd-ios-unsigned.ipa）
nsh component add ios
nsh package --target ios -o dist-ios .
mkdir -p ipa-stage/Payload && cp -R dist-ios/NonePwd.app ipa-stage/Payload/
(cd ipa-stage && zip -qry ../NonePwd-ios-unsigned.ipa Payload)

# iOS Simulator .app（ad-hoc 签名，arm64）
nsh package --target ios-simulator -o dist-ios-sim .

# Windows（在 Windows x64 环境运行）
nsh package --target windows -o dist-win .
```

**PiperPlay 本地安装调试（macOS）**：
- 若本机已安装 [PiperPlay](/Applications/PiperPlay.app)（含 Simulator / 真机设备桥接）：
  - **Android**：将 `NonePwd-android.apk` 直接拖入 PiperPlay 或通过 PiperPlay 设备管理面板安装启动，无需在宿主机手动执行 `adb`。
  - **iOS Simulator / 设备**：将 `dist-ios-sim/NonePwd.app`（或解压后的 `NonePwd-ios-sim-arm64.app.zip`）导入 PiperPlay Simulator；若需真机 sideload，可使用 `NonePwd-ios-unsigned.ipa` 配合个人证书重签安装。

### 方式四：安装与使用浏览器插件（Chrome / Edge / Arc）

1. 确保已执行 `pnpm build`（产物位于 `packages/extension/dist`，同时官网提供 `http://127.0.0.1:8787/downloads/nonepwd-extension.zip` 下载后解压）。
2. 打开 `chrome://extensions/`（或 Edge/Arc 扩展页），开启右上角 **开发者模式（Developer mode）**。
3. 点击 **加载已解压的扩展程序（Load unpacked）**，选择解压后的插件目录或本仓库构建目录：
   ```text
   packages/extension/dist
   ```
4. 点击扩展图标填入服务端地址、Secret Key（`NP3-...`）与主密码解锁后，可在弹窗菜单使用「**框选网页二维码 / 粘贴截图 / 选图识别 2FA**」直接抓取网页上的 2FA 二维码，或访问 `http://127.0.0.1:8787/demo-login` 测试账号填充与第 2 步 6 宫格 TOTP / 实时邮箱验证码接力填充。

### 方式五：安装与使用原生 `np` CLI（macOS / Linux / Windows）

```bash
# macOS / Linux 一键安装适配当前系统架构的原生二进制到 ~/.local/bin/np
./scripts/install-cli.sh

# 也可直接分发静态产物：
# - macOS (Apple Silicon / Intel): np-darwin-arm64 / np-darwin-x86_64
# - Linux (静态链接): np-linux-x86_64 / np-linux-arm64
# - Windows (x64): np-windows-x64.exe

np version
```

常用命令：

```bash
# 初始化或登录已有 Vault
np setup --server http://127.0.0.1:8787 --email you@example.com --password "YourMasterPassword" --alias-domain mail.yourdomain.com
np signin --server http://127.0.0.1:8787 --secret-key "NP3-..." --password "YourMasterPassword"

# 创建条目、读取字段与动态 2FA
np item create --vault DevOps --title OpenAI --category api_credential --field api_key=sk-xxx
np item create --vault Personal --title GitHub --url https://github.com/login --username alice --generate --totp JBSWY3DPEHPK3PXP --auto-alias
np read "np://DevOps/OpenAI/api_key"
np otp "GitHub" --vault Personal

# 环境变量零落盘注入运行
np run --env-file .env.tpl -- node -e "console.log(process.env.OPENAI_API_KEY)"

# 渲染配置模板
np inject -i config.tpl.yaml -o config.yaml

# 阻塞等待新邮件验证码（纯 Rust TLS + WebSocket 实时接收并本地 X25519 解密）
np mail otp --domain github.com --wait 30s

# 签发仅能访问 DevOps 库的 Service Account 令牌
np service-account create ci-agent --vault DevOps
export NONEPWD_TOKEN="npst_v1_..."

# 启动本地 Connect HTTP API
np serve --connect --port 8788 --token my-connect-secret
curl -H "Authorization: Bearer my-connect-secret" "http://127.0.0.1:8788/v1/resolve?ref=np://DevOps/OpenAI/api_key"
```

### 方式六：Docker Compose 一键私有化部署

```bash
docker compose up -d --build
```

容器镜像内同时运行自建服务端，并将 Linux 原生 `np` 二进制内置在 `/usr/local/bin/np`。

### 方式七：Cloudflare Worker + D1 + R2 自有域名无服务器部署（`@nonepwd/cf-server`）

适合拥有自己域名的场景：将静态官网与 Web Vault、`/api/*` 零知识接口、**D1 数据库**、**R2 加密快照与邮件归档**、**Durable Objects (WebSocket Hibernation)** 与 **Cloudflare Email Routing Catch-All** 全部运行在自有域名（如 `https://vault.yourdomain.com`）上：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server)

> 点击按钮即可自动克隆并创建 Worker + D1 + R2 + Durable Objects；部署完成后在 Cloudflare Dashboard 绑定自定义域名与 Email Routing Catch-All 即可。如需手动 CLI 部署：

```bash
# 1. 构建 Rust WASM 与 Cloudflare 全栈产物
pnpm run build:rust
pnpm run build:cf-server

# 2. 创建 D1 与 R2，并执行远端建表
cd packages/cf-server
npx wrangler login
npx wrangler d1 create nonepwd-db          # 把输出的 database_id 填入 wrangler.jsonc
npx wrangler r2 bucket create nonepwd-vault-blobs
pnpm run db:migrate:remote

# 3. 绑定 custom_domain 后发布
pnpm run deploy
```

然后在 Cloudflare Dashboard → **Email → Email Routing → Catch-all address** 直接选择发送到 Worker **`nonepwd-cf-server`**，自有域名别名邮件就会在边缘提取验证码并按你的 X25519 公钥密封存库及推送（macOS 桌面端、MV3 插件、NSH 客户端、`np` CLI 均直连该域名即可）。

---

## 接入 Cloudflare Email Routing Worker

1. 在 nonepwd Web 管理台 → **IMAP / Cloudflare 配置** 复制你的 `WEBHOOK_SECRET`（及可选的 `RECIPIENT_X25519_PUBLIC_KEY`）。
2. 编辑 `packages/cf-email-worker/wrangler.toml` 中的 `NONEPWD_SERVER_URL`。
3. 部署 Worker 并绑定 Catch-All 路由：
   ```bash
   cd packages/cf-email-worker
   npx wrangler deploy
   npx wrangler secret put WEBHOOK_SECRET
   ```
4. 在 Cloudflare Dashboard → **Email → Email Routing → Catch-all address** 选择发送到 **`nonepwd-email-router`**。

---

## GitHub Actions CI/CD 与发布工作流

- **`.github/workflows/ci.yml` (`CI`)**：在 `push` (`main`) 与 `pull_request` 时并行执行 Rust + Node/pnpm 全量构建测试（`cargo test --workspace`、`pnpm build`、`pnpm -r typecheck`、`pnpm test`）以及 NSH 客户端静态检查与测试（`nsh check`、`nsh test`）。
- **`.github/workflows/clients.yml` (`Clients`)**：支持手动 `workflow_dispatch`，以及推送到 `main` 且修改 `apps/**`、`crates/**`、`packages/extension/**` 或自身时自动构建并上传全部客户端 Artifacts：
  - `NonePwd-android.apk`（`ubuntu-latest` + Java 17 + Android SDK 35 + NSH）
  - `NonePwd-ios-unsigned.ipa` & `NonePwd-ios-sim-arm64.app.zip`（`macos-latest` + NSH）
  - `NonePwd-macos-arm64.zip`（`macos-latest` + SwiftUI + `libnonepwd_core.dylib`）
  - `np-windows-x64.exe` & `NonePwd-windows-x64.zip`（`windows-latest` + Rust CLI + NSH）
- **`.github/workflows/release.yml` (`Release`)**：在推送 `v*` 标签或手动触发时并行运行 `build-macos`、`build-android`、`build-windows`、`build-linux-and-extension`、`docker-ghcr` 与 `publish-npm`，最终汇总全部产物并生成 `SHA256SUMS.txt` 发布到 GitHub Releases。

---

## 运行全量测试

```bash
cargo test --workspace
pnpm -r typecheck
pnpm build
pnpm test
(cd apps/nsh && nsh check && nsh test)
./apps/desktop/scripts/test.sh
```
