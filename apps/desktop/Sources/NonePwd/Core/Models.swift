import Foundation

public enum AAD {
    public static let rootKeyset = "nonepwd:root-keyset:v1"

    public static func vaultMeta(_ vaultId: String) -> String {
        "nonepwd:vault:\(vaultId):meta"
    }

    public static func vaultOwnerKey(_ vaultId: String) -> String {
        "nonepwd:vault:\(vaultId):owner-key"
    }

    public static func vaultItem(_ vaultId: String, _ itemId: String) -> String {
        "nonepwd:vault:\(vaultId):item:\(itemId)"
    }
}

public enum ItemCategory: String, Codable, CaseIterable, Hashable, Sendable {
    case login
    case card
    case identity
    case apiCredential = "api_credential"
    case sshKey = "ssh_key"
    case secureNote = "secure_note"

    public var label: String {
        switch self {
        case .login: return "网站登录"
        case .card: return "银行卡"
        case .identity: return "地址身份"
        case .apiCredential: return "API 密钥"
        case .sshKey: return "SSH 密钥"
        case .secureNote: return "安全笔记"
        }
    }

    public var systemImage: String {
        switch self {
        case .login: return "globe"
        case .card: return "creditcard.fill"
        case .identity: return "person.text.rectangle.fill"
        case .apiCredential: return "chevron.left.forwardslash.chevron.right"
        case .sshKey: return "terminal.fill"
        case .secureNote: return "note.text"
        }
    }
}

public struct CardDetails: Codable, Equatable, Hashable, Sendable {
    public var cardholderName: String?
    public var number: String?
    public var expMonth: String?
    public var expYear: String?
    public var cvv: String?
    public var brand: String?

    public init(
        cardholderName: String? = nil,
        number: String? = nil,
        expMonth: String? = nil,
        expYear: String? = nil,
        cvv: String? = nil,
        brand: String? = nil
    ) {
        self.cardholderName = cardholderName
        self.number = number
        self.expMonth = expMonth
        self.expYear = expYear
        self.cvv = cvv
        self.brand = brand
    }

