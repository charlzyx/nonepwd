# nonepwd — 私有化自建零知识密码管理器（Rust 核心 + WASM + 浏览器 MV3 插件 + 原生跨平台 CLI）

**nonepwd** 是一个专为**单用户私有化自建**打造的全栈零知识密码管理器：
- **核心引擎由纯 Rust (`crates/nonepwd-core`) 编写**：同时编译为 **WASM（供 Server / React Web / Chrome 插件 / Cloudflare Worker 共用）** 与 **原生无依赖二进制 CLI（macOS & Linux 静态链接）**，一套加密与验证码提取逻辑全端一致；
- **邮箱验证码（IMAP IDLE + Cloudflare Email Worker）实时提取与推送**；
- **2FA 动态码（TOTP）+ 闭合 Shadow DOM 浏览器自动填充扩展（含六宫格接力）**；
- **原生命令行 `np` + Service Account 分库隔离 + 本地 Connect HTTP API**。

---

## 核心特性

1. **双密钥零知识架构（Rust 核心实现）**
   - `Master Password` + `Secret Key (NP3-XXXXXX-...)` 经 **PBKDF2-HMAC-SHA256 (600,000 次)** 本地派生，服务端绝不接触主密码或明文 Vault 密钥。
   - **Per-Vault 独立对称密钥 + AAD 绑定**：每个密码库（如 `Personal`、`DevOps`）拥有独立的 `AES-256-GCM` 密钥，支持向 CI/自动化工具签发仅解密指定库的 `Service Account Token (npst_v1_...)`。
   - **邮件零知识密封盒（X25519 + HKDF + AES-GCM）**：无论来自 IMAP 还是 Cloudflare Worker，提取验证码后立刻用你的 `X25519` 公钥加密存储并通过 WebSocket 实时推送到浏览器/CLI 内存解密。

2. **双通道邮箱验证码 + 域名别名防骚扰**
   - **通道 A：IMAP IDLE 长连接** — 接入主流 IMAP 邮箱，毫秒级监听新邮件并高精度提取中英文验证码与 Magic Link（自动过滤 CSS 颜色、年份、金额、订单号）。
   - **通道 B：Cloudflare Email Routing Worker** — 绑定自有域名无限生成随机别名（如 `cursor.k9x2m@mail.yourdomain.com`），支持**标准 HMAC 转发模式**与**边缘直接 X25519 零知识加密模式**，并支持对已泄露别名一键屏蔽拒收。

3. **Manifest V3 浏览器自动填充扩展（Chrome / Arc / Edge / Brave）**
   - 构建产物同时生成解压目录 [`packages/extension/dist`](./packages/extension/dist) 与可直接通过官网 `/downloads/nonepwd-extension.zip` 下载的压缩包 [`dist/bin/nonepwd-extension.zip`](./dist/bin/nonepwd-extension.zip)。
   - 闭合 `Shadow DOM` 内联浮窗（`data-nonepwd-overlay`），完全隔离宿主网页样式，支持 `↑` `↓` `Enter` 键盘选择。
   - **多步登录状态接力**：第 1 页填充账号密码后，第 2 页自动突出展示对应条目的 TOTP 或刚推送到达的邮箱验证码，**原生支持六宫格 `<input maxlength="1">` 验证码自动填入**。
   - **注册页强密码 + 独立域名别名**：聚焦 `new-password` 输入框可一键生成 20 位强密码与专属域名别名并加密落库。

4. **原生跨平台 `np` CLI（macOS & Linux 单二进制）**
   - 零 Node / 零 OpenSSL 动态库依赖：macOS 原生 `Mach-O` + Linux `x86_64-unknown-linux-musl` 100% 静态链接 ELF 可执行文件，拷贝即可在服务器或容器内直接运行。
   - 完整支持 `XDG_CONFIG_HOME` / `~/.config/nonepwd` 与 `0700`/`0600` 原子文件权限保护。
   - `np://<vault>/<item>/<field>` 统一密钥寻址（支持 `totp` 与 `email_otp?wait=30`）、`np run --env-file=.env.tpl -- <cmd>` 内存注入、`np mail otp --wait` 实时 WS 等待与 `np serve --connect` 本地 REST 网关。

