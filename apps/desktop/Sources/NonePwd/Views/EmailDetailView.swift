import SwiftUI

public struct EmailDetailView: View {
    @ObservedObject public var store: VaultStore
    public let email: DecryptedEmailPayload

    private var senderTitle: String {
        email.senderDomain.nilIfBlank ?? email.from
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(spacing: 8) {
                    SquircleAvatar(
                        title: senderTitle,
                        category: .login,
                        urlHint: email.senderDomain.nilIfBlank ?? email.from,
                        size: 54
                    )

                    Text(email.subject.nilIfBlank ?? senderTitle)
                        .font(.system(size: 19, weight: .semibold))
                        .multilineTextAlignment(.center)
                        .lineLimit(3)

                    HStack(spacing: 6) {
                        Label(senderTitle, systemImage: "envelope")
                        if !email.receivedAt.isEmpty {
                            Text("·")
                            Text(email.receivedAt)
                        }
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)

                if let code = email.otpCode?.nilIfBlank {
                    InsetGroupCard(header: "提取到的验证码") {
                        HStack(spacing: 12) {
                            Text(code)
                                .font(.system(size: 24, weight: .semibold, design: .monospaced))
                                .tracking(2)
                                .textSelection(.enabled)
                            Spacer()
                            Button {
                                store.copyEmailOtp(email, code: code)
                            } label: {
                                Text("复制验证码")
                                    .padding(.horizontal, 8)
                            }
                            .buttonStyle(ApplePillButtonStyle(isProminent: true, height: 32, cornerRadius: 8))
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                    }
                }

                if let link = email.magicLink?.nilIfBlank,
                   let url = URL(string: link),
                   let scheme = url.scheme?.lowercased(),
                   ["http", "https"].contains(scheme)
                {
                    HStack {
                        Link(destination: url) {
                            Label("打开邮件中的验证链接", systemImage: "safari")
                                .font(.system(size: 13.5, weight: .medium))
                                .padding(.horizontal, 6)
                        }
                        .buttonStyle(.glass)
                        .controlSize(.large)
                        Spacer()
                    }
                }

                InsetGroupCard(header: "邮件头信息") {
                    CopyableFieldRow(label: "发件人", value: email.from) {
                        store.copySecret(email.from, label: "发件人", autoClear: false)
                    }
                    if let dom = email.senderDomain.nilIfBlank {
                        Divider().padding(.leading, 14)
                        CopyableFieldRow(label: "来源域名", value: dom, isMonospaced: true) {
                            store.copySecret(dom, label: "来源域名", autoClear: false)
                        }
                    }
                    Divider().padding(.leading, 14)
                    CopyableFieldRow(label: "收件地址", value: email.to, isMonospaced: true) {
                        store.copySecret(email.to, label: "收件地址", autoClear: false)
                    }
                    if let ts = email.receivedAt.nilIfBlank {
                        Divider().padding(.leading, 14)
                        CopyableFieldRow(label: "接收时间", value: ts, isMonospaced: true) {
                            store.copySecret(ts, label: "接收时间", autoClear: false)
                        }
                    }
                }

                InsetGroupCard(header: "邮件正文") {
                    let bodyText = email.textBody.nilIfBlank ?? email.snippet.nilIfBlank ?? "（无正文内容）"
                    Text(bodyText)
                        .font(.system(size: 13))
                        .lineSpacing(4)
                        .foregroundStyle(.primary)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                }

                HStack {
                    Spacer()
                    Button(role: .destructive) {
                        Task { await store.deleteEmail(email) }
                    } label: {
                        Text("删除此邮件…")
                            .foregroundStyle(.red)
                            .padding(.horizontal, 6)
                    }
                    .buttonStyle(ApplePillButtonStyle(isProminent: false, height: 30, cornerRadius: 8))
                    Spacer()
                }
                .padding(.top, 4)
            }
            .padding(24)
            .frame(maxWidth: 660, alignment: .leading)
            .frame(maxWidth: .infinity)
        }
        .background(Color(nsColor: .textBackgroundColor))
    }
}