    public var isEmpty: Bool {
        [cardholderName, number, expMonth, expYear, cvv, brand]
            .allSatisfy { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    public var last4: String {
        let digits = (number ?? "").filter(\.isNumber)
        guard !digits.isEmpty else { return "" }
        return String(digits.suffix(4))
    }

    public var formattedExpiry: String {
        let m = (expMonth ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let y = (expYear ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !m.isEmpty || !y.isEmpty else { return "" }
        let paddedM = m.count == 1 ? "0\(m)" : m
        let shortY = y.count == 4 ? String(y.suffix(2)) : y
        return "\(paddedM)/\(shortY)"
    }
}

public struct IdentityDetails: Codable, Equatable, Hashable, Sendable {
    public var fullName: String?
    public var firstName: String?
    public var lastName: String?
    public var email: String?
    public var phone: String?
    public var company: String?
    public var address1: String?
    public var address2: String?
    public var city: String?
    public var state: String?
    public var postalCode: String?
    public var country: String?

    public init(
        fullName: String? = nil,
        firstName: String? = nil,
        lastName: String? = nil,
        email: String? = nil,
        phone: String? = nil,
        company: String? = nil,
        address1: String? = nil,
        address2: String? = nil,
        city: String? = nil,
        state: String? = nil,
        postalCode: String? = nil,
        country: String? = nil
    ) {
        self.fullName = fullName
        self.firstName = firstName
        self.lastName = lastName
        self.email = email
        self.phone = phone
        self.company = company
        self.address1 = address1
        self.address2 = address2
        self.city = city
        self.state = state
        self.postalCode = postalCode
        self.country = country
    }

    public var isEmpty: Bool {
        [
            fullName, firstName, lastName, email, phone, company,
            address1, address2, city, state, postalCode, country,
        ].allSatisfy { ($0 ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    public var displayName: String {
        if let f = fullName?.nilIfBlank { return f }
        let combined = [lastName, firstName].compactMap { $0?.nilIfBlank }.joined()
        return combined
    }

    public var formattedAddressBlock: String {
        var lines: [String] = []
        let nameLine = displayName
        if !nameLine.isEmpty { lines.append(nameLine) }
        if let phone = phone?.nilIfBlank { lines.append(phone) }
        if let company = company?.nilIfBlank { lines.append(company) }
        let street = [address1, address2].compactMap { $0?.nilIfBlank }.joined(separator: " ")
        if !street.isEmpty { lines.append(street) }
        let region = [country, state, city, postalCode].compactMap { $0?.nilIfBlank }.joined(separator: " ")
        if !region.isEmpty { lines.append(region) }
        if let email = email?.nilIfBlank { lines.append(email) }
        return lines.joined(separator: "\n")
    }
}

public struct CustomField: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var value: String
    public var fieldType: String

    enum CodingKeys: String, CodingKey {
        case id, label, value
        case fieldType = "type"
    }

    public init(id: String, label: String, value: String, fieldType: String = "concealed") {
        self.id = id
        self.label = label
        self.value = value
        self.fieldType = fieldType
    }
}

public struct VaultItemPayload: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var vaultId: String
    public var category: ItemCategory
    public var title: String
    public var favorite: Bool
    public var tags: [String]
    public var urls: [String]
    public var username: String?
    public var password: String?
    public var totp: String?
    public var emailAlias: String?
    public var notes: String?
    public var card: CardDetails?
    public var identity: IdentityDetails?
    public var customFields: [CustomField]
    public var createdAt: String
    public var updatedAt: String
    public var lastUsedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, vaultId, category, title, favorite, tags, urls, username, password, totp,
             emailAlias, notes, card, identity, customFields, createdAt, updatedAt, lastUsedAt
    }

    public init(
        id: String,
        vaultId: String,
        category: ItemCategory,
        title: String,
        favorite: Bool = false,
        tags: [String] = [],
        urls: [String] = [],
        username: String? = nil,
        password: String? = nil,
        totp: String? = nil,
        emailAlias: String? = nil,
        notes: String? = nil,
        card: CardDetails? = nil,
        identity: IdentityDetails? = nil,
        customFields: [CustomField] = [],
        createdAt: String,
        updatedAt: String,
        lastUsedAt: String? = nil
    ) {
        self.id = id
        self.vaultId = vaultId
        self.category = category
        self.title = title
        self.favorite = favorite
        self.tags = tags
        self.urls = urls
        self.username = username
        self.password = password
        self.totp = totp
        self.emailAlias = emailAlias
        self.notes = notes
        self.card = card
        self.identity = identity
        self.customFields = customFields
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.lastUsedAt = lastUsedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        vaultId = try c.decode(String.self, forKey: .vaultId)
        category = try c.decode(ItemCategory.self, forKey: .category)
        title = try c.decode(String.self, forKey: .title)
        favorite = try c.decodeIfPresent(Bool.self, forKey: .favorite) ?? false
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        urls = try c.decodeIfPresent([String].self, forKey: .urls) ?? []
        username = try c.decodeIfPresent(String.self, forKey: .username)
        password = try c.decodeIfPresent(String.self, forKey: .password)
        totp = try c.decodeIfPresent(String.self, forKey: .totp)
        emailAlias = try c.decodeIfPresent(String.self, forKey: .emailAlias)
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        card = try c.decodeIfPresent(CardDetails.self, forKey: .card)
        identity = try c.decodeIfPresent(IdentityDetails.self, forKey: .identity)
        customFields = try c.decodeIfPresent([CustomField].self, forKey: .customFields) ?? []
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        lastUsedAt = try c.decodeIfPresent(String.self, forKey: .lastUsedAt)
    }

    public var subtitle: String {
        switch category {
        case .card:
            let brand = card?.brand?.nilIfBlank ?? "银行卡"
            let last4 = card?.last4 ?? ""
            if !last4.isEmpty {
                return "\(brand) •••• \(last4)"
            }
            return card?.cardholderName?.nilIfBlank ?? brand
        case .identity:
            let cityStreet = [identity?.city, identity?.address1]
                .compactMap { $0?.nilIfBlank }
                .joined(separator: " · ")
            if !cityStreet.isEmpty { return cityStreet }
            return identity?.phone?.nilIfBlank ?? identity?.email?.nilIfBlank ?? "身份与地址"
        default:
            return username?.nilIfBlank
                ?? emailAlias?.nilIfBlank
                ?? urls.first?.nilIfBlank
                ?? category.label
        }
    }
}

public struct VaultMetadata: Codable, Equatable, Hashable, Sendable {
    public var name: String
    public var description: String?
    public var icon: String?
    public var color: String?

    public init(name: String, description: String? = nil, icon: String? = nil, color: String? = nil) {
        self.name = name
        self.description = description
        self.icon = icon
        self.color = color
    }
}

public struct DecryptedVault: Identifiable, Hashable, Sendable {
    public let id: String
    public let metadata: VaultMetadata
    public let keyBytes: Data
    public let createdAt: String
    public let updatedAt: String
}

public struct RootKeysetPayload: Codable, Equatable, Sendable {
    public let rootKeyB64: String
    public let emailPrivateKeyPkcs8B64: String
}

public struct SealedEnvelope: Codable, Equatable, Sendable {
    public let v: Int
    public let epk: String
    public let iv: String
    public let ct: String
}

public struct DecryptedEmailPayload: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public let from: String
    public let to: String
    public let subject: String
    public let snippet: String
    public let textBody: String
    public var otpCode: String?
    public let confidence: Double
    public var magicLink: String?
    public let senderDomain: String
    public let receivedAt: String
    public var source: String = "imap"
    public var envelopeTo: String? = nil

    enum CodingKeys: String, CodingKey {
        case id, from, to, subject, snippet, textBody, otpCode, confidence, magicLink, senderDomain, receivedAt
    }

    public init(
        id: String = UUID().uuidString,
        from: String,
        to: String,
        subject: String,
        snippet: String,
        textBody: String,
        otpCode: String?,
        confidence: Double,
        magicLink: String?,
        senderDomain: String,
        receivedAt: String,
        source: String = "imap",
        envelopeTo: String? = nil
    ) {
        self.id = id
        self.from = from
        self.to = to
        self.subject = subject
        self.snippet = snippet
        self.textBody = textBody
        self.otpCode = otpCode
        self.confidence = confidence
        self.magicLink = magicLink
        self.senderDomain = senderDomain
        self.receivedAt = receivedAt
        self.source = source
        self.envelopeTo = envelopeTo
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        from = try c.decode(String.self, forKey: .from)
        to = try c.decode(String.self, forKey: .to)
        subject = try c.decode(String.self, forKey: .subject)
        snippet = try c.decodeIfPresent(String.self, forKey: .snippet) ?? ""
        textBody = try c.decodeIfPresent(String.self, forKey: .textBody) ?? ""
        otpCode = try c.decodeIfPresent(String.self, forKey: .otpCode)
        confidence = try c.decodeIfPresent(Double.self, forKey: .confidence) ?? 0
        magicLink = try c.decodeIfPresent(String.self, forKey: .magicLink)
        senderDomain = try c.decodeIfPresent(String.self, forKey: .senderDomain) ?? ""
        receivedAt = try c.decodeIfPresent(String.self, forKey: .receivedAt) ?? ""
    }
}

public struct EncryptedVaultRecord: Codable, Sendable {
    public let id: String
    public let encryptedKey: String
    public let encryptedMeta: String
    public let createdAt: String
    public let updatedAt: String
}

public struct EncryptedItemRecord: Codable, Sendable {
    public let id: String
    public let vaultId: String
    public let encryptedData: String
    public let createdAt: String
    public let updatedAt: String
    public let version: Int
}

public struct EncryptedEmailRecord: Codable, Sendable {
    public let id: String
    public let source: String
    public let envelopeTo: String?
    public let hasOtp: Bool
    public let sealedEnvelope: SealedEnvelope
    public let receivedAt: String
}

public struct AliasRecord: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let address: String
    public let siteDomain: String?
    public let vaultId: String?
    public let itemId: String?
    public let enabled: Bool
    public let receivedCount: Int
    public let createdAt: String
}

public enum EmailFilterMode: String, Codable, CaseIterable, Sendable {
    case allow
    case deny

    public var label: String {
        switch self {
        case .allow: return "仅允许匹配规则的邮件（白名单）"
        case .deny: return "拦截匹配规则的邮件（黑名单）"
        }
    }
}

public enum EmailFilterField: String, Codable, CaseIterable, Sendable {
    case from
    case to
    case subject
    case body

    public var label: String {
        switch self {
        case .from: return "发件人 (From)"
        case .to: return "收件人 (To)"
        case .subject: return "主题 (Subject)"
        case .body: return "正文 (Body)"
        }
    }
}

public struct EmailFilterRule: Codable, Identifiable, Equatable, Sendable {
    public var id: String
    public var field: EmailFilterField
    public var pattern: String
    public var enabled: Bool

    public init(id: String = UUID().uuidString, field: EmailFilterField = .subject, pattern: String = "", enabled: Bool = true) {
        self.id = id
        self.field = field
        self.pattern = pattern
        self.enabled = enabled
    }
}

public struct EmailFilterConfig: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var otpOnly: Bool
    public var mode: EmailFilterMode
    public var rules: [EmailFilterRule]

    public init(
        enabled: Bool = false,
        otpOnly: Bool = false,
        mode: EmailFilterMode = .allow,
        rules: [EmailFilterRule] = []
    ) {
        self.enabled = enabled
        self.otpOnly = otpOnly
        self.mode = mode
        self.rules = rules
    }
}

public struct ImapConfigPublic: Codable, Equatable, Sendable {
    public var enabled: Bool
    public var host: String
    public var port: Int
    public var tls: Bool
    public var username: String
    public var hasPassword: Bool
    public var status: String
    public var lastError: String?

