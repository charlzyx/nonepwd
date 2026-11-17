import SwiftUI

public struct MainWorkspaceView: View {
    @ObservedObject public var store: VaultStore
    @State private var showNewVaultPopover = false
    @State private var newVaultName = ""
    @State private var pendingDeleteItem: VaultItemPayload?

    private let bentoColumns = [
        GridItem(.flexible(), spacing: 10),
        GridItem(.flexible(), spacing: 10),
    ]

    public var body: some View {
        NavigationSplitView {
            sidebarColumn
                .navigationSplitViewColumnWidth(min: 224, ideal: 244, max: 272)
        } content: {
            contentColumn
                .navigationSplitViewColumnWidth(min: 260, ideal: 296, max: 350)
        } detail: {
            detailColumn
        }
        .searchable(
            text: $store.searchText,
            placement: .toolbar,
            prompt: "搜索"
        )
        .overlay(alignment: .bottom) {
            if !store.clipboardStatus.isEmpty {
                clipboardToast
                    .padding(.bottom, 16)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .sheet(isPresented: $store.showEditor) {
            ItemEditorSheet(
                store: store,
                initialItem: store.editingItem,
                initialCategory: store.editingCategory ?? .login
            )
        }
        .sheet(isPresented: $store.showImportSheet) {
            ImportSheet(store: store)
        }
        .sheet(isPresented: $store.showEmailFilterSheet) {
            EmailFilterSheet(store: store)
        }
        .sheet(isPresented: $store.showExtensionSheet) {
            BrowserExtensionSheet(store: store)
        }
        .confirmationDialog(
            "确定删除「\(pendingDeleteItem?.title ?? "")」？",
            isPresented: Binding(
                get: { pendingDeleteItem != nil },
                set: { if !$0 { pendingDeleteItem = nil } }
            )
        ) {
            Button("删除", role: .destructive) {
                if let target = pendingDeleteItem {
                    pendingDeleteItem = nil
                    Task { try? await store.deleteItem(target) }
                }
            }
            Button("取消", role: .cancel) {
                pendingDeleteItem = nil
            }
        }
    }

    // MARK: - Column 1: Apple Passwords Bento Sidebar

    private var sidebarColumn: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    // 2x3 Apple Passwords Colorful Category Tiles
                    LazyVGrid(columns: bentoColumns, spacing: 10) {
                        BentoCategoryTile(
                            title: "全部",
                            count: store.items.count,
                            systemImage: "key.fill",
                            tint: Color(red: 0.21, green: 0.34, blue: 0.96),
                            isSelected: store.destination == .all
                        ) {
                            store.destination = .all
                        }

                        BentoCategoryTile(
                            title: "密码登录",
                            count: store.loginItemsCount,
                            systemImage: "person.badge.key.fill",
                            tint: Color(red: 0.18, green: 0.76, blue: 0.31),
                            isSelected: store.destination == .logins
                        ) {
                            store.destination = .logins
                        }

                        BentoCategoryTile(
                            title: "验证码",
                            count: store.twoFactorItemsCount,
                            systemImage: "lock.badge.clock.fill",
                            tint: Color(red: 0.90, green: 0.74, blue: 0.15),
                            isSelected: store.destination == .twoFactor
                        ) {
                            store.destination = .twoFactor
                        }

                        BentoCategoryTile(
                            title: "收件验证码",
                            count: store.otpEmailsCount,
                            systemImage: "envelope.fill",
                            tint: Color(red: 0.22, green: 0.61, blue: 0.90),
                            isSelected: store.destination == .emailOtp
                        ) {
                            store.destination = .emailOtp
                        }

                        BentoCategoryTile(
                            title: "安全性",
                            count: store.securityItemsCount,
                            systemImage: "exclamationmark.circle.fill",
                            tint: Color(red: 0.88, green: 0.23, blue: 0.20),
                            isSelected: store.destination == .security
                        ) {
                            store.destination = .security
                        }

                        BentoCategoryTile(
                            title: "收藏夹",
                            count: store.favoriteItemsCount,
                            systemImage: "star.fill",
                            tint: Color(red: 0.93, green: 0.54, blue: 0.14),
                            isSelected: store.destination == .favorites
                        ) {
                            store.destination = .favorites
                        }
                    }

                    // 填充与密文
                    VStack(alignment: .leading, spacing: 2) {
                        Text("填充与密文")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 4)

                        sidebarRow(
                            title: "银行卡",
                            systemImage: "creditcard.fill",
                            tint: Color(red: 0.18, green: 0.72, blue: 0.32),
                            count: store.cardItemsCount,
                            isSelected: store.destination == .card
                        ) {
                            store.destination = .card
                        }

                        sidebarRow(
                            title: "身份与地址",
                            systemImage: "person.text.rectangle.fill",
                            tint: Color(red: 0.22, green: 0.58, blue: 0.90),
                            count: store.identityItemsCount,
                            isSelected: store.destination == .identity
                        ) {
                            store.destination = .identity
                        }

                        sidebarRow(
                            title: "密钥与笔记",
                            systemImage: "lock.doc.fill",
                            tint: Color(red: 0.36, green: 0.38, blue: 0.84),
                            count: store.secretsAndNotesCount,
                            isSelected: store.destination == .secretsAndNotes
                        ) {
                            store.destination = .secretsAndNotes
                        }
                    }

                    // Vaults list
                    VStack(alignment: .leading, spacing: 2) {
                        HStack {
                            Text("密码库")
                                .font(.system(size: 11, weight: .medium))
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button {
                                showNewVaultPopover.toggle()
                            } label: {
                                Image(systemName: "plus")
                                    .font(.system(size: 11, weight: .medium))
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.plain)
                            .help("新建密码库")
                            .popover(isPresented: $showNewVaultPopover) {
                                VStack(alignment: .leading, spacing: 10) {
                                    Text("新建独立密码库")
                                        .font(.system(size: 13, weight: .semibold))
                                    BorderlessInputField("例如：Work / Crypto", text: $newVaultName) {
                                        let trimmed = newVaultName.trimmingCharacters(in: .whitespaces)
                                        guard !trimmed.isEmpty else { return }
                                        newVaultName = ""
                                        showNewVaultPopover = false
                                        Task { try? await store.createVault(name: trimmed) }
                                    }
                                    .frame(width: 210)
                                    HStack {
                                        Spacer()
                                        Button("创建") {
                                            let name = newVaultName
                                            newVaultName = ""
                                            showNewVaultPopover = false
                                            Task { try? await store.createVault(name: name) }
                                        }
                                        .buttonStyle(.glassProminent)
                                        .disabled(newVaultName.trimmingCharacters(in: .whitespaces).isEmpty)
                                    }
                                }
                                .padding(14)
                            }
                        }
                        .padding(.horizontal, 8)
                        .padding(.bottom, 4)

                        ForEach(store.vaults) { v in
                            let count = store.items.filter { $0.vaultId == v.id }.count
                            sidebarRow(
                                title: v.metadata.name,
                                systemImage: "folder.fill",
                                tint: .accentColor,
                                count: count,
                                isSelected: store.destination == .vault(v.id)
                            ) {
                                store.destination = .vault(v.id)
                            }
                        }
                    }

                    // 连接与工具
                    VStack(alignment: .leading, spacing: 2) {
                        Text("连接与工具")
                            .font(.system(size: 11, weight: .medium))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 4)

                        sidebarRow(
                            title: "浏览器自动填充扩展",
                            systemImage: "puzzlepiece.extension.fill",
                            tint: Color(red: 0.21, green: 0.34, blue: 0.96),
                            count: nil,
                            isSelected: false
                        ) {
                            store.showExtensionSheet = true
                        }

                        sidebarRow(
                            title: "导入密码 / 2FA",
                            systemImage: "square.and.arrow.down",
                            tint: .secondary,
                            count: nil,
                            isSelected: false
                        ) {
                            store.showImportSheet = true
                        }

                        sidebarRow(
                            title: "邮件接收过滤",
                            systemImage: "line.3.horizontal.decrease.circle",
                            tint: .secondary,
                            count: nil,
                            isSelected: false
                        ) {
                            store.showEmailFilterSheet = true
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            }

            HStack(spacing: 8) {
                Image(systemName: "lock.shield.fill")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                Text(store.accountEmail)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)

                Spacer(minLength: 4)

                Button {
                    store.lock()
                } label: {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 12))
                }
                .buttonStyle(.plain)
                .foregroundStyle(.secondary)
                .help("锁定密码库 (⌘L)")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
        }
    }

    private func sidebarRow(
        title: String,
        systemImage: String,
        tint: Color,
        count: Int?,
        isSelected: Bool,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 9) {
                Image(systemName: systemImage)
                    .font(.system(size: 13))
                    .foregroundStyle(isSelected ? Color.accentColor : tint)
                    .frame(width: 18)

                Text(title)
                    .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                    .foregroundStyle(.primary)
                    .lineLimit(1)

                Spacer()

                if let count {
                    Text("\(count)")
                        .font(.system(size: 12))
                        .monospacedDigit()
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(isSelected ? Color.primary.opacity(0.08) : .clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Column 2: Items or Email OTP Inbox

    @ViewBuilder
    private var contentColumn: some View {
        Group {
            if store.destination == .emailOtp {
                emailInboxList
            } else {
                credentialList
            }
        }
        .navigationTitle(store.currentDestinationTitle)
        .navigationSubtitle(store.currentDestinationSubtitle)
        .toolbar {
            ToolbarItemGroup(placement: .primaryAction) {
                if store.destination == .emailOtp {
                    Button {
                        Task { await store.runEmailCronAndAIExtract(forceLatest: true) }
                    } label: {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 15.5, weight: .regular))
                            .foregroundStyle(.primary)
                    }
                    .disabled(store.isRefreshingEmails)
                    .help("刷新收件验证码列表")

                    Button {
                        store.showEmailFilterSheet = true
                    } label: {
                        Image(systemName: "line.3.horizontal.decrease.circle")
                            .font(.system(size: 15.5, weight: .regular))
                            .foregroundStyle(.primary)
                    }
                    .help("邮件接收过滤规则")
                } else {
                    Menu {
                        Picker("排序方式", selection: $store.sortField) {
                            ForEach(ItemSortField.allCases) { field in
                                Label(field.label, systemImage: field.systemImage).tag(field)
                            }
                        }
                        .pickerStyle(.inline)

                        Divider()

                        Picker("顺序", selection: $store.sortAscending) {
                            Label("升序", systemImage: "arrow.down").tag(true)
                            Label("降序", systemImage: "arrow.up").tag(false)
                        }
                        .pickerStyle(.inline)
                    } label: {
                        Image(systemName: "arrow.up.arrow.down")
                            .font(.system(size: 15.5, weight: .regular))
                            .foregroundStyle(.primary)
                    }
                    .menuIndicator(.hidden)
                    .help("排序方式")

                    Button {
                        openNewEditor(defaultCategoryForCurrentDestination)
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 15.5, weight: .regular))
                            .foregroundStyle(.primary)
                    }
                    .help("新建密码")
                }
            }
        }
    }

    private var credentialList: some View {
        let filtered = store.filteredItems
        return Group {
            if filtered.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "key.slash")
                        .font(.system(size: 36))
                        .foregroundStyle(.tertiary)
                    Text("暂无匹配条目")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.secondary)
                    Button {
                        openNewEditor(defaultCategoryForCurrentDestination)
                    } label: {
                        Text("新建密码")
                            .padding(.horizontal, 10)
                    }
                    .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 32, cornerRadius: 8))
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(filtered.enumerated()), id: \.element.id) { idx, item in
                            let isSelected = store.selectedItemId == item.id
                            let nextSelected = idx + 1 < filtered.count && store.selectedItemId == filtered[idx + 1].id
                            CredentialRowView(
                                item: item,
                                totp: store.totpSnapshot[item.id],
                                securityWarning: store.securityIssues[item.id],
                                isSelected: isSelected,
                                showDivider: idx + 1 < filtered.count && !isSelected && !nextSelected,
                                onSelect: {
                                    store.selectedItemId = item.id
                                },
                                onToggleFavorite: {
                                    Task { await store.toggleFavorite(item) }
                                },
                                onEdit: {
                                    store.editingItem = item
                                    store.editingCategory = item.category
                                    store.showEditor = true
                                },
                                onDelete: {
                                    pendingDeleteItem = item
                                },
                                onCopyUsername: item.username?.nilIfBlank != nil ? {
                                    store.copySecret(item.username!, label: "用户名", autoClear: false)
                                } : nil,
                                onCopyPassword: (item.password?.isEmpty == false) ? {
                                    store.copySecret(item.password!, label: "密码")
                                } : nil
                            )
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    private var emailInboxList: some View {
        Group {
            if store.emails.isEmpty {
                VStack(spacing: 14) {
                    Image(systemName: "tray")
                        .font(.system(size: 36))
                        .foregroundStyle(.tertiary)
                    Text("暂未收到加密邮箱验证码")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(.secondary)
                    HStack(spacing: 10) {
                        Button {
                            Task { await store.runEmailCronAndAIExtract(forceLatest: true) }
                        } label: {
                            Text(store.isRefreshingEmails ? "正在刷新..." : "刷新收件列表")
                                .padding(.horizontal, 6)
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 32, cornerRadius: 8))
                        .disabled(store.isRefreshingEmails)

                        Button {
                            store.showEmailFilterSheet = true
                        } label: {
                            Text("过滤规则")
                                .padding(.horizontal, 6)
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 32, cornerRadius: 8))
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(Array(store.emails.enumerated()), id: \.element.id) { idx, email in
                            let isSelected = store.selectedEmailId == email.id
                            let nextSelected = idx + 1 < store.emails.count && store.selectedEmailId == store.emails[idx + 1].id
                            EmailRowView(
                                email: email,
                                isSelected: isSelected,
                                showDivider: idx + 1 < store.emails.count && !isSelected && !nextSelected,
                                onSelect: {
                                    store.selectedEmailId = email.id
                                },
                                onDelete: {
                                    Task { await store.deleteEmail(email) }
                                }
                            )
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
        }
        .background(Color(nsColor: .textBackgroundColor))
    }

    // MARK: - Column 3: Detail

    private var detailColumn: some View {
        NavigationStack {
            if store.destination == .emailOtp {
                if let email = store.activeEmail {
                    EmailDetailView(store: store, email: email)
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "envelope.open")
                            .font(.system(size: 44, weight: .regular))
                            .foregroundStyle(Color.secondary.opacity(0.42))
                        Text("未选择任何邮件")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(.secondary)
                        Text("点击左侧加密邮件即可查看提取出的验证码与完整正文。")
                            .font(.system(size: 13))
                            .foregroundStyle(.tertiary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color(nsColor: .textBackgroundColor))
                }
            } else if let item = store.activeItem {
                ItemDetailView(store: store, item: item)
            } else {
                VStack(spacing: 14) {
                    Image(systemName: "key.2.on.ring.fill")
                        .font(.system(size: 50, weight: .regular))
                        .foregroundStyle(Color.secondary.opacity(0.42))
                    Text("未选择任何项目")
                        .font(.system(size: 16, weight: .medium))
                        .foregroundStyle(.secondary)
                    Text("选择左侧项目查看详情，或新建密码条目。")
                        .font(.system(size: 13))
                        .foregroundStyle(.tertiary)
                    Button {
                        openNewEditor(defaultCategoryForCurrentDestination)
                    } label: {
                        Text("新建密码")
                            .padding(.horizontal, 10)
                    }
                    .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 32, cornerRadius: 8))
                    .padding(.top, 2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(nsColor: .textBackgroundColor))
            }
        }
    }

    private var defaultCategoryForCurrentDestination: ItemCategory {
        switch store.destination {
        case .card: return .card
        case .identity: return .identity
        case .secretsAndNotes: return .secureNote
        default: return .login
        }
    }

    private var clipboardToast: some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
            Text(
                store.clipboardRemaining > 0
                    ? "\(store.clipboardStatus) · \(store.clipboardRemaining)s 后清空"
                    : store.clipboardStatus
            )
            .font(.system(size: 12.5, weight: .medium))
            .monospacedDigit()

            if store.clipboardRemaining > 0 {
                Button("立即清空") {
                    store.clearClipboardNow()
                }
                .buttonStyle(.glass)
                .controlSize(.mini)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .glassEffect(.regular, in: .capsule)
        .shadow(color: .black.opacity(0.10), radius: 10, y: 4)
    }

    private func openNewEditor(_ cat: ItemCategory) {
        store.editingItem = nil
        store.editingCategory = cat
        store.showEditor = true
    }
}

