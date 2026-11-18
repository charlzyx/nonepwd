<p>
  <img src="apps/nsh/icon.png" width="52" alt="nonepwd" />
</p>

# nonepwd

私有化自建零知识密码库与实时验证码引擎 · Self-hosted zero-knowledge vault &amp; live OTP engine.

[官网](https://nonepwd.charlzyx.workers.dev) · [Releases 下载](https://github.com/charlzyx/nonepwd/releases/latest) · [CLI &amp; Agent 手册 (`SKILL.md`)](./SKILL.md) · [Cloudflare 部署指南](./packages/cf-server/README.md)

---

## 核心特性

- **双密钥零知识**：`Master Password + Secret Key (NP3-...)` 本地 600k PBKDF2 派生，Per-Vault `AES-256-GCM` 独立加密，服务端零明文。
- **实时邮箱接码**：同时监听 Gmail / QQ / 163 / iCloud / Outlook 多账号 IMAP，并支持 Cloudflare Email Routing 无限域名别名；`X25519` 密封后经 WebSocket 秒级推送。
- **框选与扫码 2FA**：支持桌面屏幕框选、浏览器网页划区识别、手机相机/相册扫码，以及 Google Authenticator `otpauth-migration://` 一键导入。
- **全端自动填充**：Android 系统级 `AutofillService`（Keystore 加密缓存 + 包名/域名匹配）与闭合 Shadow DOM 浏览器扩展（支持多步六宫格验证码接力）。
- **全品类密钥库**：统一托管登录凭据、API Key、SSH 密钥、银行卡、身份地址与安全笔记，支持 Chrome / 1Password CSV 迁移。
- **`op://` 兼容 CLI**：纯 Rust 零依赖单二进制 `np`，原生兼容 `op://` 与 `np://` 密钥引用、`np run` 内存注入与 Service Account 隔离。

---

## 客户端下载

前往 [GitHub Releases](https://github.com/charlzyx/nonepwd/releases/latest) 获取最新预构建产物（附 `SHA256SUMS.txt`）：

| 平台 | 产物 / 安装 | 说明 |
| :--- | :--- | :--- |
| **macOS** | `NonePwd-macos-arm64.zip` | SwiftUI 原生桌面端（Touch ID、菜单栏实时 OTP、屏幕框选 2FA） |
| **Android** | `NonePwd-android.apk` | 含系统级 `AutofillService`、单屏解锁与相机扫码导入 |
| **iOS** | `NonePwd-ios-unsigned.ipa` / `NonePwd-ios-sim-arm64.app.zip` | 零知识同步、实时 TOTP 与相机/相册扫码 |
| **浏览器扩展** | `nonepwd-extension.zip` | Chrome / Arc / Brave / Edge MV3 扩展（自动填充 + 网页框选 2FA） |
| **`np` CLI** | `curl -fsSL https://nonepwd.charlzyx.workers.dev/install.sh \| bash` | 支持 macOS (`arm64`) / Linux (`x86_64`) / Windows，亦可手动下载 Release 二进制 |
| **Web Vault** | 服务端内置 `/vault` | 响应式三栏工作台、摄像头扫码与 R2 快照恢复 |

---

## 私有部署

### A. Cloudflare Serverless（自有域名免运维）

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/charlzyx/nonepwd/tree/main/packages/cf-server)

点击按钮会引导在**你的 GitHub 账号下自动 Fork 本仓库**，并自动创建 Worker、`nonepwd-db` (D1)、`nonepwd-vault-blobs` (R2) 与 Durable Objects（仓库内置预编译 WASM，无需安装 Rust）。部署后在 Cloudflare Dashboard 绑定自定义域名（如 `vault.yourdomain.com`），并在 **Email → Email Routing → Catch-all** 选择发送到 **`nonepwd-cf-server`** 即可；手动 `wrangler` 部署见 [`packages/cf-server/README.md`](./packages/cf-server/README.md)（若需转发到外部服务端，见 [`packages/cf-email-worker/wrangler.toml`](./packages/cf-email-worker/wrangler.toml)）。

### B. 本地 / VPS / Docker（单二进制 + SQLite）

```bash
# Node.js >= 22 一键启动（默认 http://127.0.0.1:8787）
NONEPWD_DATA_DIR=./data npx @nonepwd/server

# 或使用纯 Rust 单二进制 / Docker Compose
np server
docker compose up -d --build
```

---

## CLI 速览

```bash
np signin --server https://vault.yourdomain.com --secret-key "NP3-..." --password "..."
np run --env-file .env.tpl -- npm run dev      # 内存解密注入 op:// 与 np://，硬盘零落盘
OTP=$(np mail otp --domain github.com --wait 30s)
np service-account create ci-agent --vault DevOps
```

完整 `op://` 兼容命令表与 AI Agent 集成用法见 [`SKILL.md`](./SKILL.md)。

---

## 源码构建与测试

```bash
pnpm install && pnpm build && pnpm test
cargo test --workspace

./apps/desktop/scripts/build-app.sh          # macOS NonePwd.app
./apps/nsh/scripts/package-android.sh        # Android APK
./apps/nsh/scripts/package-ios.sh            # iOS 未签名 IPA
pnpm release:local v0.2.0                    # 全平台本地打包与发布校验
```

---

## License

[MIT](./LICENSE) © 2026 charlzyx
