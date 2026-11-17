# NonePwd macOS 原生客户端 (`apps/desktop`)

基于 [Asuka](https://asuka.egoist.dev/zh) (`github.com/egoist/asuka`) 构建的 **NonePwd 零知识密码库 macOS 原生桌面客户端**。直接渲染 macOS AppKit 原生控件（自动跟随系统浅色 / 深色外观），零 WebView、零 CGO，所有加密原语 100% 通过 Asuka 插件加载 Rust `nonepwd-core` 原生动态库 (`libnonepwd_core.dylib`) 执行。

---

## 核心特性

- **零知识端到端加密（Rust Core Asuka Plugin）**：
  - 通过 `apps/desktop/npcore/asuka-plugin.json` + `plugin.LibraryPath` + `purego` 加载预编译的 `libnonepwd_core.dylib`（无 CGO）。
  - 完整对齐服务端与 Web 端协议：`GET /api/auth/params` → `derive_account_keys` (PBKDF2-HMAC-SHA256 + HKDF-SHA256) → `POST /api/auth/login` → 解密根密钥集 (`AAD = nonepwd:root-keyset:v1`) → `GET /api/sync` → 解密各密码库密钥/元数据/凭据条目 → X25519 + HKDF + AES-256-GCM 解封加密邮件。
- **安全的设备配置记忆**：
  - 在用户系统配置目录 (`~/Library/Application Support/dev.nonepwd.desktop/config.json`，权限 `0600`) 记住服务端地址与设备 `Secret Key (NP3-...)`，**绝不落盘或上传主密码 (Master Password)**。
  - 支持连接未初始化的新服务端并一键完成初始化 (`POST /api/auth/setup`)。
- **多密码库、分类筛选与即时搜索**：
  - 支持密码库切换与新建密码库 (`Personal` / `DevOps` / 自定义密码库)。
  - 支持按 `全部条目`、`收藏夹`、`网站登录`、`银行卡`、`身份地址`、`密钥与笔记` 筛选及关键词实时搜索。
- **全类型凭据创建与编辑**：
  - **网站登录 / API 密钥 / SSH 密钥 / 安全笔记**：用户名、密码（内置 Rust 随机强密码与易记短语生成器）、掩码邮箱别名、多行 URL、安全备注、自定义字段。
  - **银行卡 (`card`)**：`cardholderName`、`number`（默认掩码展示 `•••• •••• •••• 1234`，支持一键显示/复制）、`expMonth`、`expYear`、`cvv`（掩码保护）、`brand`。
  - **身份与地址 (`identity`)**：`fullName`、`lastName`、`firstName`、`email`、`phone`、`company`、`address1`、`address2`、`city`、`state`、`postalCode`、`country`，支持一键复制完整收货地址。
- **实时 2FA TOTP 动态码与 30 秒剪贴板自动清空**：
  - 每秒刷新 6/8 位 TOTP 动态码与环形倒计时进度条（剩余 `≤5s` 自动高亮预警）。
  - 复制密码、用户名、银行卡号、CVV、动态码或邮箱验证码后，顶部状态栏实时倒计时并在 **30 秒后自动清空系统剪贴板**（也可随时点击「立即清空剪贴板」）。
- **WebSocket 实时邮箱验证码推送**：
  - 保持 `/api/ws` 长连接（断线自动指数退避重连），收到 `email.received` 推送后立即在内存解封 X25519 密文信封，弹出验证码通知横幅并在关联登录条目详情页置顶展示最新验证码。
- **一键锁定 (`⌘L`)**：立即注销会话、断开 WebSocket 并清空内存中的会话令牌、根密钥与明文数据。

---

## 目录结构

```text
apps/desktop/
├── asuka.json                  # Asuka 应用清单 (NonePwd / dev.nonepwd.desktop)
├── main.go                     # 应用窗口入口、原生菜单栏与全局快捷键 (⌘N / ⌘R / ⌘L)
├── ui_state.go                 # 响应式状态管理 (signal)、TOTP 定时器与 30s 剪贴板自动清理
├── unlock_view.go              # 解锁与新服务端初始化视图
├── workspace_view.go           # 三栏原生工作区视图（侧边栏 + 搜索列表 + 详情/编辑）
├── item_detail.go              # 条目详情视图（登录 / 银行卡 / 身份地址 / TOTP / 关联验证码）
├── item_editor.go              # 新建与编辑条目表单
├── email_view.go               # 实时加密邮箱验证码收件流视图
├── npcore/
│   ├── asuka-plugin.json       # Asuka 原生插件清单
│   ├── build/darwin/           # StoreBuild 生成的 libnonepwd_core.dylib 预编译产物
│   ├── npcore.go               # plugin.LibraryPath + purego Rust FFI 封装
│   └── npcore_test.go          # 插件加载与加密/TOTP 单元测试
├── client/
│   ├── client.go               # HTTP + WebSocket + 零知识同步客户端
│   ├── config.go               # 用户配置目录读写（不存主密码）
│   └── client_test.go          # 对接真实测试服务端的端到端集成测试
├── cmd/buildplugin/
│   └── main.go                 # 编译 crates/nonepwd-core 并调用 plugin.StoreBuild 的构建工具
└── dist/
    └── NonePwd.app             # asuka build 生成的可直接运行 macOS 原生应用包
```

---

## 环境要求

- macOS (Apple Silicon `arm64`)
- Go `1.26+` (`/opt/homebrew/bin/go`)
- Asuka CLI (`go install github.com/egoist/asuka/cmd/asuka@latest`)
- Rust 工具链（仅重新编译 `crates/nonepwd-core` 插件动态库时需要；仓库已附预编译产物）

---

## 构建与运行步骤

### 1.（可选）重新编译 Rust `nonepwd-core` Asuka 插件动态库

当 `crates/nonepwd-core` 源码发生变更时，在 `apps/desktop` 目录执行：

```bash
cd apps/desktop
go run ./cmd/buildplugin
```

该命令会编译 `crates/nonepwd-core` (`--release`) 并通过 `plugin.StoreBuild` 写入 `apps/desktop/npcore/build/darwin/libnonepwd_core.dylib`。

### 2. 开发模式热重载运行

先在终端启动本地测试或自托管服务端（切勿指向生产数据目录进行破坏性测试）：

```bash
# 使用原生 Rust 单二进制启动测试服务端
./dist/bin/np server --host 127.0.0.1 --port 8787 --data-dir /tmp/nonepwd-dev-data
```

然后启动桌面客户端开发模式：

```bash
cd apps/desktop
asuka dev
```

### 3. 构建可分发的 macOS `.app` 应用包

```bash
cd apps/desktop
asuka build
```

构建完成后产物位于：

```text
apps/desktop/dist/NonePwd.app
```

可直接启动：

```bash
open apps/desktop/dist/NonePwd.app
```

`NonePwd.app/Contents/Frameworks/libnonepwd_core.dylib` 已由 `asuka build` 自动打包并进行 ad-hoc 代码签名。

### 4. 运行单元测试与 UI 集成测试

测试会自动拉起临时目录的独立测试服务端（优先使用 `dist/bin/np server --port 0 --data-dir <tmp>`，回退 `node packages/server/dist/index.js`），验证 Asuka 插件加载、PBKDF2/AES-GCM/X25519 零知识全链路、WebSocket 邮件验证码推送以及浅色/深色原生 UI 交互：

```bash
cd apps/desktop
go test -v ./...
```