private struct CredentialRowView: View {
    let item: VaultItemPayload
    let totp: TotpResult?
    let securityWarning: String?
    let isSelected: Bool
    let showDivider: Bool
    let onSelect: () -> Void
    let onToggleFavorite: () -> Void
    let onEdit: () -> Void
    let onDelete: () -> Void
    let onCopyUsername: (() -> Void)?
    let onCopyPassword: (() -> Void)?

    @State private var isHovered = false

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                SquircleAvatar(
                    title: item.title,
                    category: item.category,
                    urlHint: item.urls.first ?? item.title,
                    size: 32
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(item.title)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    let sub = item.subtitle.trimmingCharacters(in: .whitespacesAndNewlines)
                    Text(sub.isEmpty ? "无用户名" : sub)
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)

                if isHovered {
                    HStack(spacing: 4) {
                        Button(action: onToggleFavorite) {
                            Image(systemName: item.favorite ? "star.fill" : "star")
                                .font(.system(size: 13))
                                .foregroundStyle(item.favorite ? .yellow : .secondary)
                                .frame(width: 24, height: 24)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help(item.favorite ? "取消收藏" : "收藏")

                        Button(action: onDelete) {
                            Image(systemName: "trash")
                                .font(.system(size: 12.5))
                                .foregroundStyle(.secondary)
                                .frame(width: 24, height: 24)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("删除条目")
                    }
                } else if let totp {
                    Text(totp.code)
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundStyle(totp.remainingSeconds <= 5 ? .orange : .secondary)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2.5)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .fill((totp.remainingSeconds <= 5 ? Color.orange : Color.primary).opacity(0.08))
                        )
                } else if let securityWarning {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 19.5))
                        .foregroundStyle(Color(red: 0.91, green: 0.31, blue: 0.27))
                        .help(securityWarning)
                } else if item.favorite {
                    Image(systemName: "star.fill")
                        .font(.system(size: 11))
                        .foregroundStyle(.yellow)
                }
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(
                        isSelected
                            ? Color.primary.opacity(0.09)
                            : (isHovered ? Color.primary.opacity(0.04) : Color.clear)
                    )
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(height: 56)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.primary.opacity(showDivider ? 0.07 : 0))
                .frame(height: 0.5)
                .padding(.leading, 62)
                .padding(.trailing, 14)
        }
        .onHover { hovering in
            isHovered = hovering
        }
        .contextMenu {
            if let onCopyUsername {
                Button("复制用户名", action: onCopyUsername)
            }
            if let onCopyPassword {
                Button("复制密码", action: onCopyPassword)
            }
            Divider()
            Button(item.favorite ? "取消收藏" : "收藏", action: onToggleFavorite)
            Button("编辑…", action: onEdit)
            Divider()
            Button("删除…", role: .destructive, action: onDelete)
        }
    }
}

