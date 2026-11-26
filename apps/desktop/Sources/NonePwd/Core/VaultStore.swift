import AppKit
import Combine
import Foundation

public enum SidebarDestination: Hashable, Identifiable {
    case all
    case logins
    case twoFactor
    case emailOtp
    case security
    case favorites
    case card
    case identity
    case apiCredentials
    case sshKeys
    case secureNotes
    case group(String)
    case vault(String)

    public var id: String {
        switch self {
        case .all: return "all"
        case .logins: return "logins"
        case .twoFactor: return "2fa"
        case .emailOtp: return "email_otp"
        case .security: return "security"
        case .favorites: return "favorites"
        case .card: return "card"
        case .identity: return "identity"
        case .apiCredentials: return "api_credentials"
        case .sshKeys: return "ssh_keys"
        case .secureNotes: return "secure_notes"
        case .group(let g): return "group:\(g)"
        case .vault(let vid): return "vault:\(vid)"
        }
    }

    public var title: String {
        switch self {
        case .all: return "全部"
        case .logins: return "密码登录"
        case .twoFactor: return "验证码"
        case .emailOtp: return "收件验证码"
        case .security: return "安全性"
        case .favorites: return "收藏夹"
        case .card: return "银行卡"
        case .identity: return "地址身份"
        case .apiCredentials: return "API 密钥"
        case .sshKeys: return "SSH 密钥"
        case .secureNotes: return "安全笔记"
        case .group(let g): return g
        case .vault: return "密码库"
        }
    }
}

public enum ItemSortField: String, CaseIterable, Identifiable, Sendable {
    case title
    case website
    case createdAt
    case updatedAt

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .title: return "标题"
        case .website: return "网站"
        case .createdAt: return "创建日期"
        case .updatedAt: return "编辑日期"
        }
    }

    public var systemImage: String {
        switch self {
        case .title: return "textformat"
        case .website: return "safari"
        case .createdAt: return "plus.circle"
        case .updatedAt: return "pencil"
        }
    }
}

private struct AuthParamsResponse: Decodable {
    let initialized: Bool
    let email: String?
    let kdfSalt: String?
    let kdfIterations: Int?
}

private struct LoginResponse: Decodable {
    struct AccountInfo: Decodable {
        let email: String
        let encryptedRootKeyset: String
        let emailPublicKey: String?
        let aliasDomain: String?
    }

    let token: String
    let account: AccountInfo
}

private struct SetupResponse: Decodable {
    struct AccountInfo: Decodable {
        let email: String
        let aliasDomain: String?
    }

    let token: String
    let account: AccountInfo
}

private struct SyncResponse: Decodable {
    struct AccountSummary: Decodable {
        let email: String
        let aliasDomain: String?
    }

    let account: AccountSummary?
    let vaults: [EncryptedVaultRecord]
    let items: [EncryptedItemRecord]
    let aliases: [AliasRecord]?
    let emails: [EncryptedEmailRecord]?
    let imapStatus: ImapConfigPublic?
    let imapAccounts: [ImapAccountPublic]?
    let emailFilter: EmailFilterConfig?
}

private struct WsEnvelope: Decodable {
    let type: String
    let email: EncryptedEmailRecord?
    let alias: AliasRecord?
    let id: String?
}

public struct AIEmailExtraction: Codable, Equatable, Sendable {
    public let emailId: String
    public let hasOtp: Bool
    public let otpCode: String?
    public let magicLink: String?
    public let issuer: String?
    public let summary: String?
}

@MainActor
public final class VaultStore: ObservableObject {
    @Published public var isUnlocked = false
    @Published public var busy = false
    @Published public var errorMessage: String?

    // Auth / connection UI state
    @Published public var serverURL: String
    @Published public var secretKey: String
    @Published public var knownEmail: String?
    @Published public var serverInitialized: Bool?
    @Published public var rememberDevice: Bool
    @Published public var touchIDEnabled: Bool
    @Published public var hasSavedTouchID: Bool = false

    // Decrypted Workspace Data
    @Published public var accountEmail: String = ""
    @Published public var aliasDomain: String = ""
    @Published public var vaults: [DecryptedVault] = []
    @Published public var items: [VaultItemPayload] = [] {
        didSet { recomputeSecurityIssues() }
    }
    @Published public private(set) var securityIssues: [String: String] = [:]
    @Published public var aliases: [AliasRecord] = []
    @Published public var emails: [DecryptedEmailPayload] = []
    @Published public var imapConfig: ImapConfigPublic = ImapConfigPublic()
    @Published public var imapAccounts: [ImapAccountPublic] = []
    @Published public var emailFilter: EmailFilterConfig = EmailFilterConfig()
    @Published public var wsConnected = false
    @Published public var isRefreshingEmails = false

    // Selection & Search
    @Published public var destination: SidebarDestination = .all
    @Published public var searchText: String = ""
    @Published public var selectedItemId: String?
    @Published public var selectedEmailId: String?
    @Published public var sortField: ItemSortField = .title
    @Published public var sortAscending: Bool = true

    // AI Regex Helper & Active Email Extraction Settings
    @Published public var aiBaseURL: String
    @Published public var aiApiKey: String
    @Published public var aiModel: String
    @Published public var unlockDuration: UnlockRememberDuration {
        didSet { if hasFinishedInit { saveAISettings() } }
    }
    @Published public private(set) var sessionExpiresAt: Date?
    @Published public var emailCronMinutes: Int {
        didSet { if hasFinishedInit { saveAISettings() } }
    }
    @Published public var aiAutoExtractEmail: Bool {
        didSet { if hasFinishedInit { saveAISettings() } }
    }
    @Published public var customGroups: [String] = []
    @Published public private(set) var aiEmailExtractions: [String: AIEmailExtraction] = [:]
    @Published public private(set) var aiExtractingIds: Set<String> = []
    @Published public private(set) var copiedEmailExpirations: [String: Date] = [:]

    nonisolated public static let copiedEmailAutoDeleteSeconds: TimeInterval = 5 * 60
    nonisolated private static let copiedEmailExpirationsDefaultsKey = "nonepwd.copied_email_expirations.v1"

    // Live TOTP ticker + 30s Clipboard Clear
    @Published public var totpSnapshot: [String: TotpResult] = [:]
    @Published public var clipboardStatus: String = ""
    @Published public var clipboardRemaining: Int = 0

    // Modal Triggers
    @Published public var editingCategory: ItemCategory?
    @Published public var editingItem: VaultItemPayload?
    @Published public var showEditor = false
    @Published public var showImportSheet = false
    @Published public var showImapSheet = false
    @Published public var showEmailFilterSheet = false
    @Published public var showExtensionSheet = false

    private var sessionToken: String?
    private var rootKeyBytes: Data?
    private var emailPrivKeyPkcs8B64: String?
    private var vaultKeyMap: [String: Data] = [:]
    private var wsTask: URLSessionWebSocketTask?
    private var wsReconnectAttempt = 0
    private var lastCopiedChangeCount: Int?
    private var timer: Timer?
    private var terminateObserver: NSObjectProtocol?
    private var aiAttemptedIds: Set<String> = []
    private var deletingExpiredEmailIds: Set<String> = []
    private var lastEmailCronAt = Date()
    private var hasFinishedInit = false
    private let isTestingMode: Bool

