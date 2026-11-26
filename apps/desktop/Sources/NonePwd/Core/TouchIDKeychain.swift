import Foundation
import LocalAuthentication
import Security

public enum UnlockRememberDuration: String, CaseIterable, Codable, Identifiable, Sendable {
    case hours3 = "3h"
    case hours24 = "24h"
    case days7 = "7d"
    case session = "session"

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .hours3: return "3 小时"
        case .hours24: return "24 小时"
        case .days7: return "7 天"
        case .session: return "仅本次"
        }
    }

    public var seconds: TimeInterval? {
        switch self {
        case .hours3: return 3 * 3600
        case .hours24: return 24 * 3600
        case .days7: return 7 * 86400
        case .session: return nil
        }
    }
}

public struct DesktopPrefs: Codable, Equatable, Sendable {
    public var serverURL: String
    public var email: String?
    public var secretKey: String?
    public var rememberDevice: Bool
    public var touchIDEnabled: Bool
    public var aiBaseURL: String?
    public var aiApiKey: String?
    public var aiModel: String?
    public var unlockDurationRaw: String?
    public var emailCronMinutes: Int?
    public var aiAutoExtractEmail: Bool?
    public var savedGroups: [String]?

    public init(
        serverURL: String = "http://127.0.0.1:8787",
        email: String? = nil,
        secretKey: String? = nil,
        rememberDevice: Bool = true,
        touchIDEnabled: Bool = false,
        aiBaseURL: String? = nil,
        aiApiKey: String? = nil,
        aiModel: String? = nil,
        unlockDurationRaw: String? = "24h",
        emailCronMinutes: Int? = 1,
        aiAutoExtractEmail: Bool? = false,
        savedGroups: [String]? = nil
    ) {
        self.serverURL = serverURL
        self.email = email
        self.secretKey = secretKey
        self.rememberDevice = rememberDevice
        self.touchIDEnabled = touchIDEnabled
        self.aiBaseURL = aiBaseURL
        self.aiApiKey = aiApiKey
        self.aiModel = aiModel
        self.unlockDurationRaw = unlockDurationRaw
        self.emailCronMinutes = emailCronMinutes
        self.aiAutoExtractEmail = aiAutoExtractEmail
        self.savedGroups = savedGroups
    }
}

public struct RememberedDesktopSession: Codable, Sendable {
    public let serverURL: String
    public let token: String
    public let rootKeyB64: String
    public let emailPrivateKeyPkcs8B64: String
    public let accountEmail: String
    public let aliasDomain: String
    public let expiresAt: Date

    public init(
        serverURL: String,
        token: String,
        rootKeyB64: String,
        emailPrivateKeyPkcs8B64: String,
        accountEmail: String,
        aliasDomain: String,
        expiresAt: Date
    ) {
        self.serverURL = serverURL
        self.token = token
        self.rootKeyB64 = rootKeyB64
        self.emailPrivateKeyPkcs8B64 = emailPrivateKeyPkcs8B64
        self.accountEmail = accountEmail
        self.aliasDomain = aliasDomain
        self.expiresAt = expiresAt
    }
}

public enum SessionKeychain {
    private static let service = "dev.nonepwd.macos.remembered_session"
    private static let account = "active"

    public static func save(_ session: RememberedDesktopSession) {
        guard let data = try? JSONEncoder().encode(session) else { return }
        clear()
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemAdd(attrs as CFDictionary, nil)
    }

    public static func loadValid(matchingServerURL: String) -> RememberedDesktopSession? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let decoded = try? JSONDecoder().decode(RememberedDesktopSession.self, from: data)
        else {
            return nil
        }
        if Date() >= decoded.expiresAt {
            clear()
            return nil
        }
        guard decoded.serverURL == matchingServerURL else {
            return nil
        }
        return decoded
    }

    public static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public enum AIKeychain {
    private static let service = "dev.nonepwd.macos.ai_api_key"
    private static let account = "default"

    public static func save(_ apiKey: String?) {
        let trimmed = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        clear()
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else { return }
        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data,
        ]
        SecItemAdd(attrs as CFDictionary, nil)
    }

    public static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess,
              let data = result as? Data,
              let value = String(data: data, encoding: .utf8),
              !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return nil
        }
        return value
    }

    public static func clear() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public struct QuickUnlockCredentials: Codable, Equatable, Sendable {
    public let serverURL: String
    public let secretKey: String
    public let authVerifierB64: String?
    public let rootKeyB64: String?
    public let emailPrivateKeyPkcs8B64: String?
    public let accountEmail: String?
    public let aliasDomain: String?
    // Legacy-only field decoded from pre-migration Keychain items; never persisted by new writes.
    public let masterPassword: String?

    public init(
        serverURL: String,
        secretKey: String,
        authVerifierB64: String?,
        rootKeyB64: String,
        emailPrivateKeyPkcs8B64: String,
        accountEmail: String,
        aliasDomain: String
    ) {
        self.serverURL = serverURL
        self.secretKey = secretKey
        self.authVerifierB64 = authVerifierB64
        self.rootKeyB64 = rootKeyB64
        self.emailPrivateKeyPkcs8B64 = emailPrivateKeyPkcs8B64
        self.accountEmail = accountEmail
        self.aliasDomain = aliasDomain
        self.masterPassword = nil
    }
}

