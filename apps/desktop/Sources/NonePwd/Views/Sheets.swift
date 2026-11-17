import AppKit
import SwiftUI
import UniformTypeIdentifiers

// MARK: - Item Create / Edit Sheet

public struct ItemEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject public var store: VaultStore
    public let initialItem: VaultItemPayload?
    public let initialCategory: ItemCategory

    @State private var vaultId: String = ""
    @State private var category: ItemCategory = .login
    @State private var title: String = ""
    @State private var username: String = ""
    @State private var password: String = ""
    @State private var totp: String = ""
    @State private var urlsText: String = ""
    @State private var notes: String = ""

    // Card fields
    @State private var cardholderName = ""
    @State private var cardNumber = ""
    @State private var cardExpMonth = ""
    @State private var cardExpYear = ""
    @State private var cardCvv = ""
    @State private var cardBrand = ""

    // Identity fields
    @State private var idFullName = ""
    @State private var idPhone = ""
    @State private var idEmail = ""
    @State private var idCompany = ""
    @State private var idAddress1 = ""
    @State private var idAddress2 = ""
    @State private var idCity = ""
    @State private var idState = ""
    @State private var idPostalCode = ""
    @State private var idCountry = "中国"

    // Groups (multi-tag), API Custom Fields & SSH Key helpers
    @State private var selectedTags: [String] = []
    @State private var inlineGroupInput = ""
    @State private var customFieldsDraft: [CustomField] = []
    @State private var sshPublicKey = ""
    @State private var sshPassphrase = ""

    @State private var showPassword = false
    @State private var busy = false
    @State private var errorMsg: String?

    public init(store: VaultStore, initialItem: VaultItemPayload?, initialCategory: ItemCategory) {
        self.store = store
        self.initialItem = initialItem
        self.initialCategory = initialCategory
    }

    public var body: some View {
        VStack(spacing: 16) {
            VStack(spacing: 10) {
                PasswordsKeyEmblem(category: category, size: 48)

                TextField("标题", text: $title)
                    .textFieldStyle(.plain)
                    .font(.system(size: 19, weight: .semibold))
                    .multilineTextAlignment(.center)

                if initialItem == nil {
                    FullWidthSegmentedTabs(
                        options: [
                            ("登录", ItemCategory.login),
                            ("API", ItemCategory.apiCredential),
                            ("SSH", ItemCategory.sshKey),
                            ("银行卡", ItemCategory.card),
                            ("身份", ItemCategory.identity),
                            ("笔记", ItemCategory.secureNote),
                        ],
                        selection: $category
                    )
                    .padding(.top, 2)
                }
            }

            if let errorMsg {
                Text(errorMsg)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            ScrollView {
                VStack(spacing: 12) {
                    InsetGroupCard {
                        if store.vaults.count > 1 {
                            editorRow(label: "密码库") {
                                Picker("", selection: $vaultId) {
                                    ForEach(store.vaults) { v in
                                        Text(v.metadata.name).tag(v.id)
                                    }
                                }
                                .pickerStyle(.menu)
                                .labelsHidden()
                            }
                            editorDivider
                        }

                        // Multi-group selection row (one item can belong to multiple groups)
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 8) {
                                Text("分组（可多选）")
                                    .font(.system(size: 13))
                                    .foregroundStyle(.primary)
                                Spacer()
                                HStack(spacing: 4) {
                                    TextField("新建分组...", text: $inlineGroupInput)
                                        .textFieldStyle(.plain)
                                        .font(.system(size: 12))
                                        .multilineTextAlignment(.trailing)
                                        .frame(width: 100)
                                        .onSubmit { addInlineGroup() }
                                    Button {
                                        addInlineGroup()
                                    } label: {
                                        Image(systemName: "plus.circle.fill")
                                            .font(.system(size: 13))
                                            .foregroundStyle(
                                                inlineGroupInput.trimmingCharacters(in: .whitespaces).isEmpty
                                                    ? Color.secondary.opacity(0.4)
                                                    : Color.accentColor
                                            )
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(inlineGroupInput.trimmingCharacters(in: .whitespaces).isEmpty)
                                }
                            }

                            let candidateGroups = mergedCandidateGroups
                            if !candidateGroups.isEmpty {
                                ScrollView(.horizontal, showsIndicators: false) {
                                    HStack(spacing: 6) {
                                        ForEach(candidateGroups, id: \.self) { groupName in
                                            let active = selectedTags.contains {
                                                $0.caseInsensitiveCompare(groupName) == .orderedSame
                                            }
                                            Button {
                                                toggleTag(groupName)
                                            } label: {
                                                HStack(spacing: 4) {
                                                    if active {
                                                        Image(systemName: "checkmark")
                                                            .font(.system(size: 10, weight: .semibold))
                                                    }
                                                    Text(groupName)
                                                        .font(.system(size: 11.5))
                                                }
                                                .foregroundStyle(active ? Color.white : Color.primary)
                                                .padding(.horizontal, 9)
                                                .padding(.vertical, 4)
                                                .background(
                                                    Capsule()
                                                        .fill(active ? Color.accentColor : Color.primary.opacity(0.08))
                                                )
                                            }
                                            .buttonStyle(.plain)
                                        }
                                    }
                                }
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 9)
                        editorDivider

                        if category == .card {
                            editorRow(label: "持卡人") {
                                TextField("姓名", text: $cardholderName)
                            }
                            editorDivider
                            editorRow(label: "卡号") {
                                TextField("•••• •••• •••• ••••", text: $cardNumber)
                            }
                            editorDivider
                            editorRow(label: "有效期") {
                                HStack(spacing: 6) {
                                    TextField("MM", text: $cardExpMonth)
                                        .frame(width: 34)
                                    Text("/")
                                        .foregroundStyle(.tertiary)
                                    TextField("YYYY", text: $cardExpYear)
                                        .frame(width: 48)
                                }
                            }
                            editorDivider
                            editorRow(label: "安全码") {
                                SecureField("CVV", text: $cardCvv)
                            }
                            editorDivider
                            editorRow(label: "卡组织") {
                                TextField("Visa / 银联", text: $cardBrand)
                            }
                        } else if category == .identity {
                            editorRow(label: "姓名") {
                                TextField("全名", text: $idFullName)
                            }
                            editorDivider
                            editorRow(label: "手机") {
                                TextField("联系电话", text: $idPhone)
                            }
                            editorDivider
                            editorRow(label: "邮箱") {
                                TextField("name@example.com", text: $idEmail)
                            }
                            editorDivider
                            editorRow(label: "公司") {
                                TextField("公司 / 机构", text: $idCompany)
                            }
                            editorDivider
                            editorRow(label: "街道") {
                                TextField("街道详细地址", text: $idAddress1)
                            }
                            editorDivider
                            editorRow(label: "门牌") {
                                TextField("楼栋 / 门牌", text: $idAddress2)
                            }
                            editorDivider
                            editorRow(label: "城市") {
                                HStack(spacing: 6) {
                                    TextField("城市", text: $idCity)
                                        .frame(width: 84)
                                    Text("·")
                                        .foregroundStyle(.tertiary)
                                    TextField("省 / 州", text: $idState)
                                        .frame(width: 84)
                                }
                            }
                            editorDivider
                            editorRow(label: "邮编") {
                                HStack(spacing: 6) {
                                    TextField("邮政编码", text: $idPostalCode)
                                        .frame(width: 84)
                                    Text("·")
                                        .foregroundStyle(.tertiary)
                                    TextField("国家", text: $idCountry)
                                        .frame(width: 68)
                                }
                            }
                        } else if category == .sshKey {
                            HStack(spacing: 8) {
                                Text("SSH 密钥对")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button {
                                    generateEd25519Keypair()
                                } label: {
                                    Label("一键生成 Ed25519", systemImage: "wand.and.stars")
                                        .font(.system(size: 11.5))
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(Color.accentColor)

                                Button {
                                    importSshKeyFile()
                                } label: {
                                    Label("导入密钥文件…", systemImage: "folder")
                                        .font(.system(size: 11.5))
                                }
                                .buttonStyle(.plain)
                                .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            editorDivider

                            editorRow(label: "公钥") {
                                TextField("ssh-ed25519 AAAA...", text: $sshPublicKey)
                                    .font(.system(size: 12, design: .monospaced))
                            }
                            editorDivider

                            VStack(alignment: .leading, spacing: 4) {
                                Text("私钥 (Private Key)")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.secondary)
                                ZStack(alignment: .topLeading) {
                                    if password.isEmpty {
                                        Text("-----BEGIN OPENSSH PRIVATE KEY-----")
                                            .font(.system(size: 11.5, design: .monospaced))
                                            .foregroundStyle(.tertiary)
                                            .padding(.top, 3)
                                            .padding(.leading, 4)
                                    }
                                    TextEditor(text: $password)
                                        .scrollContentBackground(.hidden)
                                        .font(.system(size: 11.5, design: .monospaced))
                                        .frame(height: 92)
                                }
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            editorDivider

                            editorRow(label: "私钥口令") {
                                SecureField("选填 Passphrase", text: $sshPassphrase)
                                    .font(.system(size: 13, design: .monospaced))
                            }
                            editorDivider

                            editorRow(label: "主机 / Git") {
                                TextField("github.com / ssh://root@host", text: $urlsText)
                            }
                        } else {
                            editorRow(label: category == .apiCredential ? "凭证标识" : "用户名") {
                                TextField(category == .apiCredential ? "org-xxx / AccessKey ID / 账号" : "用户", text: $username)
                            }
                            editorDivider
                            editorRow(label: category == .login ? "密码" : (category == .apiCredential ? "API Key" : "密钥")) {
                                HStack(spacing: 8) {
                                    Group {
                                        if showPassword {
                                            TextField("必填或点击生成", text: $password)
                                                .font(.system(size: 13, design: .monospaced))
                                        } else {
                                            SecureField("••••••••••••", text: $password)
                                                .font(.system(size: 13, design: .monospaced))
                                        }
                                    }
                                    Button {
                                        showPassword.toggle()
                                    } label: {
                                        Image(systemName: showPassword ? "eye.slash" : "eye")
                                            .font(.system(size: 12.5, weight: .regular))
                                            .foregroundStyle(.secondary)
                                    }
                                    .buttonStyle(.plain)
                                    .help(showPassword ? "隐藏" : "显示")

                                    Button {
                                        if let pw = try? NpCoreBridge.generatePassword(length: category == .apiCredential ? 32 : 20) {
                                            password = pw
                                            showPassword = true
                                        }
                                    } label: {
                                        Image(systemName: "wand.and.stars")
                                            .font(.system(size: 12.5, weight: .regular))
                                            .foregroundStyle(Color.accentColor)
                                    }
                                    .buttonStyle(.plain)
                                    .help("生成随机强密钥")
                                }
                            }
                            editorDivider
                            editorRow(label: category == .apiCredential ? "Endpoint" : "网站") {
                                TextField(category == .apiCredential ? "https://api.openai.com/v1" : "example.com", text: $urlsText)
                            }
                            if category == .login {
                                editorDivider
                                editorRow(label: "验证码") {
                                    TextField("选填 TOTP / otpauth://", text: $totp)
                                }
                            }
                        }

                        editorDivider

                        ZStack(alignment: .topLeading) {
                            if notes.isEmpty {
                                Text("备注")
                                    .font(.system(size: 13))
                                    .foregroundStyle(.tertiary)
                                    .padding(.top, 2)
                                    .padding(.leading, 4)
                            }
                            TextEditor(text: $notes)
                                .scrollContentBackground(.hidden)
                                .font(.system(size: 13))
                                .frame(height: 62)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 8)
                    }

                    if category == .apiCredential || !customFieldsDraft.isEmpty {
                        InsetGroupCard(header: "扩展键值字段（可用于 np:// / op:// 引用）") {
                            VStack(spacing: 0) {
                                ForEach(Array(customFieldsDraft.enumerated()), id: \.element.id) { idx, _ in
                                    if idx > 0 { editorDivider }
                                    HStack(spacing: 8) {
                                        TextField("字段名（如 org_id）", text: $customFieldsDraft[idx].label)
                                            .textFieldStyle(.plain)
                                            .font(.system(size: 12.5, design: .monospaced))
                                            .frame(width: 125)
                                        Divider().frame(height: 16)
                                        TextField("值", text: $customFieldsDraft[idx].value)
                                            .textFieldStyle(.plain)
                                            .font(.system(size: 12.5, design: .monospaced))
                                        Button {
                                            let cur = customFieldsDraft[idx].fieldType
                                            customFieldsDraft[idx].fieldType = cur == "concealed" ? "text" : "concealed"
                                        } label: {
                                            Image(systemName: customFieldsDraft[idx].fieldType == "concealed" ? "lock.fill" : "text.alignleft")
                                                .font(.system(size: 11))
                                                .foregroundStyle(.secondary)
                                        }
                                        .buttonStyle(.plain)
                                        .help(customFieldsDraft[idx].fieldType == "concealed" ? "敏感字段" : "明文字段")

                                        Button {
                                            customFieldsDraft.remove(at: idx)
                                        } label: {
                                            Image(systemName: "minus.circle")
                                                .font(.system(size: 12))
                                                .foregroundStyle(.secondary)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                    .padding(.horizontal, 14)
                                    .frame(height: 36)
                                }
                                if !customFieldsDraft.isEmpty { editorDivider }
                                Button {
                                    let newId = (try? NpCoreBridge.randomID()) ?? UUID().uuidString
                                    customFieldsDraft.append(CustomField(id: newId, label: "", value: "", fieldType: "concealed"))
                                } label: {
                                    Label("添加自定义字段", systemImage: "plus.circle")
                                        .font(.system(size: 12.5))
                                        .foregroundStyle(Color.accentColor)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                        .padding(.horizontal, 14)
                                        .frame(height: 34)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
            }
            .frame(maxHeight: 450)

            HStack(spacing: 10) {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Text("取消")
                        .frame(minWidth: 46)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 30, cornerRadius: 8))
                .keyboardShortcut(.cancelAction)

                Button {
                    Task { await save() }
                } label: {
                    Text(busy ? "保存中..." : "保存")
                        .frame(minWidth: 46)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 30, cornerRadius: 8))
                .keyboardShortcut(.defaultAction)
                .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.horizontal, 22)
        .padding(.top, 22)
        .padding(.bottom, 16)
        .frame(width: 480)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { populate() }
    }

    private var mergedCandidateGroups: [String] {
        var seen: [String: String] = [:]
        for g in store.allGroups + selectedTags {
            let trimmed = g.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let key = trimmed.lowercased()
            if seen[key] == nil { seen[key] = trimmed }
        }
        return seen.values.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    private func toggleTag(_ name: String) {
        if selectedTags.contains(where: { $0.caseInsensitiveCompare(name) == .orderedSame }) {
            selectedTags.removeAll { $0.caseInsensitiveCompare(name) == .orderedSame }
        } else {
            selectedTags.append(name)
        }
    }

    private func addInlineGroup() {
        let trimmed = inlineGroupInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        inlineGroupInput = ""
        store.addGroup(trimmed)
        if !selectedTags.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            selectedTags.append(trimmed)
        }
    }

    private func generateEd25519Keypair() {
        errorMsg = nil
        let tmpDir = FileManager.default.temporaryDirectory
        let keyURL = tmpDir.appendingPathComponent("np-ed25519-\(UUID().uuidString)")
        let pubURL = URL(fileURLWithPath: keyURL.path + ".pub")
        defer {
            try? FileManager.default.removeItem(at: keyURL)
            try? FileManager.default.removeItem(at: pubURL)
        }

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/ssh-keygen")
        let comment = title.nilIfBlank ?? store.accountEmail.nilIfBlank ?? "nonepwd"
        proc.arguments = ["-t", "ed25519", "-N", "", "-C", comment, "-f", keyURL.path]
        do {
            try proc.run()
            proc.waitUntilExit()
            guard proc.terminationStatus == 0 else {
                errorMsg = "ssh-keygen 生成密钥对失败"
                return
            }
            password = (try? String(contentsOf: keyURL, encoding: .utf8)) ?? ""
            sshPublicKey = ((try? String(contentsOf: pubURL, encoding: .utf8)) ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
        } catch {
            errorMsg = "调用 ssh-keygen 失败: \(error.localizedDescription)"
        }
    }

    private func importSshKeyFile() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.showsHiddenFiles = true
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ssh")
        if panel.runModal() == .OK, let url = panel.url {
            do {
                let text = try String(contentsOf: url, encoding: .utf8)
                if url.pathExtension.lowercased() == "pub" {
                    sshPublicKey = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    let privURL = url.deletingPathExtension()
                    if let privText = try? String(contentsOf: privURL, encoding: .utf8) {
                        password = privText
                    }
                } else {
                    password = text
                    let pubURL = URL(fileURLWithPath: url.path + ".pub")
                    if let pubText = try? String(contentsOf: pubURL, encoding: .utf8) {
                        sshPublicKey = pubText.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                }
                if title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    title = url.deletingPathExtension().lastPathComponent
                }
            } catch {
                errorMsg = "读取密钥文件失败: \(error.localizedDescription)"
            }
        }
    }

    private var editorDivider: some View {
        Divider().padding(.leading, 14)
    }

    private func editorRow<Field: View>(label: String, @ViewBuilder field: () -> Field) -> some View {
        HStack(spacing: 12) {
            Text(label)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: true, vertical: false)
            Spacer(minLength: 8)
            field()
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .multilineTextAlignment(.trailing)
        }
        .padding(.horizontal, 14)
        .frame(height: 38)
    }

    private func populate() {
        if let item = initialItem {
            vaultId = item.vaultId
            category = item.category
            title = item.title
            selectedTags = item.tags
            username = item.username ?? ""
            password = item.password ?? ""
            totp = item.totp ?? ""
            urlsText = item.urls.joined(separator: ", ")
            notes = item.notes ?? ""
            if item.category == .sshKey {
                sshPublicKey = item.customFields.first(where: { $0.label.caseInsensitiveCompare("public_key") == .orderedSame })?.value ?? ""
                sshPassphrase = item.customFields.first(where: { $0.label.caseInsensitiveCompare("passphrase") == .orderedSame })?.value ?? ""
                customFieldsDraft = item.customFields.filter {
                    $0.label.caseInsensitiveCompare("public_key") != .orderedSame &&
                    $0.label.caseInsensitiveCompare("passphrase") != .orderedSame
                }
            } else {
                customFieldsDraft = item.customFields
            }
            if let card = item.card {
                cardholderName = card.cardholderName ?? ""
                cardNumber = card.number ?? ""
                cardExpMonth = card.expMonth ?? ""
                cardExpYear = card.expYear ?? ""
                cardCvv = card.cvv ?? ""
                cardBrand = card.brand ?? ""
            }
            if let id = item.identity {
                idFullName = id.fullName ?? id.displayName
                idPhone = id.phone ?? ""
                idEmail = id.email ?? ""
                idCompany = id.company ?? ""
                idAddress1 = id.address1 ?? ""
                idAddress2 = id.address2 ?? ""
                idCity = id.city ?? ""
                idState = id.state ?? ""
                idPostalCode = id.postalCode ?? ""
                idCountry = id.country ?? "中国"
            }
        } else {
            category = initialCategory
            if case .vault(let vid) = store.destination {
                vaultId = vid
            } else {
                vaultId = store.vaults.first?.id ?? ""
            }
            if case .group(let g) = store.destination {
                selectedTags = [g]
            } else {
                selectedTags = []
            }
        }
    }

    private func save() async {
        guard !vaultId.isEmpty else { return }
        busy = true
        errorMsg = nil
        defer { busy = false }

        do {
            let itemId = try initialItem?.id ?? NpCoreBridge.randomID()
            let now = ISO8601DateFormatter().string(from: Date())
            let urls = urlsText
                .split(whereSeparator: { $0 == "," || $0 == "\n" })
                .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            for g in selectedTags {
                store.addGroup(g)
            }

            var finalCustomFields = customFieldsDraft.filter {
                !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty &&
                !$0.value.isEmpty
            }

            if category == .sshKey {
                if let pub = sshPublicKey.nilIfBlank {
                    let pubId = (try? NpCoreBridge.randomID()) ?? UUID().uuidString
                    finalCustomFields.append(CustomField(id: pubId, label: "public_key", value: pub, fieldType: "text"))
                }
                if let pass = sshPassphrase.nilIfBlank {
                    let passId = (try? NpCoreBridge.randomID()) ?? UUID().uuidString
                    finalCustomFields.append(CustomField(id: passId, label: "passphrase", value: pass, fieldType: "concealed"))
                }
            }

            let cardObj: CardDetails? = category == .card ? CardDetails(
                cardholderName: cardholderName.nilIfBlank,
                number: cardNumber.nilIfBlank,
                expMonth: cardExpMonth.nilIfBlank,
                expYear: cardExpYear.nilIfBlank,
                cvv: cardCvv.nilIfBlank,
                brand: cardBrand.nilIfBlank
            ) : initialItem?.card

            let idObj: IdentityDetails? = category == .identity ? IdentityDetails(
                fullName: idFullName.nilIfBlank,
                email: idEmail.nilIfBlank,
                phone: idPhone.nilIfBlank,
                company: idCompany.nilIfBlank,
                address1: idAddress1.nilIfBlank,
                address2: idAddress2.nilIfBlank,
                city: idCity.nilIfBlank,
                state: idState.nilIfBlank,
                postalCode: idPostalCode.nilIfBlank,
                country: idCountry.nilIfBlank
            ) : initialItem?.identity

            let keepUser = category == .login || category == .apiCredential || category == .sshKey || category == .secureNote
            let payload = VaultItemPayload(
                id: itemId,
                vaultId: vaultId,
                category: category,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                favorite: initialItem?.favorite ?? false,
                tags: selectedTags,
                urls: urls,
                username: keepUser ? username.nilIfBlank : nil,
                password: category == .card || category == .identity ? nil : (password.isEmpty ? nil : password),
                totp: totp.nilIfBlank,
                emailAlias: initialItem?.emailAlias,
                notes: notes.nilIfBlank,
                card: cardObj,
                identity: idObj,
                customFields: finalCustomFields,
                createdAt: initialItem?.createdAt ?? now,
                updatedAt: now
            )
            try await store.saveItem(payload, isNew: initialItem == nil)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Import CSV / 2FA Sheet

public struct ImportSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject public var store: VaultStore

    @State private var vaultId: String = ""
    @State private var fileName: String?
    @State private var rawText: String = ""
    @State private var skipDuplicates = true
    @State private var busy = false
    @State private var errorMsg: String?
    @State private var previewLines: [String] = []
    @State private var detectedType: String?
    @State private var result: VaultStore.ImportSummary?

    public var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text("导入浏览器密码 / 2FA 验证器")
                    .font(.system(size: 16, weight: .semibold))
                Spacer()
                Button("关闭") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 14)

            Divider()

            VStack(alignment: .leading, spacing: 14) {
                Text("支持 Brave / Chrome CSV，以及 otpauth://、Google otpauth-migration://、2FAS / Aegis 文件；全部在本地 Rust 核心解析与加密。")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)

                if let errorMsg {
                    Text(errorMsg).font(.system(size: 12)).foregroundStyle(.red)
                }

                if let result {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 30))
                            .foregroundStyle(.green)
                        Text("导入完成（共识别 \(result.total) 条）")
                            .font(.system(size: 14, weight: .semibold))
                        Text("新建 \(result.created) 条 · 合并绑定 2FA \(result.attached) 条 · 跳过重复 \(result.skipped) 条")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(24)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color(nsColor: .controlBackgroundColor)))
                } else {
                    HStack {
                        Picker("目标密码库", selection: $vaultId) {
                            ForEach(store.vaults) { v in
                                Text(v.metadata.name).tag(v.id)
                            }
                        }
                        Spacer()
                        Button("选择 .csv / .txt / .json 文件...") {
                            chooseFile()
                        }
                        .buttonStyle(.borderedProminent)
                    }

                    if let fileName {
                        Text("已读取：\(fileName) · 识别类型：\(detectedType == "totp" ? "2FA 验证器导出" : "浏览器密码 CSV")")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(.green)
                    }

                    TextEditor(text: $rawText)
                        .font(.system(size: 11.5, design: .monospaced))
                        .frame(height: 110)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8)
                                .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 0.75)
                        )
                        .onChange(of: rawText) { _, newValue in
                            parsePreview(newValue)
                        }

                    if !previewLines.isEmpty {
                        InsetGroupCard(header: "预览（共 \(previewLines.count) 条，敏感内容已遮罩）") {
                            ForEach(Array(previewLines.prefix(4).enumerated()), id: \.offset) { idx, line in
                                if idx > 0 { Divider().padding(.leading, 12) }
                                Text(line)
                                    .font(.system(size: 12))
                                    .padding(.horizontal, 12)
                                    .padding(.vertical, 7)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    Toggle("自动跳过重复条目", isOn: $skipDuplicates)
                        .font(.system(size: 12))

                    HStack {
                        Spacer()
                        Button {
                            Task { await performImport() }
                        } label: {
                            Text(busy ? "加密导入中..." : "开始本地加密导入")
                        }
                        .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 30, cornerRadius: 8))
                        .disabled(busy || rawText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || previewLines.isEmpty)
                    }
                }
            }
            .padding(20)
        }
        .frame(width: 520)
        .onAppear {
            if case .vault(let vid) = store.destination {
                vaultId = vid
            } else {
                vaultId = store.vaults.first(where: { $0.metadata.name.lowercased() == "personal" })?.id
                    ?? store.vaults.first?.id ?? ""
            }
        }
    }

    private func chooseFile() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.commaSeparatedText, .plainText, .json]
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        if panel.runModal() == .OK, let url = panel.url,
           let content = try? String(contentsOf: url, encoding: .utf8)
        {
            fileName = url.lastPathComponent
            rawText = content
            parsePreview(content)
        }
    }

    private func parsePreview(_ text: String) {
        errorMsg = nil
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            previewLines = []
            detectedType = nil
            return
        }
        do {
            let fmt = try NpCoreBridge.detectImportFormat(text)
            detectedType = fmt
            if fmt == "totp" {
                let entries = try NpCoreBridge.parseAuthenticatorExport(text)
                previewLines = entries.map {
                    "\($0.issuer ?? "未命名") · \($0.account ?? "2FA") · ••••••"
                }
            } else {
                let entries = try NpCoreBridge.parsePasswordCSV(text)
                previewLines = entries.map {
                    "\($0.title) · \($0.username ?? $0.urls.first ?? "—") · ••••••"
                }
            }
        } catch {
            previewLines = []
            errorMsg = error.localizedDescription
        }
    }

    private func performImport() async {
        guard !vaultId.isEmpty else { return }
        busy = true
        errorMsg = nil
        defer { busy = false }
        do {
            result = try await store.importText(rawText, vaultId: vaultId, skipDuplicates: skipDuplicates)
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Email Regex Filter Sheet + OpenAI Compatible AI Generator

public struct EmailFilterSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject public var store: VaultStore

    @State private var draft = EmailFilterConfig()
    @State private var sampleText = "Your GitHub verification code is 849201"
    @State private var aiPrompt = ""
    @State private var aiSummary: String?
    @State private var showAIConfig = false
    @State private var aiGenerating = false
    @State private var busy = false
    @State private var errorMsg: String?

    public var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(Color(red: 0.22, green: 0.61, blue: 0.90).opacity(0.14))
                        .frame(width: 40, height: 40)
                    Image(systemName: "sparkles")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundStyle(Color(red: 0.22, green: 0.61, blue: 0.90))
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("邮箱接收过滤")
                        .font(.system(size: 17, weight: .semibold))
                    Text("支持用 AI 根据自然语言自动生成正则规则")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            if let errorMsg {
                Text(errorMsg)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.08)))
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // AI Assistant Card
                    InsetGroupCard(header: "AI 自然语言生成规则") {
                        VStack(alignment: .leading, spacing: 10) {
                            BorderlessInputField(
                                "描述需求，如：只接收 GitHub、Google 和银行的登录验证码邮件",
                                text: $aiPrompt
                            ) {
                                Task { await runAI() }
                            }

                            HStack(spacing: 10) {
                                Button {
                                    withAnimation(.snappy(duration: 0.2)) {
                                        showAIConfig.toggle()
                                    }
                                } label: {
                                    Label(
                                        showAIConfig ? "收起接口设置" : "OpenAI 接口配置",
                                        systemImage: "slider.horizontal.3"
                                    )
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundStyle(.secondary)
                                }
                                .buttonStyle(.plain)

                                Spacer()

                                Button {
                                    Task { await runAI() }
                                } label: {
                                    HStack(spacing: 6) {
                                        if aiGenerating {
                                            ProgressView().controlSize(.small)
                                        } else {
                                            Image(systemName: "sparkles")
                                        }
                                        Text(aiGenerating ? "生成中..." : "AI 生成规则")
                                    }
                                }
                                .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 30, cornerRadius: 8))
                                .disabled(aiGenerating || aiPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                            }

                            if let aiSummary {
                                Text("✨ \(aiSummary)")
                                    .font(.system(size: 12))
                                    .foregroundStyle(Color(red: 0.14, green: 0.62, blue: 0.30))
                            }

                            if showAIConfig {
                                Divider()
                                VStack(spacing: 8) {
                                    BorderlessInputField(
                                        "Base URL (如 https://api.openai.com/v1)",
                                        text: $store.aiBaseURL,
                                        isMonospaced: true
                                    )
                                    BorderlessInputField(
                                        "API Key (sk-...)",
                                        text: $store.aiApiKey,
                                        isSecure: true,
                                        isMonospaced: true
                                    )
                                    HStack(spacing: 8) {
                                        BorderlessInputField(
                                            "Model (如 gpt-4o-mini / deepseek-chat)",
                                            text: $store.aiModel,
                                            isMonospaced: true
                                        )
                                        Button("保存配置") {
                                            store.saveAISettings()
                                            aiSummary = "AI 接口配置已保存到本地。"
                                        }
                                        .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 36, cornerRadius: 9))
                                    }
                                }
                                .padding(.top, 2)
                            }
                        }
                        .padding(14)
                    }

                    // Active Rules & Policy Card
                    InsetGroupCard(header: "过滤策略与正则规则") {
                        VStack(alignment: .leading, spacing: 10) {
                            Toggle("启用收件过滤规则（不匹配的邮件不入库）", isOn: $draft.enabled)
                                .font(.system(size: 13))
                            Toggle("仅保留包含数字验证码的邮件 (OTP Only)", isOn: $draft.otpOnly)
                                .font(.system(size: 13))
                            Toggle("新邮件自动使用 AI 提取验证码", isOn: $store.aiAutoExtractEmail)
                                .font(.system(size: 13))

                            FullWidthSegmentedTabs(
                                options: [
                                    ("白名单（仅允许）", EmailFilterMode.allow),
                                    ("黑名单（拦截）", EmailFilterMode.deny),
                                ],
                                selection: $draft.mode
                            )

                            if !draft.rules.isEmpty {
                                Divider()
                                ForEach($draft.rules) { $rule in
                                    HStack(spacing: 8) {
                                        Toggle("", isOn: $rule.enabled)
                                            .labelsHidden()
                                        Picker("", selection: $rule.field) {
                                            ForEach(EmailFilterField.allCases, id: \.self) { f in
                                                Text(f.label).tag(f)
                                            }
                                        }
                                        .frame(width: 136)

                                        BorderlessInputField(
                                            "正则表达式 (如 github|google|验证码)",
                                            text: $rule.pattern,
                                            isMonospaced: true
                                        )

                                        if !isValidRegex(rule.pattern) {
                                            Image(systemName: "exclamationmark.circle.fill")
                                                .foregroundStyle(.red)
                                                .help("正则表达式语法错误")
                                        }

                                        Button(role: .destructive) {
                                            draft.rules.removeAll { $0.id == rule.id }
                                        } label: {
                                            Image(systemName: "minus.circle")
                                                .font(.system(size: 14))
                                                .foregroundStyle(.secondary)
                                        }
                                        .buttonStyle(.plain)
                                    }
                                }
                            }

                            Button {
                                draft.rules.append(EmailFilterRule())
                            } label: {
                                Label("手动添加一条规则", systemImage: "plus.circle")
                                    .font(.system(size: 12.5, weight: .medium))
                            }
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.accentColor)
                            .padding(.top, 2)
                        }
                        .padding(14)
                    }

                    // Live Tester
                    InsetGroupCard(header: "实时正则测试") {
                        VStack(alignment: .leading, spacing: 8) {
                            BorderlessInputField("输入测试发件人、主题或正文...", text: $sampleText, isMonospaced: true)
                            Text(testEvaluationText)
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                        .padding(14)
                    }
                }
            }

            HStack(spacing: 10) {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Text("取消")
                        .frame(minWidth: 46)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 30, cornerRadius: 8))
                .keyboardShortcut(.cancelAction)

                Button {
                    Task { await save() }
                } label: {
                    Text(busy ? "保存中..." : "保存")
                        .frame(minWidth: 46)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 30, cornerRadius: 8))
                .keyboardShortcut(.defaultAction)
                .disabled(busy || hasInvalidRegex)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
        .frame(width: 560, height: 640)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            draft = store.emailFilter
            if store.aiApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                showAIConfig = true
            }
            Task { try? await store.loadEmailFilter(); draft = store.emailFilter }
        }
    }

    private func runAI() async {
        aiGenerating = true
        errorMsg = nil
        aiSummary = nil
        defer { aiGenerating = false }
        do {
            let res = try await store.generateEmailFilterWithAI(prompt: aiPrompt, current: draft)
            draft = res.config
            aiSummary = res.summary
            showAIConfig = false
        } catch {
            errorMsg = error.localizedDescription
            if store.aiApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                showAIConfig = true
            }
        }
    }

    private var hasInvalidRegex: Bool {
        draft.rules.contains { !$0.pattern.isEmpty && !isValidRegex($0.pattern) }
    }

    private func isValidRegex(_ pat: String) -> Bool {
        guard !pat.isEmpty else { return true }
        return (try? NSRegularExpression(pattern: pat, options: [.caseInsensitive])) != nil
    }

    private var testEvaluationText: String {
        let active = draft.rules.filter { $0.enabled && !$0.pattern.isEmpty }
        if active.isEmpty { return "当前无启用规则。" }
        let matched = active.contains { rule in
            guard let re = try? NSRegularExpression(pattern: rule.pattern, options: [.caseInsensitive]) else { return false }
            let range = NSRange(sampleText.startIndex..., in: sampleText)
            return re.firstMatch(in: sampleText, range: range) != nil
        }
        if draft.mode == .allow {
            return matched ? "白名单测试结果：匹配 ✓（将接收并密封）" : "白名单测试结果：未命中 ✗（将被丢弃）"
        }
        return matched ? "黑名单测试结果：命中拦截规则 ✗（将被丢弃）" : "黑名单测试结果：未命中拦截 ✓（将接收并密封）"
    }

    private func save() async {
        busy = true
        errorMsg = nil
        defer { busy = false }
        do {
            var clean = draft
            clean.rules = draft.rules.filter { !$0.pattern.trimmingCharacters(in: .whitespaces).isEmpty }
            try await store.saveEmailFilter(clean)
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}

// MARK: - Browser Extension Pairing Sheet

public struct BrowserExtensionSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject public var store: VaultStore

    @State private var syncedDir: URL?
    @State private var openStatus: String?

    private var extensionDirectory: URL? {
        if let syncedDir { return syncedDir }
        let fm = FileManager.default
        let appSupportExt = PrefsStore.appSupportDir.appendingPathComponent("browser-extension", isDirectory: true)
        if fm.fileExists(atPath: appSupportExt.appendingPathComponent("manifest.json").path) {
            return appSupportExt
        }
        if let bundled = Bundle.main.resourceURL?.appendingPathComponent("browser-extension", isDirectory: true),
           fm.fileExists(atPath: bundled.appendingPathComponent("manifest.json").path)
        {
            return bundled
        }
        return nil
    }

    public var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 8) {
                PasswordsKeyEmblem(category: .login, size: 52)

                Text("浏览器自动填充扩展")
                    .font(.system(size: 18, weight: .semibold))

                Text("扩展文件已内置到桌面端应用目录，可直接加载到 Chrome、Brave、Edge")
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            InsetGroupCard {
                if let dir = extensionDirectory {
                    CopyableFieldRow(
                        label: "扩展目录",
                        value: dir.path,
                        isMonospaced: true
                    ) {
                        store.copySecret(dir.path, label: "扩展目录路径", autoClear: false)
                    }

                    Divider().padding(.leading, 14)
                }

                CopyableFieldRow(
                    label: "本地服务端",
                    value: store.serverURL,
                    isMonospaced: true
                ) {
                    store.copySecret(store.serverURL, label: "服务端地址", autoClear: false)
                }

                Divider().padding(.leading, 14)

                CopyableFieldRow(
                    label: "Secret Key",
                    value: store.secretKey,
                    isSecret: true,
                    isMonospaced: true,
                    revealedByDefault: false
                ) {
                    store.copySecret(store.secretKey, label: "Secret Key")
                }

                Divider().padding(.leading, 14)

                VStack(alignment: .leading, spacing: 6) {
                    Text("加载方式（首次登录新网站可自动提示保存密码）")
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundStyle(.primary)
                    Text("1. 点击右下角在 Finder 打开目录（或先复制上方扩展路径）")
                    Text("2. 浏览器打开 chrome://extensions 并开启右上角「开发者模式」")
                    Text("3. 点击「加载已解压的扩展程序」，按 ⌘⇧G 粘贴目录选择即可")
                }
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
            }

            if let openStatus {
                Text(openStatus)
                    .font(.system(size: 12))
                    .foregroundStyle(.orange)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            HStack(spacing: 10) {
                Spacer()
                Button {
                    dismiss()
                } label: {
                    Text("关闭")
                        .frame(minWidth: 46)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 30, cornerRadius: 8))
                .keyboardShortcut(.cancelAction)

                Button {
                    if let url = extensionDirectory {
                        NSWorkspace.shared.activateFileViewerSelecting([url])
                    } else {
                        openStatus = "未找到内置扩展目录，请重新打包应用。"
                    }
                } label: {
                    Text("在 Finder 中打开扩展目录")
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 30, cornerRadius: 8))
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
        .frame(width: 470)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            syncedDir = PrefsStore.syncBundledBrowserExtension()
        }
    }
}

