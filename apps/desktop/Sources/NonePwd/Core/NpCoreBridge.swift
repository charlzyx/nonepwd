#if canImport(CNpCore)
import CNpCore
#endif
import Foundation

public enum NpCoreError: LocalizedError {
    case invalidInputEncoding
    case invalidResponseEncoding
    case rustError(String)
    case invalidBase64Url(String)

    public var errorDescription: String? {
        switch self {
        case .invalidInputEncoding:
            return "无法编码 Rust Core JSON 请求"
        case .invalidResponseEncoding:
            return "Rust Core 返回了无效响应"
        case .rustError(let msg):
            return msg
        case .invalidBase64Url(let value):
            return "无效的 Base64URL 数据: \(value.prefix(24))"
        }
    }
}

public extension Data {
    init(base64URLEncoded str: String) throws {
        var s = str.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let rem = s.count % 4
        if rem > 0 {
            s.append(String(repeating: "=", count: 4 - rem))
        }
        guard let decoded = Data(base64Encoded: s) else {
            throw NpCoreError.invalidBase64Url(str)
        }
        self = decoded
    }

    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

private struct EnvelopeResponse<T: Decodable>: Decodable {
    let ok: Bool
    let result: T?
    let error: String?
}

public enum NpCoreBridge {
    private static let lock = NSLock()
    private static let decoder = JSONDecoder()
    private static let encoder = JSONEncoder()

    public static func invoke<R: Decodable>(_ op: String, args: [String: Any] = [:]) throws -> R {
        let payload: [String: Any] = ["op": op, "args": args]
        let reqData = try JSONSerialization.data(withJSONObject: payload, options: [])

        let respData: Data = lock.withLock {
            var outLen: Int = 0
            let outPtr: UnsafeMutablePointer<UInt8>? = reqData.withUnsafeBytes { rawBuf in
                let ptr = rawBuf.bindMemory(to: UInt8.self).baseAddress
                return np_invoke_native(ptr, rawBuf.count, &outLen)
            }
            guard let outPtr, outLen > 0 else {
                return Data()
            }
            defer { np_free_result(outPtr, outLen) }
            return Data(bytes: outPtr, count: outLen)
        }

        guard !respData.isEmpty else {
            throw NpCoreError.invalidResponseEncoding
        }
        let env = try decoder.decode(EnvelopeResponse<R>.self, from: respData)
        if !env.ok {
            throw NpCoreError.rustError(env.error ?? "Rust Core op \(op) failed")
        }
        guard let result = env.result else {
            throw NpCoreError.invalidResponseEncoding
        }
        return result
    }

    private static func encodableToJSONObject<T: Encodable>(_ value: T) throws -> Any {
        let data = try encoder.encode(value)
        return try JSONSerialization.jsonObject(with: data, options: [])
    }

    public static func randomID() throws -> String {
        try invoke("random_id")
    }

    public static func randomBytes(_ count: Int) throws -> Data {
        let b64: String = try invoke("random_bytes", args: ["len": count])
        return try Data(base64URLEncoded: b64)
    }

    public static func generateSecretKey() throws -> String {
        try invoke("generate_secret_key")
    }

    public static func deriveAccountKeys(
        masterPassword: String,
        secretKey: String,
        kdfSaltB64: String,
        iterations: Int
    ) throws -> DerivedAccountKeys {
        try invoke(
            "derive_account_keys",
            args: [
                "masterPassword": masterPassword,
                "secretKey": secretKey,
                "kdfSaltB64": kdfSaltB64,
                "iterations": iterations,
            ]
        )
    }

    public static func encryptBytes(key: Data, plaintext: Data, aad: String?) throws -> String {
        var args: [String: Any] = [
            "keyB64": key.base64URLEncodedString(),
            "plaintextB64": plaintext.base64URLEncodedString(),
        ]
        if let aad { args["aad"] = aad }
        return try invoke("encrypt_bytes", args: args)
    }

    public static func decryptBytes(key: Data, blob: String, aad: String?) throws -> Data {
        var args: [String: Any] = [
            "keyB64": key.base64URLEncodedString(),
            "blob": blob,
        ]
        if let aad { args["aad"] = aad }
        let ptB64: String = try invoke("decrypt_bytes", args: args)
        return try Data(base64URLEncoded: ptB64)
    }