    public init(
        enabled: Bool = false,
        host: String = "",
        port: Int = 993,
        tls: Bool = true,
        username: String = "",
        hasPassword: Bool = false,
        status: String = "disabled",
        lastError: String? = nil
    ) {
        self.enabled = enabled
        self.host = host
        self.port = port
        self.tls = tls
        self.username = username
        self.hasPassword = hasPassword
        self.status = status
        self.lastError = lastError
    }
}

public struct ImapAccountPublic: Codable, Identifiable, Equatable, Hashable, Sendable {
    public var id: String
    public var label: String
    public var enabled: Bool
    public var host: String
    public var port: Int
    public var tls: Bool
    public var username: String
    public var hasPassword: Bool
    public var status: String
    public var lastError: String?
    public var lastSyncAt: String?

    enum CodingKeys: String, CodingKey {
        case id, label, enabled, host, port, tls, username, hasPassword, status, lastError, lastSyncAt
    }

    public init(
        id: String,
        label: String = "",
        enabled: Bool = true,
        host: String = "",
        port: Int = 993,
        tls: Bool = true,
        username: String = "",
        hasPassword: Bool = false,
        status: String = "disabled",
        lastError: String? = nil,
        lastSyncAt: String? = nil
    ) {
        self.id = id
        self.label = label
        self.enabled = enabled
        self.host = host
        self.port = port
        self.tls = tls
        self.username = username
        self.hasPassword = hasPassword
        self.status = status
        self.lastError = lastError
        self.lastSyncAt = lastSyncAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decodeIfPresent(String.self, forKey: .label) ?? ""
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        host = try c.decodeIfPresent(String.self, forKey: .host) ?? ""
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? 993
        tls = try c.decodeIfPresent(Bool.self, forKey: .tls) ?? true
        username = try c.decodeIfPresent(String.self, forKey: .username) ?? ""
        hasPassword = try c.decodeIfPresent(Bool.self, forKey: .hasPassword) ?? false
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "disabled"
        lastError = try c.decodeIfPresent(String.self, forKey: .lastError)
        lastSyncAt = try c.decodeIfPresent(String.self, forKey: .lastSyncAt)
    }
}

public struct ImapAccountSavePayload: Encodable, Sendable {
    public var id: String?
    public var label: String
    public var enabled: Bool
    public var host: String
    public var port: Int
    public var tls: Bool
    public var username: String
    public var password: String?

