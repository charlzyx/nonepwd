import SwiftUI

public struct UnlockView: View {
    @ObservedObject public var store: VaultStore
    public var showcaseTouchID: Bool = false

    @State private var authMode = 0 // 0 = unlock, 1 = initialize
    @State private var masterPassword = ""
    @State private var setupEmail = ""
    @State private var setupAliasDomain = ""
    @State private var showServerConfig = false

    public init(store: VaultStore, showcaseTouchID: Bool = false) {
        self.store = store
        self.showcaseTouchID = showcaseTouchID
    }

    private var biometry: (available: Bool, label: String) {
        if showcaseTouchID {
            return (true, "使用触控 ID 解锁")
        }
        return TouchIDKeychain.biometryAvailable()
    }

    private var canShowTouchIDButton: Bool {
        authMode == 0 && biometry.available && (store.hasSavedTouchID || showcaseTouchID)
    }

    private var isExpandedConfig: Bool {
        showServerConfig || store.secretKey.isEmpty || store.serverInitialized == false || authMode == 1
    }

    public var body: some View {
        ZStack {
            Color(nsColor: .windowBackgroundColor)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                VStack(spacing: 8) {
                    PasswordsKeyEmblem(category: .login, size: 60)

                    Text(authMode == 1 ? "初始化新密码库" : "NonePwd 已锁定")
                        .font(.system(size: 20, weight: .semibold))

                    Text(
                        authMode == 1
                            ? "首次配置零知识服务端"
                            : (store.knownEmail ?? "输入主密码以解锁本地加密数据")
                    )
                    .font(.system(size: 13))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                }

                if let err = store.errorMessage {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 12))
                            .foregroundStyle(.red)
                        Text(err)
                            .font(.system(size: 12))
                            .foregroundStyle(.red)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 9)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(Color.red.opacity(0.10))
                    )
                }

                VStack(spacing: 10) {
                    if isExpandedConfig {
                        FullWidthSegmentedTabs(
                            options: [
                                ("解锁已有账号", 0),
                                ("初始化新服务端", 1),
                            ],
                            selection: $authMode
                        )
                        .padding(.bottom, 2)

                        HStack(spacing: 8) {
                            BorderlessInputField(
                                "http://127.0.0.1:8787",
                                text: $store.serverURL,
                                isMonospaced: true
                            )
                            Button("检测") {
                                Task { await store.probeServer() }
                            }
                            .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 36, cornerRadius: 9))
                        }

                        if authMode == 1 {
                            BorderlessInputField("管理员邮箱 (you@example.com)", text: $setupEmail)
                            BorderlessInputField(
                                "别名邮箱域名（可选）",
                                text: $setupAliasDomain,
                                isMonospaced: true
                            )
                        } else {
                            BorderlessInputField(
                                "Secret Key (NP3-...)",
                                text: $store.secretKey,
                                isMonospaced: true
                            )
                        }
                    }

                    if canShowTouchIDButton {
                        Button {
                            Task { await store.unlockWithTouchID() }
                        } label: {
                            Label(biometry.label, systemImage: "touchid")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 36, cornerRadius: 9))
                        .disabled(store.busy)
                    }

                    BorderlessInputField(
                        authMode == 1 ? "设置主密码" : "输入主密码",
                        text: $masterPassword,
                        isSecure: true
                    ) {
                        submit()
                    }

                    FullWidthSegmentedTabs(
                        options: UnlockRememberDuration.allCases.map { ($0.label, $0) },
                        selection: $store.unlockDuration
                    )

                    if canShowTouchIDButton {
                        Button(action: submit) {
                            Text(store.busy ? "正在本地派生密钥..." : "使用主密码解锁")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 36, cornerRadius: 9))
                        .disabled(store.busy)
                    } else {
                        Button(action: submit) {
                            HStack(spacing: 6) {
                                if store.busy {
                                    ProgressView().controlSize(.small)
                                }
                                Text(
                                    store.busy
                                        ? "正在本地派生密钥..."
                                        : (authMode == 1 ? "初始化服务端并进入" : "解锁密码库")
                                )
                            }
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 36, cornerRadius: 9))
                        .disabled(store.busy)
                    }
                }

                VStack(spacing: 8) {
                    if biometry.available && !store.hasSavedTouchID && authMode == 0 {
                        Button {
                            store.touchIDEnabled.toggle()
                        } label: {
                            HStack(spacing: 6) {
                                Image(systemName: store.touchIDEnabled ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundStyle(store.touchIDEnabled ? Color.accentColor : Color.secondary)
                                Text("启用触控 ID 快捷解锁")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    if !store.secretKey.isEmpty && store.serverInitialized != false {
                        Button(isExpandedConfig ? "收起设置" : "切换账号或服务器设置…") {
                            withAnimation(.snappy(duration: 0.2)) {
                                if isExpandedConfig {
                                    authMode = 0
                                    showServerConfig = false
                                } else {
                                    showServerConfig = true
                                }
                            }
                        }
                        .buttonStyle(.plain)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                    }
                }
            }
            .frame(width: 300)
            .padding(.bottom, 16)
        }
        .navigationTitle("")
        .toolbarBackgroundVisibility(.hidden, for: .windowToolbar)
        .task {
            if store.serverInitialized == nil && !showcaseTouchID {
                await store.probeServer()
            }
        }
    }

    private func submit() {
        let pw = masterPassword
        masterPassword = ""
        if authMode == 1 {
            Task {
                await store.setupNewServer(
                    email: setupEmail,
                    aliasDomain: setupAliasDomain,
                    masterPassword: pw
                )
            }
        } else {
            Task {
                await store.unlock(masterPassword: pw)
            }
        }
    }
}