    public var isAIConfigured: Bool {
        if !aiApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return true
        }
        let lower = aiBaseURL.lowercased()
        return lower.contains("127.0.0.1") || lower.contains("localhost")
    }

    private let urlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 30
        return URLSession(configuration: cfg)
    }()

    private let directSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 20
        cfg.connectionProxyDictionary = [:]
        return URLSession(configuration: cfg)
    }()

    public init(forTesting: Bool = false) {
        self.isTestingMode = forTesting
        let prefs = forTesting ? DesktopPrefs() : PrefsStore.load()
        self.serverURL = prefs.serverURL
        self.secretKey = prefs.secretKey ?? ""
        self.knownEmail = prefs.email
        self.rememberDevice = prefs.rememberDevice
        self.touchIDEnabled = prefs.touchIDEnabled
        self.aiBaseURL = prefs.aiBaseURL ?? "https://api.openai.com/v1"
        self.aiApiKey = prefs.aiApiKey ?? ""
        self.aiModel = prefs.aiModel ?? "gpt-4o-mini"
        self.unlockDuration = UnlockRememberDuration(rawValue: prefs.unlockDurationRaw ?? "") ?? .hours24
        self.emailCronMinutes = prefs.emailCronMinutes ?? 1
        self.aiAutoExtractEmail = prefs.aiAutoExtractEmail ?? false
        self.customGroups = prefs.savedGroups ?? []
        if !forTesting {
            self.loadCopiedEmailExpirations()
            self.hasSavedTouchID = TouchIDKeychain.hasSavedQuickUnlock()
            _ = PrefsStore.syncBundledBrowserExtension()
            self.hasFinishedInit = true

            self.terminateObserver = NotificationCenter.default.addObserver(
                forName: NSApplication.willTerminateNotification,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.clearClipboardNow()
                }
            }

            if let saved = SessionKeychain.loadValid(matchingServerURL: normalizedServerBase()),
               let rk = try? Data(base64URLEncoded: saved.rootKeyB64)
            {
                self.sessionToken = saved.token
                self.rootKeyBytes = rk
                self.emailPrivKeyPkcs8B64 = saved.emailPrivateKeyPkcs8B64
                self.accountEmail = saved.accountEmail
                self.knownEmail = saved.accountEmail
                self.aliasDomain = saved.aliasDomain
                self.sessionExpiresAt = saved.expiresAt
                self.loadAICache()
                self.isUnlocked = true
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    try? await self.syncAll()
                    if self.isUnlocked {
                        self.connectWebSocket()
                    }
                }
            }
        }
        startTicker()
    }

    deinit {
        timer?.invalidate()
        wsTask?.cancel(with: .goingAway, reason: nil)
        if let terminateObserver {
            NotificationCenter.default.removeObserver(terminateObserver)
        }
    }

    private func startTicker() {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                self?.onSecondTick()
            }
        }
    }

    public func onSecondTick() {
        if isUnlocked {
            if let exp = sessionExpiresAt, Date() >= exp {
                lock()
                return
            }
            refreshTotps()
            pruneExpiredCopiedEmails()
            if emailCronMinutes > 0 && Date().timeIntervalSince(lastEmailCronAt) >= Double(emailCronMinutes * 60) {
                lastEmailCronAt = Date()
                Task { @MainActor [weak self] in
                    await self?.runEmailCronAndAIExtract()
                }
            }
        }
        if clipboardRemaining > 0 {
            clipboardRemaining -= 1
            if clipboardRemaining == 0 {
                clearClipboardNow()
            }
        }
    }

    public func refreshTotps() {
        let nowMs = UInt64(Date().timeIntervalSince1970 * 1000)
        var next: [String: TotpResult] = [:]
        for item in items {
            guard let totpRaw = item.totp?.nilIfBlank else { continue }
            if let res = try? NpCoreBridge.generateTOTP(totpRaw, timestampMs: nowMs) {
                next[item.id] = res
            }
        }
        if totpSnapshot != next {
            totpSnapshot = next
        }
    }

    // MARK: - Clipboard Auto-Clear (30s)

    nonisolated public static let concealedPasteboardType = NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")
    nonisolated public static let transientPasteboardType = NSPasteboard.PasteboardType("org.nspasteboard.TransientType")

    public func copySecret(_ value: String, label: String, autoClear: Bool = true) {
        let pb = NSPasteboard.general
        pb.clearContents()
        if autoClear {
            let item = NSPasteboardItem()
            item.setString(value, forType: .string)
            item.setData(Data(), forType: Self.concealedPasteboardType)
            item.setData(Data(), forType: Self.transientPasteboardType)
            pb.writeObjects([item])
        } else {
            pb.setString(value, forType: .string)
        }
        lastCopiedChangeCount = pb.changeCount
        clipboardStatus = "已复制 \(label)"
        clipboardRemaining = autoClear ? 30 : 0
        if !autoClear {
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(3))
                if self.clipboardStatus == "已复制 \(label)" && self.clipboardRemaining == 0 {
                    self.clipboardStatus = ""
                }
            }
        }
    }

    public func clearClipboardNow() {
        let pb = NSPasteboard.general
        if let expected = lastCopiedChangeCount, pb.changeCount == expected {
            pb.clearContents()
        }
        lastCopiedChangeCount = nil
        clipboardRemaining = 0
        clipboardStatus = ""
    }

    // MARK: - Email OTP Copy & Auto-Expire (5 min)

    public func copyEmailOtp(_ email: DecryptedEmailPayload, code: String) {
        copySecret(code, label: "邮箱验证码（5 分钟后自动清除）")
        scheduleEmailAutoDelete(email.id)
    }

    public func scheduleEmailAutoDelete(
        _ emailId: String,
        after seconds: TimeInterval = VaultStore.copiedEmailAutoDeleteSeconds,
        now: Date = Date()
    ) {
        guard !emailId.isEmpty else { return }
        if copiedEmailExpirations[emailId] == nil {
            copiedEmailExpirations[emailId] = now.addingTimeInterval(seconds)
            saveCopiedEmailExpirations()
        }
    }

    public func pruneExpiredCopiedEmails(now: Date = Date()) {
        guard !copiedEmailExpirations.isEmpty else { return }
        let expiredIds = copiedEmailExpirations.compactMap { id, expiresAt in
            expiresAt <= now ? id : nil
        }
        guard !expiredIds.isEmpty else { return }

        var changed = false
        for id in expiredIds {
            if let email = emails.first(where: { $0.id == id }) {
                if !deletingExpiredEmailIds.contains(id) {
                    deletingExpiredEmailIds.insert(id)
                    Task { @MainActor [weak self] in
                        await self?.deleteEmail(email)
                    }
                }
            } else if !deletingExpiredEmailIds.contains(id) {
                copiedEmailExpirations.removeValue(forKey: id)
                changed = true
            }
        }
        if changed {
            saveCopiedEmailExpirations()
        }
    }

    private func loadCopiedEmailExpirations() {
        guard !isTestingMode,
              let raw = UserDefaults.standard.dictionary(forKey: Self.copiedEmailExpirationsDefaultsKey) as? [String: Double]
        else { return }
        var map: [String: Date] = [:]
        for (id, ts) in raw {
            map[id] = Date(timeIntervalSince1970: ts)
        }
        copiedEmailExpirations = map
    }

    private func saveCopiedEmailExpirations() {
        guard !isTestingMode else { return }
        if copiedEmailExpirations.isEmpty {
            UserDefaults.standard.removeObject(forKey: Self.copiedEmailExpirationsDefaultsKey)
            return
        }
        var raw: [String: Double] = [:]
        for (id, date) in copiedEmailExpirations {
            raw[id] = date.timeIntervalSince1970
        }
        UserDefaults.standard.set(raw, forKey: Self.copiedEmailExpirationsDefaultsKey)
    }

    // MARK: - Filtered Collections & Security Audit

    private func recomputeSecurityIssues() {
        var counts: [String: Int] = [:]
        for item in items where item.category == .login {
            if let pw = item.password, !pw.isEmpty {
                counts[pw, default: 0] += 1
            }
        }
        var issues: [String: String] = [:]
        for item in items where item.category == .login {
            guard let pw = item.password, !pw.isEmpty else { continue }
            if counts[pw, default: 0] > 1 {
                issues[item.id] = "重复使用的密码"
            } else if pw.count < 8 {
                issues[item.id] = "弱密码（少于 8 位）"
            }
        }
        securityIssues = issues
    }

    public var loginItemsCount: Int {
        items.filter { $0.category == .login }.count
    }

    public var favoriteItemsCount: Int {
        items.filter(\.favorite).count
    }

    public var securityItemsCount: Int {
        securityIssues.count
    }

    public var twoFactorItemsCount: Int {
        items.filter { !($0.totp?.nilIfBlank ?? "").isEmpty }.count
    }

    public var cardItemsCount: Int {
        items.filter { $0.category == .card }.count
    }

    public var identityItemsCount: Int {
        items.filter { $0.category == .identity }.count
    }

    public var apiCredentialItemsCount: Int {
        items.filter { $0.category == .apiCredential }.count
    }

    public var sshKeyItemsCount: Int {
        items.filter { $0.category == .sshKey }.count
    }

    public var secureNoteItemsCount: Int {
        items.filter { $0.category == .secureNote }.count
    }

    public var allGroups: [String] {
        var seen: [String: String] = [:]
        for g in customGroups + items.flatMap(\.tags) {
            let trimmed = g.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            let key = trimmed.lowercased()
            if seen[key] == nil {
                seen[key] = trimmed
            }
        }
        return seen.values.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    }

    public func groupItemsCount(_ group: String) -> Int {
        items.filter { item in
            item.tags.contains { $0.caseInsensitiveCompare(group) == .orderedSame }
        }.count
    }

    public var otpEmailsCount: Int {
        emails.filter { !($0.otpCode?.nilIfBlank ?? "").isEmpty }.count
    }

    public var currentDestinationTitle: String {
        if case .vault(let vid) = destination {
            return vaultName(for: vid)
        }
        return destination.title
    }

    public var currentDestinationSubtitle: String {
        if destination == .emailOtp {
            return "\(emails.count)个项目"
        }
        return "\(filteredItems.count)个项目"
    }

    public var filteredItems: [VaultItemPayload] {
        var list = items
        switch destination {
        case .all:
            break
        case .logins:
            list = list.filter { $0.category == .login }
        case .twoFactor:
            list = list.filter { !($0.totp?.nilIfBlank ?? "").isEmpty }
        case .favorites:
            list = list.filter(\.favorite)
        case .security:
            list = list.filter { securityIssues[$0.id] != nil }
        case .card:
            list = list.filter { $0.category == .card }
        case .identity:
            list = list.filter { $0.category == .identity }
        case .apiCredentials:
            list = list.filter { $0.category == .apiCredential }
        case .sshKeys:
            list = list.filter { $0.category == .sshKey }
        case .secureNotes:
            list = list.filter { $0.category == .secureNote }
        case .group(let g):
            list = list.filter { item in
                item.tags.contains { $0.caseInsensitiveCompare(g) == .orderedSame }
            }
        case .vault(let vid):
            list = list.filter { $0.vaultId == vid }
        case .emailOtp:
            return []
        }

        let q = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if !q.isEmpty {
            list = list.filter { item in
                if item.title.lowercased().contains(q) { return true }
                if (item.username ?? "").lowercased().contains(q) { return true }
                if (item.emailAlias ?? "").lowercased().contains(q) { return true }
                if item.urls.contains(where: { $0.lowercased().contains(q) }) { return true }
                if item.tags.contains(where: { $0.lowercased().contains(q) }) { return true }
                if item.customFields.contains(where: {
                    $0.label.lowercased().contains(q)
                        || ($0.fieldType != "concealed" && $0.value.lowercased().contains(q))
                }) {
                    return true
                }
                if let card = item.card {
                    if (card.brand ?? "").lowercased().contains(q) || card.last4.contains(q)
                        || (card.cardholderName ?? "").lowercased().contains(q)
                    {
                        return true
                    }
                }
                if let id = item.identity {
                    if id.displayName.lowercased().contains(q)
                        || (id.email ?? "").lowercased().contains(q)
                        || (id.phone ?? "").lowercased().contains(q)
                        || (id.address1 ?? "").lowercased().contains(q)
                        || (id.city ?? "").lowercased().contains(q)
                    {
                        return true
                    }
                }
                return false
            }
        }
        list.sort { a, b in
            let cmp: ComparisonResult
            switch sortField {
            case .title:
                cmp = a.title.localizedStandardCompare(b.title)
            case .website:
                let ua = a.urls.first ?? a.title
                let ub = b.urls.first ?? b.title
                cmp = ua.localizedStandardCompare(ub)
            case .createdAt:
                cmp = a.createdAt.compare(b.createdAt)
            case .updatedAt:
                cmp = a.updatedAt.compare(b.updatedAt)
            }
            if cmp == .orderedSame {
                return a.id < b.id
            }
            return sortAscending ? (cmp == .orderedAscending) : (cmp == .orderedDescending)
        }
        return list
    }

    public var activeItem: VaultItemPayload? {
        guard let id = selectedItemId else { return nil }
        return filteredItems.first(where: { $0.id == id })
    }

    public var activeEmail: DecryptedEmailPayload? {
        guard let id = selectedEmailId else { return nil }
        return emails.first(where: { $0.id == id })
    }

    public func latestMatchingEmail(for item: VaultItemPayload) -> DecryptedEmailPayload? {
        emails.first { email in
            guard let code = email.otpCode?.nilIfBlank, !code.isEmpty else { return false }
            if let alias = item.emailAlias?.nilIfBlank,
               email.to.caseInsensitiveCompare(alias) == .orderedSame
            {
                return true
            }
            if !email.senderDomain.isEmpty {
                for u in item.urls where NpCoreBridge.domainsMatch(u, email.senderDomain) {
                    return true
                }
            }
            return false
        }
    }

    public func vaultName(for vaultId: String) -> String {
        vaults.first(where: { $0.id == vaultId })?.metadata.name ?? "Personal"
    }

    // MARK: - HTTP Helper

    nonisolated public static let minKdfIterations = 1_000
    nonisolated public static let maxKdfIterations = 5_000_000

    nonisolated public static func clampKdfIterations(_ iterations: Int) -> Int {
        min(maxKdfIterations, max(minKdfIterations, iterations))
    }

    nonisolated private static func isLocalOrLanHost(_ rawHost: String) -> Bool {
        let host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "[::1]" {
            return true
        }
        let octets = host.split(separator: ".").compactMap { Int($0) }
        if octets.count == 4 && octets.allSatisfy({ (0...255).contains($0) }) {
            if octets[0] == 10 { return true }
            if octets[0] == 127 { return true }
            if octets[0] == 192 && octets[1] == 168 { return true }
            if octets[0] == 172 && (16...31).contains(octets[1]) { return true }
        }
        return false
    }

    nonisolated public static func normalizeServerBase(_ input: String) -> String {
        var raw = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.isEmpty { return "http://127.0.0.1:8787" }
        let lower = raw.lowercased()
        if !lower.hasPrefix("http://") && !lower.hasPrefix("https://") {
            let authority = raw.split(separator: "/", maxSplits: 1).first.map(String.init) ?? raw
            let host: String
            if authority.hasPrefix("["), let end = authority.firstIndex(of: "]") {
                host = String(authority[...end])
            } else {
                host = authority.split(separator: ":", maxSplits: 1).first.map(String.init) ?? authority
            }
            let scheme = isLocalOrLanHost(host) ? "http" : "https"
            raw = "\(scheme)://\(raw)"
        }
        while raw.hasSuffix("/") { raw.removeLast() }
        return raw
    }

    private func normalizedServerBase() -> String {
        Self.normalizeServerBase(serverURL)
    }

    private func sessionForBase(_ base: String) -> URLSession {
        let host = URL(string: base)?.host?.lowercased() ?? ""
        if host == "127.0.0.1" || host == "localhost" || host == "::1" {
            return directSession
        }
        return urlSession
    }

    private func apiRequest<T: Decodable>(
        _ path: String,
        method: String = "GET",
        bodyObj: Any? = nil,
        skipAuth: Bool = false
    ) async throws -> T {
        let base = normalizedServerBase()
        guard let url = URL(string: "\(base)\(path)") else {
            throw NpCoreError.rustError("无效的服务端 URL: \(base)\(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        if !skipAuth, let token = sessionToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let bodyObj {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if let data = bodyObj as? Data {
                req.httpBody = data
            } else {
                req.httpBody = try JSONSerialization.data(withJSONObject: bodyObj, options: [])
            }
        }
        let (data, response) = try await sessionForBase(base).data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status < 200 || status >= 300 {
            if status == 401 && !skipAuth && isUnlocked {
                lock()
            }
            if let errObj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = errObj["error"] as? String
            {
                throw NpCoreError.rustError(msg)
            }
            throw NpCoreError.rustError("请求失败 (HTTP \(status))")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }

    // MARK: - Auth Lifecycle

    public func probeServer() async {
        errorMessage = nil
        do {
            let params: AuthParamsResponse = try await apiRequest("/api/auth/params", skipAuth: true)
            serverInitialized = params.initialized
            if let email = params.email {
                knownEmail = email
            }
        } catch {
            serverInitialized = nil
            errorMessage = "无法连接服务端: \(error.localizedDescription)"
        }
    }

    public func saveAISettings() {
        persistPrefs(serverURL: normalizedServerBase(), email: knownEmail, secretKey: secretKey.nilIfBlank)
    }

    private func persistPrefs(serverURL: String, email: String?, secretKey: String?) {
        PrefsStore.save(DesktopPrefs(
            serverURL: serverURL,
            email: email,
            secretKey: secretKey,
            rememberDevice: rememberDevice,
            touchIDEnabled: touchIDEnabled,
            aiBaseURL: aiBaseURL.nilIfBlank,
            aiApiKey: aiApiKey.nilIfBlank,
            aiModel: aiModel.nilIfBlank,
            unlockDurationRaw: unlockDuration.rawValue,
            emailCronMinutes: emailCronMinutes,
            aiAutoExtractEmail: aiAutoExtractEmail,
            savedGroups: customGroups
        ))
    }

    public func unlock(masterPassword: String, saveTouchID: Bool? = nil) async {
        guard !masterPassword.isEmpty else {
            errorMessage = "请输入主密码"
            return
        }
        guard let cleanSK = secretKey.nilIfBlank else {
            errorMessage = "请输入 Secret Key (NP3-...)"
            return
        }
        busy = true
        errorMessage = nil
        defer { busy = false }

        do {
            let cleanBase = normalizedServerBase()
            serverURL = cleanBase
            let params: AuthParamsResponse = try await apiRequest("/api/auth/params", skipAuth: true)
            guard params.initialized,
                  let salt = params.kdfSalt,
                  let iters = params.kdfIterations
            else {
                serverInitialized = false
                throw NpCoreError.rustError("该服务端尚未初始化，请切换至「初始化新服务端」")
            }

            let safeIters = Self.clampKdfIterations(iters)
            let derived = try NpCoreBridge.deriveAccountKeys(
                masterPassword: masterPassword,
                secretKey: cleanSK,
                kdfSaltB64: salt,
                iterations: safeIters
            )
            let mukData = try Data(base64URLEncoded: derived.masterUnlockKeyB64)

            let loginRes: LoginResponse = try await apiRequest(
                "/api/auth/login",
                method: "POST",
                bodyObj: ["authVerifier": derived.authVerifierB64],
                skipAuth: true
            )

            let keyset = try NpCoreBridge.decryptJSON(
                RootKeysetPayload.self,
                key: mukData,
                blob: loginRes.account.encryptedRootKeyset,
                aad: AAD.rootKeyset
            )

            self.sessionToken = loginRes.token
            self.rootKeyBytes = try Data(base64URLEncoded: keyset.rootKeyB64)
            self.emailPrivKeyPkcs8B64 = keyset.emailPrivateKeyPkcs8B64
            self.accountEmail = loginRes.account.email
            self.knownEmail = loginRes.account.email
            self.aliasDomain = loginRes.account.aliasDomain ?? ""

            let enableTouch = saveTouchID ?? touchIDEnabled
            self.touchIDEnabled = enableTouch
            persistPrefs(serverURL: cleanBase, email: loginRes.account.email, secretKey: cleanSK)

            if enableTouch {
                try? TouchIDKeychain.saveQuickUnlock(QuickUnlockCredentials(
                    serverURL: cleanBase,
                    secretKey: cleanSK,
                    authVerifierB64: derived.authVerifierB64,
                    rootKeyB64: keyset.rootKeyB64,
                    emailPrivateKeyPkcs8B64: keyset.emailPrivateKeyPkcs8B64,
                    accountEmail: loginRes.account.email,
                    aliasDomain: loginRes.account.aliasDomain ?? ""
                ))
                hasSavedTouchID = TouchIDKeychain.hasSavedQuickUnlock()
            } else {
                TouchIDKeychain.deleteQuickUnlock()
                hasSavedTouchID = false
            }

            if let secs = unlockDuration.seconds {
                let exp = Date().addingTimeInterval(secs)
                sessionExpiresAt = exp
                SessionKeychain.save(RememberedDesktopSession(
                    serverURL: cleanBase,
                    token: loginRes.token,
                    rootKeyB64: keyset.rootKeyB64,
                    emailPrivateKeyPkcs8B64: keyset.emailPrivateKeyPkcs8B64,
                    accountEmail: loginRes.account.email,
                    aliasDomain: loginRes.account.aliasDomain ?? "",
                    expiresAt: exp
                ))
            } else {
                sessionExpiresAt = nil
                SessionKeychain.clear()
            }

            loadAICache()
            try await syncAll()
            isUnlocked = true
            lastEmailCronAt = Date()
            connectWebSocket()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func unlockWithTouchID() async {
        errorMessage = nil
        busy = true
        defer { busy = false }
        do {
            let creds = try await TouchIDKeychain.authenticateAndLoadQuickUnlock()
            let cleanBase = Self.normalizeServerBase(creds.serverURL)
            serverURL = cleanBase
            secretKey = creds.secretKey
            touchIDEnabled = true

            // Preferred path: root keys + authVerifier without persisting master password
            if let rootKeyB64 = creds.rootKeyB64?.nilIfBlank,
               let emailPrivKey = creds.emailPrivateKeyPkcs8B64?.nilIfBlank
            {
                let rk = try Data(base64URLEncoded: rootKeyB64)
                let token: String
                let resolvedEmail: String
                let resolvedAliasDomain: String

                if let verifier = creds.authVerifierB64?.nilIfBlank {
                    let loginRes: LoginResponse = try await apiRequest(
                        "/api/auth/login",
                        method: "POST",
                        bodyObj: ["authVerifier": verifier],
                        skipAuth: true
                    )
                    token = loginRes.token
                    resolvedEmail = loginRes.account.email
                    resolvedAliasDomain = loginRes.account.aliasDomain ?? creds.aliasDomain ?? ""
                } else if let savedSession = SessionKeychain.loadValid(matchingServerURL: cleanBase) {
                    token = savedSession.token
                    resolvedEmail = creds.accountEmail ?? savedSession.accountEmail
                    resolvedAliasDomain = creds.aliasDomain ?? savedSession.aliasDomain
                } else {
                    throw NpCoreError.rustError("请先使用主密码解锁一次以刷新快捷解锁凭据")
                }

                self.sessionToken = token
                self.rootKeyBytes = rk
                self.emailPrivKeyPkcs8B64 = emailPrivKey
                self.accountEmail = resolvedEmail
                self.knownEmail = resolvedEmail
                self.aliasDomain = resolvedAliasDomain
                persistPrefs(serverURL: cleanBase, email: resolvedEmail, secretKey: creds.secretKey)

                if let secs = unlockDuration.seconds {
                    let exp = Date().addingTimeInterval(secs)
                    sessionExpiresAt = exp
                    SessionKeychain.save(RememberedDesktopSession(
                        serverURL: cleanBase,
                        token: token,
                        rootKeyB64: rootKeyB64,
                        emailPrivateKeyPkcs8B64: emailPrivKey,
                        accountEmail: resolvedEmail,
                        aliasDomain: resolvedAliasDomain,
                        expiresAt: exp
                    ))
                } else {
                    sessionExpiresAt = nil
                    SessionKeychain.clear()
                }

                loadAICache()
                try await syncAll()
                isUnlocked = true
                lastEmailCronAt = Date()
                connectWebSocket()
                return
            }

            // Legacy migration path: re-unlock once and overwrite Keychain item without masterPassword
            if let legacyPassword = creds.masterPassword, !legacyPassword.isEmpty {
                busy = false
                await unlock(masterPassword: legacyPassword, saveTouchID: true)
                return
            }

            throw NpCoreError.rustError("钥匙串快捷解锁凭据已失效，请使用主密码重新解锁")
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func setupNewServer(email: String, aliasDomain: String, masterPassword: String) async {
        guard let cleanEmail = email.nilIfBlank else {
            errorMessage = "请输入管理员邮箱"
            return
        }
        guard !masterPassword.isEmpty else {
            errorMessage = "请设置主密码"
            return
        }
        busy = true
        errorMessage = nil
        defer { busy = false }

        do {
            let cleanBase = normalizedServerBase()
            serverURL = cleanBase
            let generatedSK = try NpCoreBridge.generateSecretKey()
            let saltData = try NpCoreBridge.randomBytes(16)
            let saltB64 = saltData.base64URLEncodedString()
            let iterations = 600_000

            let derived = try NpCoreBridge.deriveAccountKeys(
                masterPassword: masterPassword,
                secretKey: generatedSK,
                kdfSaltB64: saltB64,
                iterations: iterations
            )
            let muk = try Data(base64URLEncoded: derived.masterUnlockKeyB64)
            let rootKey = try NpCoreBridge.randomBytes(32)
            let kp = try NpCoreBridge.generateEmailKeyPair()

            let keyset = RootKeysetPayload(
                rootKeyB64: rootKey.base64URLEncodedString(),
                emailPrivateKeyPkcs8B64: kp.privateKeyPkcs8B64
            )
            let encryptedRootKeyset = try NpCoreBridge.encryptJSON(
                key: muk,
                value: keyset,
                aad: AAD.rootKeyset
            )

            var initialVaults: [[String: String]] = []
            for vName in ["Personal", "DevOps"] {
                let vid = try NpCoreBridge.randomID()
                let vk = try NpCoreBridge.randomBytes(32)
                let encKey = try NpCoreBridge.encryptBytes(
                    key: rootKey,
                    plaintext: vk,
                    aad: AAD.vaultOwnerKey(vid)
                )
                let encMeta = try NpCoreBridge.encryptJSON(
                    key: vk,
                    value: VaultMetadata(name: vName),
                    aad: AAD.vaultMeta(vid)
                )
                initialVaults.append([
                    "id": vid,
                    "encryptedKey": encKey,
                    "encryptedMeta": encMeta,
                ])
            }

            let res: SetupResponse = try await apiRequest(
                "/api/auth/setup",
                method: "POST",
                bodyObj: [
                    "email": cleanEmail.lowercased(),
                    "kdfSalt": saltB64,
                    "kdfIterations": iterations,
                    "authVerifier": derived.authVerifierB64,
                    "encryptedRootKeyset": encryptedRootKeyset,
                    "emailPublicKey": kp.publicKeyB64,
                    "aliasDomain": aliasDomain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                    "vaults": initialVaults,
                ],
                skipAuth: true
            )

            self.secretKey = generatedSK
            self.sessionToken = res.token
            self.rootKeyBytes = rootKey
            self.emailPrivKeyPkcs8B64 = kp.privateKeyPkcs8B64
            self.accountEmail = res.account.email
            self.knownEmail = res.account.email
            self.aliasDomain = res.account.aliasDomain ?? ""
            self.serverInitialized = true

            persistPrefs(serverURL: cleanBase, email: res.account.email, secretKey: generatedSK)
            if touchIDEnabled {
                try? TouchIDKeychain.saveQuickUnlock(QuickUnlockCredentials(
                    serverURL: cleanBase,
                    secretKey: generatedSK,
                    authVerifierB64: derived.authVerifierB64,
                    rootKeyB64: rootKey.base64URLEncodedString(),
                    emailPrivateKeyPkcs8B64: kp.privateKeyPkcs8B64,
                    accountEmail: res.account.email,
                    aliasDomain: res.account.aliasDomain ?? ""
                ))
                hasSavedTouchID = TouchIDKeychain.hasSavedQuickUnlock()
            }

            if let secs = unlockDuration.seconds {
                let exp = Date().addingTimeInterval(secs)
                sessionExpiresAt = exp
                SessionKeychain.save(RememberedDesktopSession(
                    serverURL: cleanBase,
                    token: res.token,
                    rootKeyB64: rootKey.base64URLEncodedString(),
                    emailPrivateKeyPkcs8B64: kp.privateKeyPkcs8B64,
                    accountEmail: res.account.email,
                    aliasDomain: res.account.aliasDomain ?? "",
                    expiresAt: exp
                ))
            } else {
                sessionExpiresAt = nil
                SessionKeychain.clear()
            }

            loadAICache()
            try await syncAll()
            isUnlocked = true
            lastEmailCronAt = Date()
            connectWebSocket()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func lock() {
        let tok = sessionToken
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        wsConnected = false
        clearClipboardNow()
        SessionKeychain.clear()
        sessionExpiresAt = nil

        sessionToken = nil
        rootKeyBytes = nil
        emailPrivKeyPkcs8B64 = nil
        vaultKeyMap = [:]
        vaults = []
        items = []
        aliases = []
        emails = []
        imapConfig = ImapConfigPublic()
        imapAccounts = []
        totpSnapshot = [:]
        aiEmailExtractions = [:]
        aiExtractingIds = []
        aiAttemptedIds = []
        selectedItemId = nil
        selectedEmailId = nil
        isUnlocked = false

        if let tok {
            let base = normalizedServerBase()
            if let url = URL(string: "\(base)/api/auth/logout") {
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
                urlSession.dataTask(with: req).resume()
            }
        }
    }

    // MARK: - Sync & CRUD

    public func syncAll() async throws {
        guard let rootKey = rootKeyBytes else { return }
        let syncRes: SyncResponse = try await apiRequest("/api/sync")

        if let email = syncRes.account?.email {
            accountEmail = email
        }
        aliasDomain = syncRes.account?.aliasDomain ?? aliasDomain
        if let imapStatus = syncRes.imapStatus {
            imapConfig = imapStatus
        }
        if let accounts = syncRes.imapAccounts {
            imapAccounts = accounts
        } else {
            imapAccounts = legacyAccountFallback(from: imapConfig)
        }
        emailFilter = syncRes.emailFilter ?? EmailFilterConfig()

        var keyMap: [String: Data] = [:]
        var nextVaults: [DecryptedVault] = []
        for v in syncRes.vaults {
            let vk = try NpCoreBridge.decryptBytes(
                key: rootKey,
                blob: v.encryptedKey,
                aad: AAD.vaultOwnerKey(v.id)
            )
            let meta = try NpCoreBridge.decryptJSON(
                VaultMetadata.self,
                key: vk,
                blob: v.encryptedMeta,
                aad: AAD.vaultMeta(v.id)
            )
            keyMap[v.id] = vk
            nextVaults.append(DecryptedVault(
                id: v.id,
                metadata: meta,
                keyBytes: vk,
                createdAt: v.createdAt,
                updatedAt: v.updatedAt
            ))
        }
        vaultKeyMap = keyMap
        vaults = nextVaults

        var nextItems: [VaultItemPayload] = []
        for row in syncRes.items {
            guard let vk = keyMap[row.vaultId] else { continue }
            if let payload = try? NpCoreBridge.decryptJSON(
                VaultItemPayload.self,
                key: vk,
                blob: row.encryptedData,
                aad: AAD.vaultItem(row.vaultId, row.id)
            ), payload.id == row.id, payload.vaultId == row.vaultId {
                nextItems.append(payload)
            }
        }
        items = nextItems
        aliases = syncRes.aliases ?? []

        if aiEmailExtractions.isEmpty {
            loadAICache()
        }

        var nextEmails: [DecryptedEmailPayload] = []
        if let privKey = emailPrivKeyPkcs8B64 {
            for em in syncRes.emails ?? [] {
                if var opened = try? NpCoreBridge.openSealedJSON(
                    DecryptedEmailPayload.self,
                    privateKeyPkcs8B64: privKey,
                    envelope: em.sealedEnvelope
                ) {
                    opened.id = em.id
                    opened.source = em.source
                    opened.envelopeTo = em.envelopeTo
                    if let cached = aiEmailExtractions[em.id] {
                        if opened.otpCode?.nilIfBlank == nil, let otp = cached.otpCode?.nilIfBlank {
                            opened.otpCode = otp
                        }
                        if opened.magicLink?.nilIfBlank == nil, let link = cached.magicLink?.nilIfBlank {
                            opened.magicLink = link
                        }
                    }
                    nextEmails.append(opened)
                }
            }
        }
        emails = nextEmails
        if let selId = selectedItemId, !nextItems.contains(where: { $0.id == selId }) {
            selectedItemId = nil
        }
        if let selEmailId = selectedEmailId, !nextEmails.contains(where: { $0.id == selEmailId }) {
            selectedEmailId = nil
        }
        refreshTotps()
        pruneExpiredCopiedEmails()

        if aiAutoExtractEmail && isAIConfigured {
            Task { @MainActor [weak self] in
                await self?.extractMissingRecentEmails(limit: 3)
            }
        }
    }

    public func refreshEmails() async {
        guard isUnlocked, !isRefreshingEmails else { return }
        isRefreshingEmails = true
        defer { isRefreshingEmails = false }
        do {
            try await syncAll()
            clipboardRemaining = 0
            clipboardStatus = "已刷新收件验证码"
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                if self.clipboardStatus == "已刷新收件验证码" && self.clipboardRemaining == 0 {
                    self.clipboardStatus = ""
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func createVault(name: String) async throws {
        guard let rootKey = rootKeyBytes else { throw NpCoreError.rustError("Vault 已锁定") }
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }

        let vid = try NpCoreBridge.randomID()
        let vk = try NpCoreBridge.randomBytes(32)
        let encKey = try NpCoreBridge.encryptBytes(key: rootKey, plaintext: vk, aad: AAD.vaultOwnerKey(vid))
        let encMeta = try NpCoreBridge.encryptJSON(
            key: vk,
            value: VaultMetadata(name: clean),
            aad: AAD.vaultMeta(vid)
        )

        struct VaultResp: Decodable { let vault: EncryptedVaultRecord }
        let _: VaultResp = try await apiRequest(
            "/api/vaults",
            method: "POST",
            bodyObj: ["id": vid, "encryptedKey": encKey, "encryptedMeta": encMeta]
        )
        try await syncAll()
        destination = .vault(vid)
    }

    public func saveItem(_ item: VaultItemPayload, isNew: Bool) async throws {
        guard let vk = vaultKeyMap[item.vaultId] else {
            throw NpCoreError.rustError("缺少密码库密钥")
        }
        let now = ISO8601DateFormatter().string(from: Date())
        var updated = item
        if updated.createdAt.isEmpty { updated.createdAt = now }
        updated.updatedAt = now

        let encryptedData = try NpCoreBridge.encryptJSON(
            key: vk,
            value: updated,
            aad: AAD.vaultItem(updated.vaultId, updated.id)
        )

        struct ItemResp: Decodable { let item: EncryptedItemRecord }
        if isNew {
            let _: ItemResp = try await apiRequest(
                "/api/vaults/\(updated.vaultId)/items",
                method: "POST",
                bodyObj: ["id": updated.id, "encryptedData": encryptedData]
            )
        } else {
            let _: ItemResp = try await apiRequest(
                "/api/vaults/\(updated.vaultId)/items/\(updated.id)",
                method: "PUT",
                bodyObj: ["encryptedData": encryptedData]
            )
        }
        items = [updated] + items.filter { $0.id != updated.id }
        selectedItemId = updated.id
        refreshTotps()
    }

    public func addGroup(_ name: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if !customGroups.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            customGroups.append(trimmed)
            saveAISettings()
        }
    }

    public func removeGroup(_ name: String) async {
        customGroups.removeAll { $0.caseInsensitiveCompare(name) == .orderedSame }
        saveAISettings()
        let affected = items.filter { item in
            item.tags.contains { $0.caseInsensitiveCompare(name) == .orderedSame }
        }
        for item in affected {
            var copy = item
            copy.tags.removeAll { $0.caseInsensitiveCompare(name) == .orderedSame }
            try? await saveItem(copy, isNew: false)
        }
        if case .group(let active) = destination, active.caseInsensitiveCompare(name) == .orderedSame {
            destination = .all
        }
    }

    public func toggleItemGroup(_ item: VaultItemPayload, group: String) async {
        let trimmed = group.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        addGroup(trimmed)
        var copy = item
        if copy.tags.contains(where: { $0.caseInsensitiveCompare(trimmed) == .orderedSame }) {
            copy.tags.removeAll { $0.caseInsensitiveCompare(trimmed) == .orderedSame }
        } else {
            copy.tags.append(trimmed)
        }
        do {
            try await saveItem(copy, isNew: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func toggleFavorite(_ item: VaultItemPayload) async {
        var copy = item
        copy.favorite.toggle()
        do {
            try await saveItem(copy, isNew: false)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    public func deleteItem(_ item: VaultItemPayload) async throws {
        struct OkResp: Decodable { let ok: Bool }
        let _: OkResp = try await apiRequest(
            "/api/vaults/\(item.vaultId)/items/\(item.id)",
            method: "DELETE"
        )
        items.removeAll { $0.id == item.id }
        if selectedItemId == item.id {
            selectedItemId = filteredItems.first?.id
        }
    }

    // MARK: - CSV & 2FA Authenticator Import

    public struct ImportSummary {
        public let format: String
        public let total: Int
        public let attached: Int
        public let created: Int
        public let skipped: Int
    }

    public func importText(
        _ rawText: String,
        vaultId: String,
        skipDuplicates: Bool = true
    ) async throws -> ImportSummary {
        guard let vk = vaultKeyMap[vaultId] else {
            throw NpCoreError.rustError("缺少目标密码库密钥")
        }
        let format = try NpCoreBridge.detectImportFormat(rawText)
        let now = ISO8601DateFormatter().string(from: Date())

        if format == "totp" {
            let entries = try NpCoreBridge.parseAuthenticatorExport(rawText)
            let vaultItems = items.filter { $0.vaultId == vaultId }
            let plan = try NpCoreBridge.planTotpImport(existingItems: vaultItems, entries: entries)

            var attached = 0
            var createdPayloads: [VaultItemPayload] = []
            var batchPayload: [[String: String]] = []
            var skipped = 0

            for step in plan {
                switch step.action {
                case "skip_duplicate":
                    skipped += 1
                case "attach":
                    if let targetId = step.itemId,
                       let uri = step.otpauthUri,
                       var target = items.first(where: { $0.id == targetId && $0.vaultId == vaultId })
                    {
                        target.totp = uri
                        try await saveItem(target, isNew: false)
                        attached += 1
                    }
                case "create":
                    let newId = try NpCoreBridge.randomID()
                    let payload = VaultItemPayload(
                        id: newId,
                        vaultId: vaultId,
                        category: .login,
                        title: step.title ?? step.entry.issuer ?? step.entry.account ?? "2FA Token",
                        urls: [],
                        username: step.username,
                        totp: step.totp ?? step.entry.otpauthUri,
                        createdAt: now,
                        updatedAt: now
                    )
                    let enc = try NpCoreBridge.encryptJSON(
                        key: vk,
                        value: payload,
                        aad: AAD.vaultItem(vaultId, newId)
                    )
                    batchPayload.append(["id": newId, "encryptedData": enc])
                    createdPayloads.append(payload)
                default:
                    break
                }
            }

            if !batchPayload.isEmpty {
                struct BatchResp: Decodable { let imported: Int }
                let _: BatchResp = try await apiRequest(
                    "/api/vaults/\(vaultId)/items/batch",
                    method: "POST",
                    bodyObj: ["items": batchPayload]
                )
                items = createdPayloads + items
            }
            refreshTotps()
            return ImportSummary(
                format: "totp",
                total: entries.count,
                attached: attached,
                created: createdPayloads.count,
                skipped: skipped
            )
        }

        // CSV import
        let entries = try NpCoreBridge.parsePasswordCSV(rawText)
        var seen = Set<String>()
        if skipDuplicates {
            for existing in items where existing.vaultId == vaultId {
                seen.insert(NpCoreBridge.itemImportFingerprint(
                    urls: existing.urls,
                    username: existing.username,
                    password: existing.password
                ))
            }
        }

        var batchPayload: [[String: String]] = []
        var createdPayloads: [VaultItemPayload] = []
        var skipped = 0

        for entry in entries {
            let fp = NpCoreBridge.itemImportFingerprint(
                urls: entry.urls,
                username: entry.username,
                password: entry.password
            )
            if skipDuplicates && seen.contains(fp) {
                skipped += 1
                continue
            }
            seen.insert(fp)

            let newId = try NpCoreBridge.randomID()
            let payload = VaultItemPayload(
                id: newId,
                vaultId: vaultId,
                category: entry.category,
                title: entry.title,
                urls: entry.urls,
                username: entry.username,
                password: entry.password,
                totp: entry.totp,
                notes: entry.notes,
                createdAt: now,
                updatedAt: now
            )
            let enc = try NpCoreBridge.encryptJSON(
                key: vk,
                value: payload,
                aad: AAD.vaultItem(vaultId, newId)
            )
            batchPayload.append(["id": newId, "encryptedData": enc])
            createdPayloads.append(payload)
        }

        if !batchPayload.isEmpty {
            struct BatchResp: Decodable { let imported: Int }
            let _: BatchResp = try await apiRequest(
                "/api/vaults/\(vaultId)/items/batch",
                method: "POST",
                bodyObj: ["items": batchPayload]
            )
            items = createdPayloads + items
        }
        refreshTotps()
        return ImportSummary(
            format: "csv",
            total: entries.count,
            attached: 0,
            created: createdPayloads.count,
            skipped: skipped
        )
    }

    // MARK: - IMAP & Email Filter Settings

    private func legacyAccountFallback(from cfg: ImapConfigPublic) -> [ImapAccountPublic] {
        guard !cfg.host.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              !cfg.username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return []
        }
        return [
            ImapAccountPublic(
                id: "legacy-1",
                label: cfg.username,
                enabled: cfg.enabled,
                host: cfg.host,
                port: cfg.port,
                tls: cfg.tls,
                username: cfg.username,
                hasPassword: cfg.hasPassword,
                status: cfg.status,
                lastError: cfg.lastError,
                lastSyncAt: nil
            ),
        ]
    }

    public func loadImapAccounts() async throws {
        struct ImapResp: Decodable {
            let imap: ImapConfigPublic
            let accounts: [ImapAccountPublic]?
        }
        let res: ImapResp = try await apiRequest("/api/imap")
        imapConfig = res.imap
        imapAccounts = res.accounts ?? legacyAccountFallback(from: res.imap)
    }

    public func loadImapConfig() async throws {
        try await loadImapAccounts()
    }

    @discardableResult
    public func saveImapAccount(_ payload: ImapAccountSavePayload) async throws -> ImapAccountPublic {
        struct ImapAccountResp: Decodable {
            let account: ImapAccountPublic?
            let accounts: [ImapAccountPublic]?
            let imap: ImapConfigPublic?
        }
        let data = try JSONEncoder().encode(payload)
        let res: ImapAccountResp
        if let id = payload.id?.nilIfBlank {
            let safeId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
            res = try await apiRequest("/api/imap/accounts/\(safeId)", method: "PUT", bodyObj: data)
        } else {
            res = try await apiRequest("/api/imap/accounts", method: "POST", bodyObj: data)
        }
        if let accounts = res.accounts {
            imapAccounts = accounts
        }
        if let cfg = res.imap {
            imapConfig = cfg
        }
        try? await syncAll()
        if let acct = res.account {
            return acct
        }
        if let id = payload.id?.nilIfBlank, let found = imapAccounts.first(where: { $0.id == id }) {
            return found
        }
        if let matched = imapAccounts.last(where: { $0.username.caseInsensitiveCompare(payload.username) == .orderedSame }) {
            return matched
        }
        return ImapAccountPublic(
            id: payload.id ?? UUID().uuidString,
            label: payload.label.nilIfBlank ?? payload.username,
            enabled: payload.enabled,
            host: payload.host,
            port: payload.port,
            tls: payload.tls,
            username: payload.username,
            hasPassword: payload.password?.nilIfBlank != nil,
            status: res.imap?.status ?? (payload.enabled ? "listening" : "disabled"),
            lastError: res.imap?.lastError,
            lastSyncAt: nil
        )
    }

    public func deleteImapAccount(id: String) async throws {
        struct DeleteImapResp: Decodable {
            let ok: Bool?
            let accounts: [ImapAccountPublic]?
            let imap: ImapConfigPublic?
        }
        let safeId = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        let res: DeleteImapResp = try await apiRequest("/api/imap/accounts/\(safeId)", method: "DELETE")
        if let accounts = res.accounts {
            imapAccounts = accounts
        } else {
            imapAccounts.removeAll { $0.id == id }
        }
        if let cfg = res.imap {
            imapConfig = cfg
        }
    }

    public func testImapAccount(_ payload: ImapAccountSavePayload) async throws -> ImapTestResponse {
        let testPayload = ImapTestPayload(
            id: payload.id,
            host: payload.host,
            port: payload.port,
            tls: payload.tls,
            username: payload.username,
            password: payload.password
        )
        let data = try JSONEncoder().encode(testPayload)
        return try await apiRequest("/api/imap/test", method: "POST", bodyObj: data)
    }

    @discardableResult
    public func saveImapConfig(_ payload: ImapSavePayload) async throws -> ImapConfigPublic {
        struct ImapResp: Decodable {
            let imap: ImapConfigPublic
            let accounts: [ImapAccountPublic]?
        }
        let data = try JSONEncoder().encode(payload)
        let res: ImapResp = try await apiRequest("/api/imap", method: "PUT", bodyObj: data)
        imapConfig = res.imap
        if let accounts = res.accounts {
            imapAccounts = accounts
        }
        try? await syncAll()
        return res.imap
    }

    public func testImapConfig(_ payload: ImapSavePayload) async throws -> ImapTestResponse {
        let data = try JSONEncoder().encode(payload)
        return try await apiRequest("/api/imap/test", method: "POST", bodyObj: data)
    }

    @discardableResult
    public func triggerImapSync(accountId: String? = nil) async -> (ok: Bool, synced: Int, error: String?) {
        struct ImapSyncResp: Decodable {
            let ok: Bool
            let synced: Int?
            let error: String?
            let accounts: [ImapAccountPublic]?
            let imap: ImapConfigPublic?
        }
        let body: [String: String]? = accountId?.nilIfBlank.map { ["id": $0] }
        do {
            let res: ImapSyncResp = try await apiRequest("/api/imap/sync", method: "POST", bodyObj: body)
            if let accounts = res.accounts {
                imapAccounts = accounts
            }
            if let cfg = res.imap {
                imapConfig = cfg
            }
            return (res.ok, res.synced ?? 0, res.error)
        } catch {
            return (false, 0, error.localizedDescription)
        }
    }

    public func loadEmailFilter() async throws {
        let res: EmailFilterConfig = try await apiRequest("/api/email-filter")
        emailFilter = res
    }

    public func saveEmailFilter(_ config: EmailFilterConfig) async throws {
        let data = try JSONEncoder().encode(config)
        let res: EmailFilterConfig = try await apiRequest(
            "/api/email-filter",
            method: "PUT",
            bodyObj: data
        )
        emailFilter = res
    }

    public func deleteEmail(_ email: DecryptedEmailPayload) async {
        struct OkResp: Decodable { let ok: Bool }
        defer { deletingExpiredEmailIds.remove(email.id) }
        if let _: OkResp = try? await apiRequest("/api/emails/\(email.id)", method: "DELETE") {
            emails.removeAll { $0.id == email.id }
        } else {
            emails.removeAll { $0.id == email.id }
        }
        if copiedEmailExpirations.removeValue(forKey: email.id) != nil {
            saveCopiedEmailExpirations()
        }
        if aiEmailExtractions.removeValue(forKey: email.id) != nil {
            saveAICache()
        }
        if selectedEmailId == email.id {
            selectedEmailId = nil
        }
    }

    private func callOpenAIChatCompletion(
        systemPrompt: String,
        userPrompt: String,
        temperature: Double = 0.1
    ) async throws -> String {
        var base = aiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if base.isEmpty { base = "https://api.openai.com/v1" }
        while base.hasSuffix("/") { base.removeLast() }

        let endpoint: String
        if base.hasSuffix("/chat/completions") {
            endpoint = base
        } else if base.hasSuffix("/v1") {
            endpoint = "\(base)/chat/completions"
        } else {
            endpoint = "\(base)/v1/chat/completions"
        }
        guard let url = URL(string: endpoint) else {
            throw NpCoreError.rustError("无效的 AI Base URL: \(endpoint)")
        }

        let host = url.host?.lowercased() ?? ""
        let isLocalModel = host == "127.0.0.1" || host == "localhost"
        let cleanKey = aiApiKey.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanKey.isEmpty && !isLocalModel {
            throw NpCoreError.rustError("请先填写 OpenAI 兼容接口的 API Key")
        }

        let modelName = aiModel.nilIfBlank ?? "gpt-4o-mini"
        let bodyObj: [String: Any] = [
            "model": modelName,
            "temperature": temperature,
            "messages": [
                ["role": "system", "content": systemPrompt],
                ["role": "user", "content": userPrompt],
            ],
        ]

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if !cleanKey.isEmpty {
            req.setValue("Bearer \(cleanKey)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try JSONSerialization.data(withJSONObject: bodyObj, options: [])

        let (data, response) = try await sessionForBase(endpoint).data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status < 200 || status >= 300 {
            let errText = String(data: data, encoding: .utf8) ?? ""
            throw NpCoreError.rustError("AI 接口请求失败 (HTTP \(status)): \(errText.prefix(200))")
        }

        struct ChatCompletionResp: Decodable {
            struct Choice: Decodable {
                struct Message: Decodable { let content: String? }
                let message: Message
            }
            let choices: [Choice]
        }

        let completion = try JSONDecoder().decode(ChatCompletionResp.self, from: data)
        guard var content = completion.choices.first?.message.content?.nilIfBlank else {
            throw NpCoreError.rustError("AI 未返回有效内容")
        }

        if let firstBrace = content.firstIndex(of: "{"),
           let lastBrace = content.lastIndex(of: "}"),
           firstBrace <= lastBrace
        {
            content = String(content[firstBrace...lastBrace])
        }
        return content
    }

    public func generateEmailFilterWithAI(
        prompt: String,
        current: EmailFilterConfig
    ) async throws -> (config: EmailFilterConfig, summary: String) {
        let trimmedPrompt = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedPrompt.isEmpty else {
            throw NpCoreError.rustError("请先描述你的过滤需求")
        }

        saveAISettings()

        let sysPrompt = """
        你是 NonePwd 邮件正则过滤助手。请严格输出一个 JSON 对象，不要包含 Markdown 代码块或任何额外解释文字。
        JSON 格式：
        {"mode":"allow" 或 "deny","otpOnly":true 或 false,"summary":"一句话中文总结规则用途","rules":[{"field":"from" 或 "to" 或 "subject" 或 "body","pattern":"大小写不敏感正则（不要包含首尾 /.../ 修饰符，兼容 Rust regex/PCRE）"}]}
        注意：
        1. 用户说“只收 / 仅保留 ...”时，使用 mode="allow"。
        2. 用户说“屏蔽 / 拦截 / 不要 ...”时，使用 mode="deny"。
        3. 若用户提到“验证码 / OTP”，合理设置 otpOnly 或相应 subject/body 正则。
        """

        let content = try await callOpenAIChatCompletion(
            systemPrompt: sysPrompt,
            userPrompt: trimmedPrompt,
            temperature: 0.1
        )

        struct AIRegexOutput: Decodable {
            struct RuleOut: Decodable {
                let field: String
                let pattern: String
            }
            let mode: String?
            let otpOnly: Bool?
            let summary: String?
            let rules: [RuleOut]?
        }

        guard let jsonData = content.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(AIRegexOutput.self, from: jsonData)
        else {
            throw NpCoreError.rustError("无法解析 AI 返回的 JSON：\(content.prefix(200))")
        }

        var next = current
        next.enabled = true
        if let m = parsed.mode?.lowercased(), let modeEnum = EmailFilterMode(rawValue: m) {
            next.mode = modeEnum
        }
        if let otpOnly = parsed.otpOnly {
            next.otpOnly = otpOnly
        }
        var builtRules: [EmailFilterRule] = []
        for r in parsed.rules ?? [] {
            let pat = r.pattern.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !pat.isEmpty else { continue }
            guard (try? NSRegularExpression(pattern: pat, options: [.caseInsensitive])) != nil else {
                throw NpCoreError.rustError("AI 生成的正则表达式无效: \(pat)")
            }
            let fieldEnum = EmailFilterField(rawValue: r.field.lowercased()) ?? .subject
            builtRules.append(EmailFilterRule(field: fieldEnum, pattern: pat, enabled: true))
        }
        if !builtRules.isEmpty {
            next.rules = builtRules
        }

        let summary = parsed.summary?.nilIfBlank ?? "已生成 \(builtRules.count) 条正则过滤规则"
        return (next, summary)
    }

    // MARK: - AI Active Email OTP Cache & Extraction

    private static let aiCacheAAD = "nonepwd:ai-email-cache:v1"

    private var aiCacheFileURL: URL {
        PrefsStore.appSupportDir.appendingPathComponent("ai-email-cache.enc")
    }

    private func loadAICache() {
        guard let rk = rootKeyBytes,
              let blob = try? String(contentsOf: aiCacheFileURL, encoding: .utf8),
              let decoded = try? NpCoreBridge.decryptJSON(
                  [String: AIEmailExtraction].self,
                  key: rk,
                  blob: blob,
                  aad: Self.aiCacheAAD
              )
        else {
            return
        }
        aiEmailExtractions = decoded
    }

    private func saveAICache() {
        guard let rk = rootKeyBytes else { return }
        if let enc = try? NpCoreBridge.encryptJSON(
            key: rk,
            value: aiEmailExtractions,
            aad: Self.aiCacheAAD
        ) {
            try? FileManager.default.createDirectory(
                at: PrefsStore.appSupportDir,
                withIntermediateDirectories: true
            )
            try? enc.write(to: aiCacheFileURL, atomically: true, encoding: .utf8)
        }
    }

    public func extractEmailOtpWithAI(_ email: DecryptedEmailPayload, force: Bool = false) async {
        guard isUnlocked, !email.id.isEmpty, isAIConfigured else { return }
        if aiExtractingIds.contains(email.id) { return }
        if !force && (aiEmailExtractions[email.id] != nil || aiAttemptedIds.contains(email.id)) {
            return
        }

        aiAttemptedIds.insert(email.id)
        aiExtractingIds.insert(email.id)
        defer { aiExtractingIds.remove(email.id) }

        let bodyPreview = String((email.textBody.nilIfBlank ?? email.snippet).prefix(2000))
        let userContent = """
        From: \(email.from)
        To: \(email.to)
        Subject: \(email.subject)
        Body:
        \(bodyPreview)
        """
        let sysPrompt = """
        从邮件发件人、主题与正文中主动提取登录/验证动态码（OTP）或验证链接。严格只输出 JSON 对象（不要包含 Markdown 代码块）：
        {"hasOtp":true或false,"otpCode":"提取到的验证码字符串或null","magicLink":"验证URL或null","issuer":"服务商简称如GitHub","summary":"12字内中文摘要"}
        """

        do {
            let content = try await callOpenAIChatCompletion(
                systemPrompt: sysPrompt,
                userPrompt: userContent,
                temperature: 0.0
            )
            struct AIExtractPayload: Decodable {
                let hasOtp: Bool?
                let otpCode: String?
                let magicLink: String?
                let issuer: String?
                let summary: String?
            }
            guard let jsonData = content.data(using: .utf8),
                  let parsed = try? JSONDecoder().decode(AIExtractPayload.self, from: jsonData)
            else {
                return
            }
            let cleanCode = parsed.otpCode?.nilIfBlank
            let cleanLink = parsed.magicLink?.nilIfBlank
            let cleanIssuer = parsed.issuer?.nilIfBlank
            let cleanSummary = parsed.summary?.nilIfBlank
            let hasOtpVal = (parsed.hasOtp ?? false) || cleanCode != nil

            let extraction = AIEmailExtraction(
                emailId: email.id,
                hasOtp: hasOtpVal,
                otpCode: cleanCode,
                magicLink: cleanLink,
                issuer: cleanIssuer,
                summary: cleanSummary
            )
            aiEmailExtractions[email.id] = extraction

            if let idx = emails.firstIndex(where: { $0.id == email.id }) {
                var updated = emails[idx]
                if updated.otpCode?.nilIfBlank == nil, let code = cleanCode {
                    updated.otpCode = code
                }
                if updated.magicLink?.nilIfBlank == nil, let link = cleanLink {
                    updated.magicLink = link
                }
                emails[idx] = updated
            }
            saveAICache()
        } catch {
            // Silent fallback so background cron/realtime flows never disrupt vault usage
        }
    }

    public func extractMissingRecentEmails(limit: Int = 5) async {
        guard isUnlocked, isAIConfigured else { return }
        let candidates = Array(emails.prefix(limit))
        for em in candidates {
            if aiEmailExtractions[em.id] == nil && em.otpCode?.nilIfBlank == nil {
                await extractEmailOtpWithAI(em, force: false)
            }
        }
    }

    public func runEmailCronAndAIExtract(forceLatest: Bool = false) async {
        guard isUnlocked, !isRefreshingEmails else { return }
        isRefreshingEmails = true
        defer { isRefreshingEmails = false }
        do {
            if !imapAccounts.filter(\.enabled).isEmpty || imapConfig.enabled || forceLatest {
                await triggerImapSync()
            }
            try await syncAll()
            if isAIConfigured {
                for (idx, em) in emails.prefix(5).enumerated() {
                    let shouldForce = forceLatest && idx == 0
                    if shouldForce || aiEmailExtractions[em.id] == nil {
                        await extractEmailOtpWithAI(em, force: shouldForce)
                    }
                }
            }
            if forceLatest {
                clipboardRemaining = 0
                clipboardStatus = "已刷新并完成 AI 识别"
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(2))
                    if self.clipboardStatus == "已刷新并完成 AI 识别" && self.clipboardRemaining == 0 {
                        self.clipboardStatus = ""
                    }
                }
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - WebSocket Real-Time OTP Push

    private func connectWebSocket() {
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        wsConnected = false
        guard let token = sessionToken else { return }

        let httpBase = normalizedServerBase()
        var wsBase = httpBase
        if wsBase.hasPrefix("https://") {
            wsBase = "wss://" + wsBase.dropFirst("https://".count)
        } else if wsBase.hasPrefix("http://") {
            wsBase = "ws://" + wsBase.dropFirst("http://".count)
        }
        let encodedTok = token.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? token
        guard let wsURL = URL(string: "\(wsBase)/api/ws?token=\(encodedTok)") else { return }

        let task = sessionForBase(httpBase).webSocketTask(with: wsURL)
        wsTask = task
        task.resume()
        task.sendPing { [weak self] error in
            Task { @MainActor [weak self] in
                guard let self, self.wsTask === task, self.isUnlocked else { return }
                if error == nil {
                    self.wsConnected = true
                    self.wsReconnectAttempt = 0
                }
            }
        }
        receiveNextWebSocketMessage(task)
    }

    private func receiveNextWebSocketMessage(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            Task { @MainActor [weak self] in
                guard let self, self.wsTask === task, self.isUnlocked else { return }
                switch result {
                case .success(let message):
                    self.wsConnected = true
                    self.wsReconnectAttempt = 0
                    switch message {
                    case .string(let text):
                        await self.handleWebSocketText(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) {
                            await self.handleWebSocketText(text)
                        }
                    @unknown default:
                        break
                    }
                    self.receiveNextWebSocketMessage(task)
                case .failure:
                    self.wsConnected = false
                    self.scheduleWebSocketReconnect()
                }
            }
        }
    }

    private func scheduleWebSocketReconnect() {
        guard isUnlocked else { return }
        wsReconnectAttempt += 1
        let delay = min(30.0, pow(2.0, Double(min(wsReconnectAttempt, 5))))
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, self.isUnlocked, !self.wsConnected else { return }
            self.connectWebSocket()
        }
    }

    private func handleWebSocketText(_ text: String) async {
        guard let data = text.data(using: .utf8),
              let msg = try? JSONDecoder().decode(WsEnvelope.self, from: data)
        else { return }

        if msg.type == "email.received", let em = msg.email, let privKey = emailPrivKeyPkcs8B64 {
            if var opened = try? NpCoreBridge.openSealedJSON(
                DecryptedEmailPayload.self,
                privateKeyPkcs8B64: privKey,
                envelope: em.sealedEnvelope
            ) {
                opened.id = em.id
                opened.source = em.source
                opened.envelopeTo = em.envelopeTo
                emails = [opened] + emails.filter { $0.id != opened.id }
                if let code = opened.otpCode?.nilIfBlank {
                    clipboardStatus = "收到 \(opened.senderDomain) 验证码 \(code)"
                }
                if aiAutoExtractEmail && isAIConfigured {
                    Task { @MainActor [weak self] in
                        await self?.extractEmailOtpWithAI(opened, force: false)
                    }
                }
            }
        } else if msg.type == "email.deleted", let id = msg.id {
            emails.removeAll { $0.id == id }
            deletingExpiredEmailIds.remove(id)
            if copiedEmailExpirations.removeValue(forKey: id) != nil {
                saveCopiedEmailExpirations()
            }
            if selectedEmailId == id {
                selectedEmailId = nil
            }
        } else if msg.type == "item.upserted"
            || msg.type == "item.deleted"
            || msg.type == "vault.upserted"
            || msg.type == "vault.deleted"
        {
            try? await syncAll()
        }
    }
}