---

## 仓库结构

```text
nonepwd/
├── crates/
│   ├── nonepwd-core/          # 纯 Rust 核心库（编译为 Native rlib + wasm32-unknown-unknown cdylib）
│   └── nonepwd-cli/           # 原生独立 `np` CLI（纯 Rust TLS + WS + Connect HTTP 网关，适配 macOS/Linux）
├── scripts/
│   ├── build-rust.mjs         # 构建 Rust WASM、macOS 原生二进制与 Linux musl 静态二进制
│   └── install-cli.sh         # macOS / Linux 一键安装 `np` 到 ~/.local/bin
├── packages/
│   ├── core/                  # @nonepwd/core：内联封装 Rust WASM 引擎
│   ├── server/                # Hono + Node 26 内置 SQLite + WebSocket + IMAP IDLE + CF Webhook
│   ├── cf-email-worker/       # Cloudflare Email Routing Worker（含 wrangler.toml）
│   ├── cli/                   # CLI 兼容包装与 E2E 测试
│   ├── web/                   # React 19 + TailwindCSS v4 官网 & 三栏式 Web Vault
│   └── extension/             # Chrome / Arc / Edge Manifest V3 自动填充插件
└── dist/bin/                  # 构建生成的 CLI 二进制与扩展打包产物（np-darwin-arm64, np-linux-x86_64, nonepwd-extension.zip）
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
# 1. 安装 JS 依赖并全量构建（自动构建 Rust WASM + macOS/Linux np + 前端 + 服务端 + 浏览器插件包）
pnpm install
pnpm build

# 2. 启动 nonepwd 自建服务端（默认端口 8787，数据持久化在 ./data/nonepwd.db）
pnpm --filter @nonepwd/server start
```

打开浏览器访问：
- **nonepwd 官网、插件下载与 WASM 实时实验室**：`http://127.0.0.1:8787/`
- **Web Vault 管理台**：`http://127.0.0.1:8787/vault`（首次打开会进入双密钥初始化向导，请务必下载 Emergency Kit `.json`）
- **多步登录 & 六宫格自动填充沙盒**：`http://127.0.0.1:8787/demo-login`

### 方式二：安装与使用浏览器插件（Chrome / Edge / Arc）

1. 确保已执行 `pnpm build`（产物位于 `packages/extension/dist`，同时官网提供 `http://127.0.0.1:8787/downloads/nonepwd-extension.zip` 下载后解压）。
2. 打开 `chrome://extensions/`（或 Edge/Arc 扩展页），开启右上角 **开发者模式（Developer mode）**。
3. 点击 **加载已解压的扩展程序（Load unpacked）**，选择解压后的插件目录或本仓库构建目录：
   ```text
   packages/extension/dist
   ```
4. 点击扩展图标填入服务端地址、Secret Key（`NP3-...`）与主密码解锁后，访问 `http://127.0.0.1:8787/demo-login` 测试账号填充 → 第 2 步 6 宫格 TOTP / 实时邮箱验证码接力填充。

### 方式三：安装与使用原生 `np` CLI（macOS / Linux）

```bash
# 一键安装适配当前系统架构的原生二进制到 ~/.local/bin/np
./scripts/install-cli.sh

# 也可直接分发静态产物：
# - macOS (Apple Silicon): dist/bin/np-darwin-arm64
# - Linux (x86_64 静态链接): dist/bin/np-linux-x86_64

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

### 方式四：Docker Compose 一键私有化部署

```bash
docker compose up -d --build
```

容器镜像内同时运行自建服务端，并将 Linux 原生 `np` 二进制内置在 `/usr/local/bin/np`。

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

## 运行全量测试

```bash
cargo test --workspace
pnpm -r typecheck
pnpm build
pnpm test
```
