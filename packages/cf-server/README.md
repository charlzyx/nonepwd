# `@nonepwd/cf-server` — Cloudflare Workers + D1 + R2 Serverless Edition

完全兼容 `nonepwd` 零知识协议（Web Vault、macOS SwiftUI 客户端、Android / iOS 客户端、Chrome/Brave MV3 扩展、原生 `np` CLI）的 **Cloudflare 无服务器全栈版**。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server)

> 仓库已内置预编译 Rust WASM 核心，云端构建与本地 Wrangler 部署均**无需安装 Rust 工具链**（仅在你主动修改 `crates/` 后重新编译 WASM 时需要 `pnpm run build:rust`）。

## 架构组件

| 组件 | 用途 |
| :--- | :--- |
| **Cloudflare Worker (`Hono` + `nonepwd_core.wasm`)** | 提供 `/api/*` REST API、HMAC Webhook、`/install.sh` 及预编译 Rust WASM 核心 |
| **Static Assets (`ASSETS`)** | 同域托管 Web Vault 与 `/downloads/*` 客户端包（SPA 单页路由自动回退） |
| **Cloudflare D1 (`DB`)** | 持久化 `account`、`sessions`、`vaults`、`items`、`aliases`、`encrypted_emails`、`service_accounts` 与 `email_filter` |
| **Cloudflare R2 (`BUCKET`)** | 归档密封邮件 `emails/<id>.json`、存储每 6 小时自动/手动零知识快照 `backups/snapshot-*.json` |
| **Durable Objects (`WS_HUB` · WebSocket Hibernation)** | 低功耗实时推送 `email.received`、`item.upserted`、`vault.upserted` 到各客户端 |
| **Cloudflare Email Routing (`email()` handler)** | 直接作为域名 Catch-All Worker 收信，解析 MIME → 正则过滤 → X25519 当场密封存库 → Durable Objects 秒级推送 |

---

## 部署方式

### 方式 A（推荐）：点击 Deploy to Cloudflare 自动 Fork 并部署

1. 点击页面顶部的 **Deploy to Cloudflare** 按钮；
2. Cloudflare 会引导在**你自己的 GitHub 账号下自动 Fork 本仓库**，并自动创建 Worker、`nonepwd-db` (D1)、`nonepwd-vault-blobs` (R2) 与 `VaultWsHub` (Durable Objects) 完成构建上线（首次访问会自动初始化 D1 表结构）；
3. 部署完成后，在 Cloudflare Dashboard 为 Worker 绑定你的自定义域名（如 `vault.yourdomain.com`），并在 **Email → Email Routing → Catch-all address** 选择发送到 Worker **`nonepwd-cf-server`**。

---

### 方式 B：Fork / Clone 后使用 Wrangler CLI 手动部署

```bash
# 1. 在仓库根目录安装依赖并构建 Cloudflare Worker 产物（复用内置预编译 WASM，无需 Rust）
pnpm install
pnpm run build:cf-server

# 2. 进入 cf-server 创建 D1 与 R2
cd packages/cf-server
npx wrangler login
npx wrangler d1 create nonepwd-db            # 把输出的 database_id 填入 wrangler.jsonc（可先跳过用于预览）
npx wrangler r2 bucket create nonepwd-vault-blobs

# 3. 执行 D1 建表迁移（也支持首次请求自动建表）并发布
pnpm run db:migrate:remote
pnpm run deploy:wrangler
```

若需要绑定自有域名，取消注释并修改 [`wrangler.jsonc`](./wrangler.jsonc) 中的自定义域名配置：

```jsonc
"routes": [
  { "pattern": "vault.yourdomain.com", "custom_domain": true }
]
```

> 本地开发维护提示：若使用 `cf deploy`（`pnpm run deploy`）读取私有域名或 D1 ID，可在 `packages/cf-server/.env.local`（已被 `.gitignore` 忽略）中配置 `NONEPWD_CF_DOMAIN` 与 `NONEPWD_CF_D1_ID`，切勿将真实域名或资源 ID 提交到仓库。

部署完成后：
1. 打开 `https://vault.yourdomain.com/vault`，进入双密钥初始化向导设置主密码并保存 Emergency Kit；
2. 将浏览器扩展、macOS / Android / iOS 客户端与 `np setup --server https://vault.yourdomain.com` 指向该域名；
3. （推荐）在 **Cloudflare Dashboard → Email → Email Routing → Catch-all address** 直接选择发送到 Worker **`nonepwd-cf-server`**。如需额外转发一份原始邮件到个人主邮箱，在 `wrangler.jsonc` 中填写 `FORWARD_TO_EMAIL` 后重新 `pnpm run deploy:wrangler` 即可。