    public static func encryptJSON<T: Encodable>(key: Data, value: T, aad: String?) throws -> String {
        let jsonData = try encoder.encode(value)
        return try encryptBytes(key: key, plaintext: jsonData, aad: aad)
    }

    public static func decryptJSON<T: Decodable>(_ type: T.Type, key: Data, blob: String, aad: String?) throws -> T {
        let ptData = try decryptBytes(key: key, blob: blob, aad: aad)
        return try decoder.decode(T.self, from: ptData)
    }

    public static func openSealedJSON<T: Decodable>(
        _ type: T.Type,
        privateKeyPkcs8B64: String,
        envelope: SealedEnvelope,
        info: String = "nonepwd-email-v1"
    ) throws -> T {
        let envObj = try encodableToJSONObject(envelope)
        let ptB64: String = try invoke(
            "open_sealed_envelope",
            args: [
                "privateKeyPkcs8B64": privateKeyPkcs8B64,
                "envelope": envObj,
                "info": info,
            ]
        )
        let ptData = try Data(base64URLEncoded: ptB64)
        return try decoder.decode(T.self, from: ptData)
    }

    public static func generateEmailKeyPair() throws -> (publicKeyB64: String, privateKeyPkcs8B64: String) {
        struct Pair: Decodable {
            let publicKeyB64: String
            let privateKeyPkcs8B64: String
        }
        let p: Pair = try invoke("generate_email_key_pair")
        return (p.publicKeyB64, p.privateKeyPkcs8B64)
    }

    public static func generateTOTP(_ input: String, timestampMs: UInt64? = nil) throws -> TotpResult {
        let ms = timestampMs ?? UInt64(Date().timeIntervalSince1970 * 1000)
        return try invoke("generate_totp", args: ["input": input, "timestampMs": ms])
    }

    public static func generatePassword(
        length: Int = 20,
        uppercase: Bool = true,
        lowercase: Bool = true,
        digits: Bool = true,
        symbols: Bool = true
    ) throws -> String {
        try invoke(
            "generate_password",
            args: [
                "length": length,
                "uppercase": uppercase,
                "lowercase": lowercase,
                "digits": digits,
                "symbols": symbols,
            ]
        )
    }

    public static func generatePassphrase(words: Int = 4, separator: String = "-") throws -> String {
        try invoke("generate_passphrase", args: ["words": words, "separator": separator])
    }

    public static func generateEmailAlias(siteOrDomain: String, aliasDomain: String) throws -> String {
        try invoke(
            "generate_email_alias",
            args: ["siteOrDomain": siteOrDomain, "aliasDomain": aliasDomain]
        )
    }

    public static func domainsMatch(_ a: String, _ b: String) -> Bool {
        (try? invoke("domains_match", args: ["a": a, "b": b])) ?? false
    }

    public static func detectImportFormat(_ text: String) throws -> String {
        try invoke("detect_import_format", args: ["text": text])
    }

    public static func parsePasswordCSV(_ csvText: String) throws -> [CsvImportedEntry] {
        try invoke("parse_password_csv", args: ["csvText": csvText])
    }

    public static func parseAuthenticatorExport(_ text: String) throws -> [TotpImportEntry] {
        try invoke("parse_authenticator_export", args: ["text": text])
    }

    public static func planTotpImport(
        existingItems: [VaultItemPayload],
        entries: [TotpImportEntry]
    ) throws -> [TotpImportPlanItem] {
        let itemsObj = try encodableToJSONObject(existingItems)
        let entriesObj = try encodableToJSONObject(entries)
        return try invoke(
            "plan_totp_import",
            args: [
                "items": itemsObj,
                "entries": entriesObj,
            ]
        )
    }

    public static func itemImportFingerprint(urls: [String], username: String?, password: String?) -> String {
        var firstUrl = (urls.first ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        while firstUrl.hasSuffix("/") {
            firstUrl.removeLast()
        }
        let user = (username ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let pass = password ?? ""
        return "\(firstUrl)\u{0000}\(user)\u{0000}\(pass)"
    }
}
