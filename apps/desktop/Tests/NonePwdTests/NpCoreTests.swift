import AppKit
import CoreImage
import Foundation

enum TestAssertError: Error, CustomStringConvertible {
    case failed(String)
    var description: String {
        switch self {
        case .failed(let msg): return msg
        }
    }
}

func expectTrue(_ cond: Bool, _ msg: String, file: String = #file, line: Int = #line) throws {
    if !cond {
        throw TestAssertError.failed("\(file):\(line): Assertion failed: \(msg)")
    }
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ msg: String = "", file: String = #file, line: Int = #line) throws {
    if a != b {
        throw TestAssertError.failed("\(file):\(line): Expected \(a) == \(b) \(msg)")
    }
}

func expectThrows<T>(_ msg: String = "", _ body: () throws -> T) throws {
    do {
        _ = try body()
        throw TestAssertError.failed("Expected throw: \(msg)")
    } catch is TestAssertError {
        throw TestAssertError.failed("Expected throw: \(msg)")
    } catch {
        // expected
    }
}

@main
enum NpCoreTestsMain {
    static func main() throws {
        try testSecretKeyAndDualKeyDerivation()
        try testAesGcmEncryptDecryptWithCardAndIdentity()
        try testTotpAndImportParsers()
        try testQrCodeScannerDecodeSyntheticOtpAuth()
        print("All 4 NonePwd Swift/Rust-FFI core tests passed.")
    }

    static func testSecretKeyAndDualKeyDerivation() throws {
        let sk = try NpCoreBridge.generateSecretKey()
        try expectTrue(sk.hasPrefix("NP3-"), "secret key prefix")
        let salt = try NpCoreBridge.randomBytes(16).base64URLEncodedString()
        let res = try NpCoreBridge.deriveAccountKeys(
            masterPassword: "TestMaster#2026",
            secretKey: sk,
            kdfSaltB64: salt,
            iterations: 10_000
        )
        try expectTrue(!res.authVerifierB64.isEmpty, "non-empty verifier")
        let muk = try Data(base64URLEncoded: res.masterUnlockKeyB64)
        try expectEqual(muk.count, 32, "32-byte MUK")
    }

    static func testAesGcmEncryptDecryptWithCardAndIdentity() throws {
        let key = try NpCoreBridge.randomBytes(32)
        let item = VaultItemPayload(
            id: "item-1",
            vaultId: "vault-1",
            category: .card,
            title: "Test Card",
            card: CardDetails(
                cardholderName: "Alice",
                number: "4111111111111111",
                expMonth: "12",
                expYear: "2028",
                cvv: "123",
                brand: "Visa"
            ),
            identity: IdentityDetails(
                fullName: "Alice",
                phone: "13800000000",
                address1: "1 Main St",
                city: "Beijing",
                country: "CN"
            ),
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )

        let blob = try NpCoreBridge.encryptJSON(
            key: key,
            value: item,
            aad: AAD.vaultItem("vault-1", "item-1")
        )
        let decoded = try NpCoreBridge.decryptJSON(
            VaultItemPayload.self,
            key: key,
            blob: blob,
            aad: AAD.vaultItem("vault-1", "item-1")
        )
        try expectEqual(decoded, item)
        try expectThrows("mismatched AAD") {
            try NpCoreBridge.decryptJSON(
                VaultItemPayload.self,
                key: key,
                blob: blob,
                aad: AAD.vaultItem("vault-2", "item-1")
            )
        }
    }

    static func testTotpAndImportParsers() throws {
        // RFC 6238 SHA1 secret "12345678901234567890" -> Base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
        let totp = try NpCoreBridge.generateTOTP("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", timestampMs: 59_000)
        try expectEqual(totp.code, "287082")

        let authTxt = """
        # Synthetic authenticator export
        otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub
        """
        try expectEqual(try NpCoreBridge.detectImportFormat(authTxt), "totp")
        let entries = try NpCoreBridge.parseAuthenticatorExport(authTxt)
        try expectEqual(entries.count, 1)
        try expectEqual(entries[0].issuer, "GitHub")
        try expectEqual(entries[0].account, "octocat")

        let csvText = "\u{FEFF}name,url,username,password,note\nGitHub,https://github.com/login,octocat,pass123,demo\n"
        try expectEqual(try NpCoreBridge.detectImportFormat(csvText), "csv")
        let csvEntries = try NpCoreBridge.parsePasswordCSV(csvText)
        try expectEqual(csvEntries.count, 1)
        try expectEqual(csvEntries[0].title, "GitHub")
    }

    static func testQrCodeScannerDecodeSyntheticOtpAuth() throws {
        let expectedUri = "otpauth://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub"
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else {
            throw TestAssertError.failed("CIQRCodeGenerator unavailable")
        }
        filter.setValue(Data(expectedUri.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let rawOutput = filter.outputImage else {
            throw TestAssertError.failed("CIQRCodeGenerator produced nil outputImage")
        }

        // CIQRCodeGenerator embeds a crisp 1px/module CGImage directly; fall back to CIContext when needed.
        let rawCG: CGImage
        if let direct = rawOutput.cgImage {
            rawCG = direct
        } else if let rendered = CIContext(options: [.useSoftwareRenderer: true])
            .createCGImage(rawOutput, from: rawOutput.extent)
        {
            rawCG = rendered
        } else {
            throw TestAssertError.failed("Failed to render raw QR CGImage")
        }
        let scale = 10
        let quiet = 40
        let width = rawCG.width * scale + quiet * 2
        let height = rawCG.height * scale + quiet * 2
        guard let bitmapCtx = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw TestAssertError.failed("Failed to create CGContext for QR image")
        }
        bitmapCtx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
        bitmapCtx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        bitmapCtx.interpolationQuality = .none
        bitmapCtx.draw(
            rawCG,
            in: CGRect(x: quiet, y: quiet, width: rawCG.width * scale, height: rawCG.height * scale)
        )
        guard let cgImage = bitmapCtx.makeImage() else {
            throw TestAssertError.failed("Failed to finalize synthetic QR CGImage")
        }

        let decoded = QrCodeScanner.decodePayloads(from: cgImage)
        try expectEqual(decoded, [expectedUri], "decoded synthetic otpauth QR")

        let nsImage = NSImage(cgImage: cgImage, size: NSSize(width: cgImage.width, height: cgImage.height))
        let decodedNs = QrCodeScanner.decodePayloads(from: nsImage)
        try expectEqual(decodedNs, [expectedUri], "decoded synthetic otpauth NSImage")

        let normalized = QrCodeScanner.extractOtpAuthPayloads(from: [
            "https://example.com/unrelated",
            "  OTPAUTH://totp/GitHub:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub  ",
            expectedUri,
        ])
        try expectEqual(normalized, [expectedUri], "normalized deduplicated otpauth payloads")
    }
}
