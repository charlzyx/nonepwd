import SwiftUI

public struct ItemDetailView: View {
    @ObservedObject public var store: VaultStore
    public let item: VaultItemPayload

    @State private var showCardNumber = false
    @State private var confirmDelete = false

    private var totp: TotpResult? { store.totpSnapshot[item.id] }
    private var emailOtp: DecryptedEmailPayload? { store.latestMatchingEmail(for: item) }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                headerCard

                if let warning = store.securityIssues[item.id] {
                    HStack(spacing: 12) {
                        Image(systemName: "exclamationmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(Color(red: 0.90, green: 0.30, blue: 0.26))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(warning)
                                .font(.system(size: 13, weight: .semibold))
                            Text("建议点击右上角「编辑」更换为独立随机强密码")
                                .font(.system(size: 12))
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.red.opacity(0.08))
                    )
                }

                if let emailOtp, let code = emailOtp.otpCode {
                    emailOtpBanner(emailOtp, code: code)
                }

                if item.category == .card, let card = item.card {
                    WalletCardPreview(card: card, title: item.title, showFullNumber: showCardNumber)
                        .onTapGesture {
                            showCardNumber.toggle()
                        }

                    cardFieldsSection(card)
                } else if item.category == .identity, let identity = item.identity {
                    identityFieldsSection(identity)
                } else {
                    loginAndSecretsSection
                }

                if let totp {
                    totpCard(totp)
                }

                if !item.urls.isEmpty {
                    urlsSection
                }

                if !item.customFields.isEmpty {
                    customFieldsSection
                }

                if let notes = item.notes?.nilIfBlank {
                    InsetGroupCard(header: "备注") {
                        Text(notes)
                            .font(.system(size: 13))
                            .foregroundStyle(.primary)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(14)
                    }
                }