public enum PrefsStore {
    public static var appSupportDir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return base.appendingPathComponent("dev.nonepwd.macos", isDirectory: true)
    }

    private static var prefsURL: URL {
        appSupportDir.appendingPathComponent("prefs.json")
    }

    public static func syncBundledBrowserExtension() -> URL? {
        let fm = FileManager.default
        let dest = appSupportDir.appendingPathComponent("browser-extension", isDirectory: true)
        let bundled = Bundle.main.resourceURL?.appendingPathComponent("browser-extension", isDirectory: true)
        let envFallback = ProcessInfo.processInfo.environment["NONEPWD_EXTENSION_DIST"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }

        let source = [bundled, envFallback]
            .compactMap { $0 }
            .first { fm.fileExists(atPath: $0.appendingPathComponent("manifest.json").path) }

        guard let source else {
            return fm.fileExists(atPath: dest.appendingPathComponent("manifest.json").path) ? dest : nil
        }

        try? fm.createDirectory(at: appSupportDir, withIntermediateDirectories: true)
        try? fm.removeItem(at: dest)
        try? fm.copyItem(at: source, to: dest)
        return dest
    }

    public static func writeSecureFile(_ data: Data, to url: URL) throws {
        let fm = FileManager.default
        let dir = url.deletingLastPathComponent()
        try fm.createDirectory(
            at: dir,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let tmpURL = dir.appendingPathComponent(".tmp-\(UUID().uuidString)")
        let created = fm.createFile(
            atPath: tmpURL.path,
            contents: data,
            attributes: [.posixPermissions: 0o600]
        )
        guard created else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey: "Unable to create secure preferences file"]
            )
        }
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tmpURL.path)
        if rename(tmpURL.path, url.path) != 0 {
            let err = errno
            try? fm.removeItem(at: tmpURL)
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(err),
                userInfo: [NSLocalizedDescriptionKey: "Unable to atomically replace preferences file"]
            )
        }
    }

    public static func load() -> DesktopPrefs {
        guard let data = try? Data(contentsOf: prefsURL),
              var decoded = try? JSONDecoder().decode(DesktopPrefs.self, from: data)
        else {
            var defaults = DesktopPrefs()
            defaults.aiApiKey = AIKeychain.load()
            return defaults
        }
        if let legacyKey = decoded.aiApiKey?.trimmingCharacters(in: .whitespacesAndNewlines),
           !legacyKey.isEmpty
        {
            AIKeychain.save(legacyKey)
            decoded.aiApiKey = nil
            if let sanitized = try? JSONEncoder().encode(decoded) {
                try? writeSecureFile(sanitized, to: prefsURL)
            }
        }
        decoded.aiApiKey = AIKeychain.load()
        return decoded
    }

    public static func save(_ prefs: DesktopPrefs) {
        AIKeychain.save(prefs.aiApiKey)
        var clean = prefs
        clean.aiApiKey = nil
        if !clean.rememberDevice {
            clean.secretKey = nil
        }
        guard let data = try? JSONEncoder().encode(clean) else { return }
        try? writeSecureFile(data, to: prefsURL)
    }
}

public enum TouchIDKeychain {
    private static let service = "dev.nonepwd.macos.quickunlock"
    private static let account = "owner"

    public static func biometryAvailable() -> (available: Bool, label: String) {
        let ctx = LAContext()
        var err: NSError?
        let canBio = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
        if canBio {
            switch ctx.biometryType {
            case .touchID:
                return (true, "使用 Touch ID 解锁")
            case .opticID:
                return (true, "使用 Optic ID 解锁")
            case .faceID:
                return (true, "使用 Face ID 解锁")
            default:
                return (true, "使用生物识别解锁")
            }
        }
        // Also check deviceOwnerAuthentication (Mac password / Apple Watch) when Touch ID is unavailable (e.g. clamshell)
        if ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) {
            return (true, "使用系统认证解锁")
        }
        return (false, "Touch ID 不可用")
    }

    public static func hasSavedQuickUnlock() -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnAttributes as String: false,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil) == errSecSuccess
    }

    public static func saveQuickUnlock(_ creds: QuickUnlockCredentials) throws {
        let data = try JSONEncoder().encode(creds)
        deleteQuickUnlock()

        let attrs: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecValueData as String: data,
        ]
        let status = SecItemAdd(attrs as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw NSError(
                domain: NSOSStatusErrorDomain,
                code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "无法保存钥匙串快捷解锁凭据 (OSStatus \(status))"]
            )
        }
    }

    public static func deleteQuickUnlock() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }

    public static func authenticateAndLoadQuickUnlock() async throws -> QuickUnlockCredentials {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "改用主密码"

        let policy: LAPolicy = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            ? .deviceOwnerAuthenticationWithBiometrics
            : .deviceOwnerAuthentication

        let authorized = try await ctx.evaluatePolicy(
            policy,
            localizedReason: "解锁 NonePwd 零知识密码库"
        )
        guard authorized else {
            throw NpCoreError.rustError("Touch ID 验证已取消")
        }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let data = result as? Data else {
            throw NpCoreError.rustError("未在钥匙串找到快捷解锁凭据，请先用主密码解锁一次")
        }
        return try JSONDecoder().decode(QuickUnlockCredentials.self, from: data)
    }
}
