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
                            ("银行卡", ItemCategory.card),
                            ("身份", ItemCategory.identity),
                            ("笔记密钥", ItemCategory.secureNote),
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
                } else {
                    editorRow(label: "用户名") {
                        TextField("用户", text: $username)
                    }
                    editorDivider
                    editorRow(label: category == .login ? "密码" : "密钥") {
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
                                if let pw = try? NpCoreBridge.generatePassword(length: 20) {
                                    password = pw
                                    showPassword = true
                                }
                            } label: {
                                Image(systemName: "wand.and.stars")
                                    .font(.system(size: 12.5, weight: .regular))
                                    .foregroundStyle(Color.accentColor)
                            }
                            .buttonStyle(.plain)
                            .help("生成 20 位强密码")
                        }
                    }
                    editorDivider
                    editorRow(label: "网站") {
                        TextField("example.com", text: $urlsText)
                    }
                    editorDivider
                    editorRow(label: "验证码") {
                        TextField("选填 TOTP / otpauth://", text: $totp)
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
                        .frame(height: 68)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
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
                .disabled(busy || title.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(.horizontal, 22)
        .padding(.top, 22)
        .padding(.bottom, 16)
        .frame(width: 440)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { populate() }
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
            username = item.username ?? ""
            password = item.password ?? ""
            totp = item.totp ?? ""
            urlsText = item.urls.joined(separator: ", ")
            notes = item.notes ?? ""
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

            let payload = VaultItemPayload(
                id: itemId,
                vaultId: vaultId,
                category: category,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines),
                favorite: initialItem?.favorite ?? false,
                tags: initialItem?.tags ?? [],
                urls: urls,
                username: category == .login || category == .apiCredential ? username.nilIfBlank : nil,
                password: category == .card || category == .identity ? nil : (password.isEmpty ? nil : password),
                totp: totp.nilIfBlank,
                emailAlias: initialItem?.emailAlias,
                notes: notes.nilIfBlank,
                card: cardObj,
                identity: idObj,
                customFields: initialItem?.customFields ?? [],
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