                HStack {
                    Spacer()
                    Button(role: .destructive) {
                        confirmDelete = true
                    } label: {
                        Text("删除此条目…")
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 28, cornerRadius: 7))
                    Spacer()
                }
                .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: 660, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor))
        .confirmationDialog("确定删除「\(item.title)」？", isPresented: $confirmDelete) {
            Button("删除", role: .destructive) {
                Task { try? await store.deleteItem(item) }
            }
            Button("取消", role: .cancel) {}
        }
    }

    private var headerCard: some View {
        VStack(spacing: 8) {
            SquircleAvatar(
                title: item.title,
                category: item.category,
                urlHint: item.urls.first ?? item.title,
                size: 54
            )

            Text(item.title)
                .font(.system(size: 20, weight: .semibold))
                .multilineTextAlignment(.center)
                .lineLimit(2)

            HStack(spacing: 6) {
                Label(store.vaultName(for: item.vaultId), systemImage: "folder")
                Text("·")
                Text(item.category.label)
            }
            .font(.system(size: 12))
            .foregroundStyle(.secondary)

            HStack(spacing: 10) {
                Button {
                    store.editingItem = item
                    store.editingCategory = item.category
                    store.showEditor = true
                } label: {
                    Text("编辑")
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 28, cornerRadius: 7))

                Button {
                    Task { await store.toggleFavorite(item) }
                } label: {
                    Text(item.favorite ? "已收藏" : "收藏")
                        .foregroundStyle(item.favorite ? .orange : .primary)
                }
                .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 28, cornerRadius: 7))
            }
            .padding(.top, 4)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
    }

    private func emailOtpBanner(_ email: DecryptedEmailPayload, code: String) -> some View {
        HStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color.green.opacity(0.16))
                    .frame(width: 36, height: 36)
                Image(systemName: "envelope.badge.shield.half.filled")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.green)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text("刚收到的邮箱验证码 · \(email.senderDomain)")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.green)
                Text(email.subject)
                    .font(.system(size: 11.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }

            Spacer()

            Text(code)
                .font(.system(size: 20, weight: .bold, design: .monospaced))
                .tracking(2)

            Button("复制") {
                store.copySecret(code, label: "邮箱验证码")
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .controlSize(.small)
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.green.opacity(0.08))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Color.green.opacity(0.28), lineWidth: 0.75)
        )
    }

    @ViewBuilder
    private var loginAndSecretsSection: some View {
        let hasMainFields =
            !(item.username?.nilIfBlank ?? "").isEmpty ||
            !(item.password ?? "").isEmpty ||
            !(item.emailAlias?.nilIfBlank ?? "").isEmpty

        if hasMainFields {
            InsetGroupCard(header: "凭据") {
                if let user = item.username?.nilIfBlank {
                    CopyableFieldRow(label: "用户名", value: user) {
                        store.copySecret(user, label: "用户名", autoClear: false)
                    }
                }
                if let pw = item.password, !pw.isEmpty {
                    if !(item.username?.nilIfBlank ?? "").isEmpty {
                        rowDivider
                    }
                    CopyableFieldRow(
                        label: "密码",
                        value: pw,
                        isSecret: true,
                        isMonospaced: true,
                        revealedByDefault: false
                    ) {
                        store.copySecret(pw, label: "密码")
                    }
                }
                if let alias = item.emailAlias?.nilIfBlank {
                    rowDivider
                    CopyableFieldRow(label: "掩码邮箱", value: alias, isMonospaced: true) {
                        store.copySecret(alias, label: "掩码邮箱", autoClear: false)
                    }
                }
            }
        }
    }

    private func cardFieldsSection(_ card: CardDetails) -> some View {
        InsetGroupCard(header: "卡片信息") {
            let rows = cardRows(card)
            ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                if idx > 0 { rowDivider }
                CopyableFieldRow(
                    label: row.label,
                    value: row.value,
                    isSecret: row.secret,
                    isMonospaced: row.mono,
                    revealedByDefault: !row.secret
                ) {
                    store.copySecret(row.value, label: row.label, autoClear: row.secret)
                }
            }
        }
    }

    private func cardRows(_ card: CardDetails) -> [(label: String, value: String, secret: Bool, mono: Bool)] {
        var rows: [(String, String, Bool, Bool)] = []
        if let holder = card.cardholderName?.nilIfBlank { rows.append(("持卡人", holder, false, false)) }
        if let num = card.number?.nilIfBlank { rows.append(("卡号", num, true, true)) }
        if !card.formattedExpiry.isEmpty { rows.append(("有效期", card.formattedExpiry, false, true)) }
        if let cvv = card.cvv?.nilIfBlank { rows.append(("安全码 CVV", cvv, true, true)) }
        if let brand = card.brand?.nilIfBlank { rows.append(("卡组织", brand, false, false)) }
        return rows
    }

    private func identityFieldsSection(_ identity: IdentityDetails) -> some View {
        let rows = identityRows(identity)
        return VStack(alignment: .leading, spacing: 12) {
            if !identity.formattedAddressBlock.isEmpty {
                Button {
                    store.copySecret(identity.formattedAddressBlock, label: "完整收货地址", autoClear: false)
                } label: {
                    Label("一键复制完整收货地址", systemImage: "doc.on.clipboard")
                }
                .buttonStyle(.glass)
            }

            if !rows.isEmpty {
                InsetGroupCard(header: "身份与地址详情") {
                    ForEach(Array(rows.enumerated()), id: \.offset) { idx, row in
                        if idx > 0 { rowDivider }
                        CopyableFieldRow(label: row.label, value: row.value) {
                            store.copySecret(row.value, label: row.label, autoClear: false)
                        }
                    }
                }
            }
        }
    }

    private func identityRows(_ id: IdentityDetails) -> [(label: String, value: String)] {
        var rows: [(String, String)] = []
        if !id.displayName.isEmpty { rows.append(("姓名", id.displayName)) }
        if let phone = id.phone?.nilIfBlank { rows.append(("手机 / 电话", phone)) }
        if let email = id.email?.nilIfBlank { rows.append(("电子邮箱", email)) }
        if let company = id.company?.nilIfBlank { rows.append(("公司 / 机构", company)) }
        if let addr1 = id.address1?.nilIfBlank { rows.append(("街道地址", addr1)) }
        if let addr2 = id.address2?.nilIfBlank { rows.append(("楼栋 / 门牌", addr2)) }
        if let city = id.city?.nilIfBlank { rows.append(("城市", city)) }
        if let state = id.state?.nilIfBlank { rows.append(("省 / 州", state)) }
        if let zip = id.postalCode?.nilIfBlank { rows.append(("邮政编码", zip)) }
        if let country = id.country?.nilIfBlank { rows.append(("国家 / 地区", country)) }
        return rows
    }

    private func totpCard(_ totp: TotpResult) -> some View {
        let formatted = totp.code.count == 6
            ? "\(totp.code.prefix(3)) \(totp.code.suffix(3))"
            : totp.code

        return InsetGroupCard(header: "双重认证") {
            HStack(spacing: 10) {
                Text("验证码")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.primary)

                Spacer()

                Text(formatted)
                    .font(.system(size: 15.5, weight: .semibold, design: .monospaced))
                    .tracking(1)
                    .foregroundStyle(.primary)
                    .textSelection(.enabled)

                CountdownRing(remainingSeconds: totp.remainingSeconds, period: totp.period)

                Button {
                    store.copySecret(totp.code, label: "2FA 验证码")
                } label: {
                    Image(systemName: "doc.on.doc")
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(.secondary.opacity(0.75))
                        .frame(width: 22, height: 22)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("复制验证码")
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 9.5)
            .frame(minHeight: 40)
        }
    }

    private var urlsSection: some View {
        InsetGroupCard(header: "关联网站") {
            ForEach(Array(item.urls.enumerated()), id: \.offset) { idx, rawUrl in
                if idx > 0 { rowDivider }
                HStack(spacing: 10) {
                    Text("网站 \(item.urls.count > 1 ? "\(idx + 1)" : "")")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.primary)
                        .fixedSize(horizontal: true, vertical: false)

                    Spacer(minLength: 12)

                    if let dest = URL(string: rawUrl) {
                        Link(rawUrl, destination: dest)
                            .font(.system(size: 13))
                            .lineLimit(1)
                            .truncationMode(.middle)
                    } else {
                        Text(rawUrl)
                            .font(.system(size: 13))
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }

                    Button {
                        store.copySecret(rawUrl, label: "网址", autoClear: false)
                    } label: {
                        Image(systemName: "doc.on.doc")
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(.secondary.opacity(0.75))
                            .frame(width: 22, height: 22)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help("复制网址")
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 9.5)
                .frame(minHeight: 38)
            }
        }
    }

    private var customFieldsSection: some View {
        InsetGroupCard(header: "自定义字段") {
            ForEach(Array(item.customFields.enumerated()), id: \.element.id) { idx, cf in
                if idx > 0 { rowDivider }
                CopyableFieldRow(
                    label: cf.label,
                    value: cf.value,
                    isSecret: cf.fieldType == "concealed",
                    isMonospaced: true,
                    revealedByDefault: cf.fieldType != "concealed"
                ) {
                    store.copySecret(cf.value, label: cf.label, autoClear: cf.fieldType == "concealed")
                }
            }
        }
    }

    private var rowDivider: some View {
        Divider().padding(.leading, 14)
    }
}
