# `@nonepwd/cf-server` — Cloudflare Workers + D1 + R2 Serverless Edition

完全兼容 `nonepwd` 零知识协议的 **Cloudflare 无服务器全栈版**（Worker API + D1 数据库 + R2 邮件归档与每 6 小时加密快照 + Durable Objects WebSocket + Email Routing Catch-All）。

> 仓库已内置预编译 Rust WASM 核心，云端与本地 Wrangler 部署均**无需安装 Rust**。

## 方式 A（推荐）：一键自动 Fork 并部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server)

1. 点击按钮授权后，Cloudflare 会在**你的 GitHub 账号下自动 Fork 本仓库**，并创建 Worker、`nonepwd-db` (D1)、`nonepwd-vault-blobs` (R2) 与 `VaultWsHub`（首次访问自动建表）。
2. 在 Cloudflare Dashboard → Worker → **Settings → Domains & Routes** 绑定自定义域名（如 `vault.yourdomain.com`）。
3. 在 **Email → Email Routing → Catch-all address** 选择发送到 Worker **`nonepwd-cf-server`**。

## 方式 B：Fork / Clone 后使用 Wrangler CLI 部署

```bash
pnpm install && pnpm run build:cf-server
cd packages/cf-server
npx wrangler login
npx wrangler d1 create nonepwd-db            # 将 database_id 与 custom_domain 填入 wrangler.jsonc
npx wrangler r2 bucket create nonepwd-vault-blobs
pnpm run db:migrate:remote
pnpm run deploy:wrangler
```

如需将别名邮件同时抄送一份至个人主邮箱，在 [`wrangler.jsonc`](./wrangler.jsonc) 中填写 `FORWARD_TO_EMAIL` 后重新 `pnpm run deploy:wrangler` 即可（本机开发如需保留私有域名与 D1 ID，可在 gitignore 覆盖的 `.env.local` 中配置 `NONEPWD_CF_DOMAIN` 与 `NONEPWD_CF_D1_ID` 配合 `pnpm run deploy` 使用）。