private struct EmailRowView: View {
    let email: DecryptedEmailPayload
    let isSelected: Bool
    let showDivider: Bool
    let onSelect: () -> Void
    let onDelete: () -> Void

    @State private var isHovered = false

    private var senderTitle: String {
        email.senderDomain.nilIfBlank ?? email.from
    }

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                SquircleAvatar(
                    title: senderTitle,
                    category: .login,
                    urlHint: email.senderDomain.nilIfBlank ?? email.from,
                    size: 32
                )

                VStack(alignment: .leading, spacing: 2) {
                    Text(senderTitle)
                        .font(.system(size: 13.5, weight: .medium))
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    Text(email.subject.nilIfBlank ?? "（无主题）")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 6)

                if isHovered {
                    Button(action: onDelete) {
                        Image(systemName: "trash")
                            .font(.system(size: 12.5))
                            .foregroundStyle(.secondary)
                            .frame(width: 24, height: 24)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("删除邮件")
                } else if let code = email.otpCode?.nilIfBlank {
                    Text(code)
                        .font(.system(size: 11, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color(red: 0.14, green: 0.62, blue: 0.30))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2.5)
                        .background(
                            RoundedRectangle(cornerRadius: 5, style: .continuous)
                                .fill(Color.green.opacity(0.14))
                        )
                }
            }
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(
                        isSelected
                            ? Color.primary.opacity(0.09)
                            : (isHovered ? Color.primary.opacity(0.04) : Color.clear)
                    )
            )
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(height: 56)
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(Color.primary.opacity(showDivider ? 0.07 : 0))
                .frame(height: 0.5)
                .padding(.leading, 62)
                .padding(.trailing, 14)
        }
        .onHover { hovering in
            isHovered = hovering
        }
        .contextMenu {
            Button("删除邮件", role: .destructive, action: onDelete)
        }
    }
}