    public init(
        id: String? = nil,
        label: String = "",
        enabled: Bool = true,
        host: String,
        port: Int = 993,
        tls: Bool = true,
        username: String,
        password: String? = nil
    ) {
        self.id = id
        self.label = label
        self.enabled = enabled
        self.host = host
        self.port = port
        self.tls = tls
        self.username = username
        self.password = password
    }
}

public struct ImapSavePayload: Encodable, Sendable {
    public var id: String?
    public var enabled: Bool
    public var host: String
    public var port: Int
    public var tls: Bool
    public var username: String
    public var password: String?

    public init(
        id: String? = nil,
        enabled: Bool,
        host: String,
        port: Int,
        tls: Bool,
        username: String,
        password: String? = nil
    ) {
        self.id = id
        self.enabled = enabled
        self.host = host
        self.port = port
        self.tls = tls
        self.username = username
        self.password = password
    }
}

public struct ImapTestPayload: Encodable, Sendable {
    public var id: String?
    public var host: String
    public var port: Int
    public var tls: Bool
    public var username: String
    public var password: String?

    public init(
        id: String? = nil,
        host: String,
        port: Int = 993,
        tls: Bool = true,
        username: String,
        password: String? = nil
    ) {
        self.id = id
        self.host = host
        self.port = port
        self.tls = tls
        self.username = username
        self.password = password
    }
}

public struct ImapTestResponse: Decodable, Sendable {
    public let ok: Bool
    public let messages: Int?
    public let error: String?
}

public struct TotpResult: Codable, Equatable, Sendable {
    public let code: String
    public let period: Int
    public let remainingSeconds: Int
    public let progress: Double
}

public struct DerivedAccountKeys: Codable, Equatable, Sendable {
    public let masterUnlockKeyB64: String
    public let authVerifierB64: String
}

public struct CsvImportedEntry: Codable, Equatable, Sendable {
    public let category: ItemCategory
    public let title: String
    public let urls: [String]
    public let username: String?
    public let password: String?
    public let totp: String?
    public let notes: String?
}

public struct TotpImportEntry: Codable, Equatable, Sendable {
    public let issuer: String?
    public let account: String?
    public let secret: String
    public let otpauthUri: String
    public let digits: Int
    public let period: Int
    public let algorithm: String
}

public struct TotpImportPlanItem: Codable, Equatable, Sendable {
    public let entry: TotpImportEntry
    public let action: String
    public let existingItemId: String?
    public let itemId: String?
    public let otpauthUri: String?
    public let title: String?
    public let username: String?
    public let totp: String?
}

public extension String {
    var nilIfBlank: String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
