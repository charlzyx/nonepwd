import AppKit
import SwiftUI

public struct MenuBarPopoverView: View {
    @ObservedObject public var store: VaultStore
    @Environment(\.openWindow) private var openWindow

    @State private var selectedTab = 0
    @State private var masterPassword = ""
    @State private var copiedId: String?

    public init(store: VaultStore) {
        self.store = store
    }

    private var twoFactorItems: [VaultItemPayload] {
        store.items
            .filter { $0.totp?.nilIfBlank != nil }
            .sorted { a, b in
                if a.favorite != b.favorite { return a.favorite && !b.favorite }
                return a.title.localizedCaseInsensitiveCompare(b.title) == .orderedAscending
            }
    }

    private var biometry: (available: Bool, label: String) {
        TouchIDKeychain.biometryAvailable()
    }

    private var durationOptions: [(label: String, value: UnlockRememberDuration)] {
        UnlockRememberDuration.allCases.map { ($0.label, $0) }
    }

    public var body: some View {
        VStack(spacing: 0) {
            headerBar

            if !store.isUnlocked {
                lockedBody
            } else {
                unlockedBody
                footerBar
            }
        }
        .frame(width: 348, height: 440)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var headerBar: some View {
        HStack(spacing: 8) {
            PasswordsKeyEmblem(category: .login, size: 24)
            Text("NonePwd")
                .font(.system(size: 13.5, weight: .medium))

            Spacer()

            if store.isUnlocked {
                Menu {
                    Toggle("新邮件自动 AI 提取", isOn: $store.aiAutoExtractEmail)

                    Picker("定时巡检 (Cron)", selection: $store.emailCronMinutes) {
                        Text("关闭").tag(0)
                        Text("每 1 分钟").tag(1)
                        Text("每 5 分钟").tag(5)
                        Text("每 15 分钟").tag(15)
                    }

                    Divider()

                    Button("配置 AI 接口…") {
                        activateMainWindow()
                        store.showEmailFilterSheet = true
                    }
                } label: {
                    Image(systemName: "clock.arrow.circlepath")
                        .font(.system(size: 13.5, weight: .regular))
                        .foregroundStyle(store.emailCronMinutes > 0 ? Color.accentColor : Color.secondary)
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .menuIndicator(.hidden)
                .help("定时巡检与 AI 提取设置")

                Button {
                    Task { await store.runEmailCronAndAIExtract(forceLatest: true) }
                } label: {
                    Image(systemName: store.isRefreshingEmails ? "sparkles" : "arrow.clockwise")
                        .font(.system(size: 13.5, weight: .regular))
                        .foregroundStyle(.secondary)
                        .frame(width: 26, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(store.isRefreshingEmails)
                .help("立即同步新邮件并 AI 提取验证码")
            }

            Button {
                activateMainWindow()
            } label: {
                Image(systemName: "macwindow")
                    .font(.system(size: 13.5, weight: .regular))
                    .foregroundStyle(.secondary)
                    .frame(width: 26, height: 26)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("打开主窗口")
        }
        .padding(12)
    }

    private var lockedBody: some View {
        VStack(spacing: 12) {
            Spacer()

            Text("密码库已锁定")
                .font(.system(size: 15, weight: .medium))

            if let email = store.knownEmail?.nilIfBlank {
                Text(email)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            if let err = store.errorMessage {
                Text(err)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 8)
            }

            VStack(spacing: 9) {
                BorderlessInputField("输入主密码", text: $masterPassword, isSecure: true) {
                    unlockFromMenuBar()
                }

                FullWidthSegmentedTabs(options: durationOptions, selection: $store.unlockDuration)

                Button {
                    unlockFromMenuBar()
                } label: {
                    Text(store.busy ? "正在解锁..." : "解锁密码库")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 34, cornerRadius: 9))
                .disabled(store.busy || store.secretKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                if biometry.available && store.hasSavedTouchID {
                    Button {
                        Task { await store.unlockWithTouchID() }
                    } label: {
                        Text(biometry.label)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 32, cornerRadius: 8))
                    .disabled(store.busy)
                }
            }
            .padding(.horizontal, 18)

            Spacer()
        }
        .padding(.bottom, 12)
    }

    private var unlockedBody: some View {
        VStack(spacing: 10) {
            FullWidthSegmentedTabs(
                options: [
                    ("验证码 \(twoFactorItems.count)", 0),
                    ("邮箱验证码 \(store.emails.count)", 1),
                ],
                selection: $selectedTab
            )
            .padding(.horizontal, 12)

            if selectedTab == 0 {
                totpListView
            } else {
                emailListView
            }
        }
    }

    private var totpListView: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                if twoFactorItems.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "lock.badge.clock")
                            .font(.system(size: 28, weight: .regular))
                            .foregroundStyle(.tertiary)
                        Text("暂无 2FA 验证器条目")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 72)
                } else {
                    ForEach(twoFactorItems) { item in
                        let totp = store.totpSnapshot[item.id]
                        let isCopied = copiedId == "totp-\(item.id)"
                        Button {
                            if let code = totp?.code {
                                store.copySecret(code, label: item.title)
                                flashCopied("totp-\(item.id)")
                            }
                        } label: {
                            HStack(spacing: 10) {
                                SquircleAvatar(
                                    title: item.title,
                                    category: item.category,
                                    urlHint: item.urls.first ?? item.title,
                                    size: 28
                                )

                                VStack(alignment: .leading, spacing: 1) {
                                    Text(item.title)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    Text(item.username?.nilIfBlank ?? item.subtitle)
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                }

                                Spacer(minLength: 8)

                                if isCopied {
                                    Text("已复制 ✓")
                                        .font(.system(size: 12, weight: .medium))
                                        .foregroundStyle(.green)
                                } else if let totp {
                                    HStack(spacing: 7) {
                                        Text(totp.code)
                                            .font(.system(size: 16, weight: .medium, design: .monospaced))
                                            .foregroundStyle(Color.accentColor)
                                        CountdownRing(
                                            remainingSeconds: totp.remainingSeconds,
                                            period: totp.period
                                        )
                                    }
                                }
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 8)
                            .background(
                                RoundedRectangle(cornerRadius: 10, style: .continuous)
                                    .fill(Color.primary.opacity(0.045))
                            )
                            .contentShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
    }

    private var emailListView: some View {
        ScrollView {
            LazyVStack(spacing: 6) {
                if store.emails.isEmpty {
                    VStack(spacing: 10) {
                        Image(systemName: "envelope.open")
                            .font(.system(size: 28, weight: .regular))
                            .foregroundStyle(.tertiary)
                        Text("暂无邮箱验证码记录")
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                        Button {
                            Task { await store.runEmailCronAndAIExtract(forceLatest: true) }
                        } label: {
                            Text(store.isRefreshingEmails ? "正在同步..." : "立即刷新检测")
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 28, cornerRadius: 7))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 64)
                } else {
                    ForEach(store.emails) { email in
                        let aiInfo = store.aiEmailExtractions[email.id]
                        let senderLabel = aiInfo?.issuer?.nilIfBlank
                            ?? email.senderDomain.nilIfBlank
                            ?? email.from
                        let summaryLabel = aiInfo?.summary?.nilIfBlank
                            ?? email.subject.nilIfBlank
                            ?? "（无主题）"
                        let resolvedCode = email.otpCode?.nilIfBlank ?? aiInfo?.otpCode?.nilIfBlank
                        let isExtracting = store.aiExtractingIds.contains(email.id)
                        let isCopied = copiedId == "email-\(email.id)"

                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 2) {
                                HStack(spacing: 5) {
                                    Text(senderLabel)
                                        .font(.system(size: 13, weight: .medium))
                                        .foregroundStyle(.primary)
                                        .lineLimit(1)
                                    if aiInfo != nil {
                                        Text("AI")
                                            .font(.system(size: 9.5, weight: .medium))
                                            .foregroundStyle(Color.accentColor)
                                            .padding(.horizontal, 5)
                                            .padding(.vertical, 1)
                                            .background(
                                                RoundedRectangle(cornerRadius: 4, style: .continuous)
                                                    .fill(Color.accentColor.opacity(0.12))
                                            )
                                    }
                                }
                                Text(summaryLabel)
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(1)
                            }

                            Spacer(minLength: 8)

                            if isExtracting {
                                ProgressView()
                                    .controlSize(.mini)
                            } else if let code = resolvedCode {
                                Button {
                                    store.copySecret(code, label: "邮箱验证码")
                                    flashCopied("email-\(email.id)")
                                } label: {
                                    Text(isCopied ? "已复制" : code)
                                        .font(.system(size: isCopied ? 12 : 15, weight: .medium, design: .monospaced))
                                        .foregroundStyle(isCopied ? .green : Color.accentColor)
                                        .padding(.horizontal, 9)
                                        .padding(.vertical, 4)
                                        .background(
                                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                                .fill((isCopied ? Color.green : Color.accentColor).opacity(0.11))
                                        )
                                }
                                .buttonStyle(.plain)
                            } else if store.isAIConfigured {
                                Button {
                                    Task { await store.extractEmailOtpWithAI(email, force: true) }
                                } label: {
                                    Text("AI 提取")
                                        .font(.system(size: 11.5, weight: .medium))
                                        .foregroundStyle(.secondary)
                                        .padding(.horizontal, 8)
                                        .padding(.vertical, 4)
                                        .background(
                                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                                .fill(Color.primary.opacity(0.06))
                                        )
                                }
                                .buttonStyle(.plain)
                            } else {
                                Text("无验证码")
                                    .font(.system(size: 11))
                                    .foregroundStyle(.tertiary)
                            }
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                        .background(
                            RoundedRectangle(cornerRadius: 10, style: .continuous)
                                .fill(Color.primary.opacity(0.045))
                        )
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 8)
        }
    }

    private var footerBar: some View {
        HStack {
            Text(footerStatusText)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(1)

            Spacer()

            Button("锁定") {
                store.lock()
            }
            .buttonStyle(.plain)
            .font(.system(size: 11.5))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .frame(height: 32)
        .background(Color.primary.opacity(0.03))
    }

    private var footerStatusText: String {
        if !store.clipboardStatus.isEmpty {
            return store.clipboardStatus
        }
        let cronStr = store.emailCronMinutes > 0
            ? "定时巡检：每 \(store.emailCronMinutes) 分钟"
            : "定时巡检已关闭"
        let aiStr = store.aiAutoExtractEmail
            ? (store.isAIConfigured ? "AI 自动提取已开启" : "AI 未配置 Key")
            : "AI 自动提取关闭"
        return "\(cronStr) · \(aiStr)"
    }

    private func unlockFromMenuBar() {
        let pw = masterPassword
        masterPassword = ""
        Task { await store.unlock(masterPassword: pw) }
    }

    private func flashCopied(_ id: String) {
        copiedId = id
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.4))
            if copiedId == id { copiedId = nil }
        }
    }

    private func activateMainWindow() {
        NSApplication.shared.activate(ignoringOtherApps: true)
        if let win = NSApplication.shared.windows.first(where: { $0.canBecomeMain && !($0 is NSPanel) }) {
            win.makeKeyAndOrderFront(nil)
        } else {
            openWindow(id: "main")
        }
    }
}