// MARK: - IMAP & Email Routing Configuration Sheet

public struct ImapSettingsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject public var store: VaultStore

    @State private var enabled = false
    @State private var host = ""
    @State private var portText = "993"
    @State private var tls = true
    @State private var username = ""
    @State private var password = ""
    @State private var testing = false
    @State private var saving = false
    @State private var testMsg: String?
    @State private var testSuccess = false
    @State private var errorMsg: String?
    @State private var loadedInitial = false

    private let presets: [(label: String, host: String, port: String)] = [
        ("QQ 邮箱", "imap.qq.com", "993"),
        ("Gmail", "imap.gmail.com", "993"),
        ("163 邮箱", "imap.163.com", "993"),
        ("iCloud", "imap.mail.me.com", "993"),
        ("Outlook", "outlook.office365.com", "993"),
    ]

    private var statusBadge: (text: String, color: Color) {
        switch store.imapConfig.status {
        case "listening":
            return ("监听/同步中", Color(red: 0.14, green: 0.62, blue: 0.30))
        case "connecting":
            return ("连接中", .orange)
        case "error":
            return ("连接异常", .red)
        default:
            return ("未启用", .secondary)
        }
    }

    public var body: some View {
        VStack(spacing: 16) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(Color.accentColor.opacity(0.14))
                        .frame(width: 40, height: 40)
                    Image(systemName: "tray.full.fill")
                        .font(.system(size: 18, weight: .medium))
                        .foregroundStyle(Color.accentColor)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text("邮箱收信配置 (IMAP & 域名路由)")
                        .font(.system(size: 17, weight: .medium))
                    Text("拉取主力邮箱验证码（需填邮箱授权码，非登录密码）")
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Text(statusBadge.text)
                    .font(.system(size: 11, weight: .medium))
                    .foregroundStyle(statusBadge.color)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(
                        Capsule()
                            .fill(statusBadge.color.opacity(0.12))
                    )
            }

            if let errorMsg {
                Text(errorMsg)
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.08)))
            } else if let testMsg {
                Text(testMsg)
                    .font(.system(size: 12))
                    .foregroundStyle(testSuccess ? Color(red: 0.14, green: 0.62, blue: 0.30) : .red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(
                        RoundedRectangle(cornerRadius: 10)
                            .fill((testSuccess ? Color.green : Color.red).opacity(0.08))
                    )
            } else if let lastErr = store.imapConfig.lastError?.nilIfBlank {
                Text("最近错误：\(lastErr)")
                    .font(.system(size: 12))
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color.red.opacity(0.08)))
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    InsetGroupCard(header: "IMAP 自动收信设置") {
                        VStack(alignment: .leading, spacing: 12) {
                            Toggle("启用 IMAP 自动收信", isOn: $enabled)
                                .font(.system(size: 13))

                            HStack(spacing: 6) {
                                Text("常用预设:")
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(.secondary)
                                ForEach(presets, id: \.label) { preset in
                                    Button {
                                        host = preset.host
                                        portText = preset.port
                                        tls = true
                                    } label: {
                                        Text(preset.label)
                                            .font(.system(size: 11.5))
                                            .foregroundStyle(host == preset.host ? Color.accentColor : .primary)
                                            .padding(.horizontal, 8)
                                            .padding(.vertical, 4)
                                            .background(
                                                Capsule()
                                                    .fill(host == preset.host ? Color.accentColor.opacity(0.12) : Color.primary.opacity(0.06))
                                            )
                                    }
                                    .buttonStyle(.plain)
                                }
                            }

                            HStack(spacing: 10) {
                                VStack(alignment: .leading, spacing: 4) {
                                    Text("IMAP 服务器")
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                    BorderlessInputField("imap.qq.com / imap.gmail.com", text: $host, isMonospaced: true)
                                }

                                VStack(alignment: .leading, spacing: 4) {
                                    Text("端口")
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                    BorderlessInputField("993", text: $portText, isMonospaced: true)
                                        .frame(width: 84)
                                }
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                Text("邮箱账号")
                                    .font(.system(size: 11.5))
                                    .foregroundStyle(.secondary)
                                BorderlessInputField("you@qq.com / you@gmail.com", text: $username, isMonospaced: true)
                            }

                            VStack(alignment: .leading, spacing: 4) {
                                HStack {
                                    Text("授权码 / 应用专用密码")
                                        .font(.system(size: 11.5))
                                        .foregroundStyle(.secondary)
                                    if store.imapConfig.hasPassword {
                                        Text("· 已加密保存")
                                            .font(.system(size: 11))
                                            .foregroundStyle(Color(red: 0.14, green: 0.62, blue: 0.30))
                                    }
                                }
                                BorderlessInputField(
                                    store.imapConfig.hasPassword ? "已加密保存（留空保持原密码不变）" : "填写邮箱 16 位授权码或 App Password",
                                    text: $password,
                                    isSecure: true,
                                    isMonospaced: true
                                )
                            }

                            Toggle("启用 SSL/TLS 加密连接 (端口 993 推荐)", isOn: $tls)
                                .font(.system(size: 12.5))
                        }
                        .padding(14)
                    }

                    InsetGroupCard(header: "Cloudflare 域名邮箱路由（别名自动收信）") {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("• 主力邮箱（QQ / Gmail / 163 / iCloud）通过上方 IMAP 授权码拉取或实时监听收信。")
                            Text("• 自有域名（当前：\(store.aliasDomain.nilIfBlank ?? "未配置别名域名")）无限随机别名由 Cloudflare Email Routing Catch-All 在边缘直接密封推送。")
                        }
                        .font(.system(size: 12))
                        .foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                    }
                }
            }

            HStack(spacing: 10) {
                Button {
                    Task { await runTest() }
                } label: {
                    HStack(spacing: 6) {
                        if testing {
                            ProgressView().controlSize(.small)
                        }
                        Text(testing ? "测试中..." : "测试连接")
                    }
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 30, cornerRadius: 8))
                .disabled(testing || saving || host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                Spacer()

                Button {
                    dismiss()
                } label: {
                    Text("取消")
                        .frame(minWidth: 46)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 30, cornerRadius: 8))
                .keyboardShortcut(.cancelAction)

                Button {
                    Task { await save() }
                } label: {
                    HStack(spacing: 6) {
                        if saving {
                            ProgressView().controlSize(.small)
                        }
                        Text(saving ? "保存并同步中..." : "保存并同步")
                    }
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 30, cornerRadius: 8))
                .disabled(testing || saving)
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 20)
        .frame(width: 540, height: 560)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            if !loadedInitial {
                syncDraftFromStore()
                loadedInitial = true
            }
            Task {
                let prevHost = store.imapConfig.host
                let prevUser = store.imapConfig.username
                try? await store.loadImapConfig()
                if host == prevHost && username == prevUser {
                    syncDraftFromStore()
                }
            }
        }
    }

    private func syncDraftFromStore() {
        let cfg = store.imapConfig
        enabled = cfg.enabled
        host = cfg.host
        portText = String(cfg.port > 0 ? cfg.port : 993)
        tls = cfg.tls
        username = cfg.username
        password = ""
    }

    private func buildPayload() -> ImapSavePayload {
        let parsedPort = Int(portText.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 993
        return ImapSavePayload(
            enabled: enabled,
            host: host.trimmingCharacters(in: .whitespacesAndNewlines),
            port: min(65535, max(1, parsedPort)),
            tls: tls,
            username: username.trimmingCharacters(in: .whitespacesAndNewlines),
            password: password.nilIfBlank
        )
    }

    private func runTest() async {
        testing = true
        errorMsg = nil
        testMsg = nil
        defer { testing = false }
        do {
            let res = try await store.testImapConfig(buildPayload())
            if res.ok {
                testSuccess = true
                testMsg = "连接成功 · 收件箱共 \(res.messages ?? 0) 封邮件"
            } else {
                testSuccess = false
                testMsg = res.error ?? "IMAP 连接测试失败"
            }
        } catch {
            testSuccess = false
            errorMsg = error.localizedDescription
        }
    }

    private func save() async {
        saving = true
        errorMsg = nil
        testMsg = nil
        defer { saving = false }
        do {
            let cleanHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
            let cleanUser = username.trimmingCharacters(in: .whitespacesAndNewlines)
            if enabled && (cleanHost.isEmpty || cleanUser.isEmpty || (!store.imapConfig.hasPassword && password.nilIfBlank == nil)) {
                errorMsg = "启用 IMAP 收信前请填写完整的服务器、邮箱账号和授权码"
                return
            }
            let updated = try await store.saveImapConfig(buildPayload())
            if updated.status == "error", let lastErr = updated.lastError?.nilIfBlank {
                errorMsg = "已保存配置，但同步连接失败：\(lastErr)"
                return
            }
            dismiss()
        } catch {
            errorMsg = error.localizedDescription
        }
    }
}
