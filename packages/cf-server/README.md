# `@nonepwd/cf-server` — Cloudflare Workers + D1 + R2 Serverless Edition

完全兼容 `nonepwd` 零知识协议（Web Vault、macOS SwiftUI 客户端、Chrome/Brave MV3 扩展、原生 `np` CLI）的 **Cloudflare 无服务器全栈版**。

## 架构组件

| 组件 | 用途 |
| :--- | :--- |
| **Cloudflare Worker (`Hono` + `nonepwd_core.wasm`)** | 提供 `/api/*` REST API、HMAC Webhook、`/install.sh` 及预编译 Rust WASM 核心 |
| **Static Assets (`ASSETS`)** | 同域托管 Web Vault 与 `/downloads/*` 客户端包（SPA 单页路由自动回退） |
| **Cloudflare D1 (`DB`)** | 持久化 `account`、`sessions`、`vaults`、`items`、`aliases`、`encrypted_emails`、`service_accounts` 与 `email_filter` |
| **Cloudflare R2 (`BUCKET`)** | 归档密封邮件 `emails/<id>.json`、存储每 6 小时自动/手动零知识快照 `backups/snapshot-*.json`、可选分发 `/downloads/*` 二进制 |
| **Durable Objects (`WS_HUB` · WebSocket Hibernation)** | 低功耗实时推送 `email.received`、`item.upserted`、`vault.upserted` 到浏览器扩展、macOS 桌面端和 `np mail otp` |
| **Cloudflare Email Routing (`email()` handler)** | 直接作为域名 Catch-All Worker 收信，解析 MIME → 执行正则过滤 → 使用你的 X25519 公钥当场密封存入 D1+R2 → 通过 DO 秒级推送 |

---

## 一键部署到自有域名（如 `vault.yourdomain.com`）

### 1. 构建全端与 CF Worker 产物

在仓库根目录执行：

```bash
pnpm install
pnpm run build:rust      # 构建 nonepwd_core.wasm
pnpm run build:cf-server # 构建 core + web + extension + cf-server (含 ./public 静态资源)
```

### 2. 创建 D1 数据库与 R2 存储桶

```bash
cd packages/cf-server

# 1. 登录 Cloudflare
npx wrangler login

# 2. 创建 D1 数据库（把输出中的 database_id 填入 wrangler.jsonc）
npx wrangler d1 create nonepwd-db

# 3. 执行 D1 建表迁移（也支持首次请求自动建表）
pnpm run db:migrate:remote

# 4. 创建 R2 存储桶（用于邮件归档 & 定时零知识加密快照）
npx wrangler r2 bucket create nonepwd-vault-blobs
```

### 3. 绑定自有域名并发布

取消注释并修改 [`wrangler.jsonc`](./wrangler.jsonc) 中的自定义域名配置：

```jsonc
"routes": [
  { "pattern": "vault.yourdomain.com", "custom_domain": true }
]
```

然后部署：

```bash
pnpm run deploy
```

部署完成后：
1. 打开 `https://vault.yourdomain.com/vault`，进入双密钥初始化向导设置主密码并保存 Emergency Kit；
2. 将浏览器扩展、`np setup --server https://vault.yourdomain.com` 与 macOS 桌面端地址指向 `https://vault.yourdomain.com`；
3. （推荐）在 **Cloudflare Dashboard → Email → Email Routing → Catch-all address** 直接选择发送到 Worker **`nonepwd-cf-server`**，无需再单独部署 `cf-email-worker`。如需把所有别名邮件额外转发一份到你的个人主邮箱，在 `wrangler.jsonc` 中填写 `FORWARD_TO_EMAIL` 后重新 `pnpm run deploy` 即可。
