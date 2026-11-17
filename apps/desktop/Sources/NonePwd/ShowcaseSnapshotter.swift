import AppKit
import Foundation
import SwiftUI

@MainActor
enum ShowcaseSnapshotter {
    static func run(outputDir: String) {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)

        let outURL = URL(fileURLWithPath: outputDir, isDirectory: true)
        try? FileManager.default.createDirectory(at: outURL, withIntermediateDirectories: true)

        // 1. Unlock screen with Touch ID
        let unlockStore = makeDemoStore(unlocked: false)
        captureWindow(
            rootView: UnlockView(store: unlockStore, showcaseTouchID: true)
                .frame(width: 1080, height: 720),
            size: NSSize(width: 1080, height: 720),
            appearance: NSAppearance(named: .aqua),
            to: outURL.appendingPathComponent("macos-01-unlock-touchid.png")
        )

        // 2. Main 3-column workspace (Light Mode - Login + 2FA ring + Email OTP)
        let wsStore = makeDemoStore(unlocked: true)
        wsStore.destination = .all
        wsStore.selectedItemId = "item-github"
        captureWindow(
            rootView: MainWorkspaceView(store: wsStore)
                .frame(width: 1140, height: 740),
            size: NSSize(width: 1140, height: 740),
            appearance: NSAppearance(named: .aqua),
            to: outURL.appendingPathComponent("macos-02-vault-login-totp.png")
        )

        // 3. Credit Card Apple Wallet Preview
        wsStore.destination = .card
        wsStore.selectedItemId = "item-card-visa"
        captureWindow(
            rootView: MainWorkspaceView(store: wsStore)
                .frame(width: 1140, height: 740),
            size: NSSize(width: 1140, height: 740),
            appearance: NSAppearance(named: .aqua),
            to: outURL.appendingPathComponent("macos-03-vault-card-wallet.png")
        )

        // 4. Identity / Address View
        wsStore.destination = .identity
        wsStore.selectedItemId = "item-identity-home"
        captureWindow(
            rootView: MainWorkspaceView(store: wsStore)
                .frame(width: 1140, height: 740),
            size: NSSize(width: 1140, height: 740),
            appearance: NSAppearance(named: .aqua),
            to: outURL.appendingPathComponent("macos-04-vault-identity.png")
        )

        // 5. Dark Mode Comparison
        wsStore.destination = .all
        wsStore.selectedItemId = "item-github"
        captureWindow(
            rootView: MainWorkspaceView(store: wsStore)
                .frame(width: 1140, height: 740),
            size: NSSize(width: 1140, height: 740),
            appearance: NSAppearance(named: .darkAqua),
            to: outURL.appendingPathComponent("macos-05-vault-dark-mode.png")
        )

        print("Captured 5 macOS SwiftUI snapshots to \(outURL.path)")
    }

    private static func captureWindow<V: View>(
        rootView: V,
        size: NSSize,
        appearance: NSAppearance?,
        to fileURL: URL
    ) {
        let win = NSWindow(
            contentRect: NSRect(origin: NSPoint(x: 80, y: 80), size: size),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        win.title = "NonePwd"
        win.appearance = appearance
        win.titlebarAppearsTransparent = false
        win.toolbarStyle = .unified

        let hosting = NSHostingView(rootView: rootView)
        hosting.appearance = appearance
        hosting.frame = NSRect(origin: .zero, size: size)
        win.contentView = hosting
        win.orderFrontRegardless()

        for _ in 0..<8 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.08))
            win.layoutIfNeeded()
            hosting.layoutSubtreeIfNeeded()
        }

        let targetView = hosting
        let bounds = targetView.bounds
        let scale: CGFloat = 2.0
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(bounds.width * scale),
            pixelsHigh: Int(bounds.height * scale),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .deviceRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else {
            win.close()
            return
        }
        rep.size = bounds.size
        targetView.cacheDisplay(in: bounds, to: rep)

        if let png = rep.representation(using: .png, properties: [:]) {
            try? png.write(to: fileURL, options: .atomic)
        }
        win.orderOut(nil)
        win.close()
    }

    private static func makeDemoStore(unlocked: Bool) -> VaultStore {
        let store = VaultStore(forTesting: true)
        store.serverURL = "http://127.0.0.1:8787"
        store.knownEmail = "alice@example.com"
        store.accountEmail = "alice@example.com"
        store.secretKey = "NP3-DEMO7K-29X4MP-8QR3VT-6ZN2WL-4HY8BF"
        store.serverInitialized = true
        store.touchIDEnabled = true
        store.hasSavedTouchID = true
        store.isUnlocked = unlocked
        store.wsConnected = unlocked

        let personal = DecryptedVault(
            id: "v-personal",
            metadata: VaultMetadata(name: "Personal"),
            keyBytes: Data(repeating: 1, count: 32),
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )
        let devops = DecryptedVault(
            id: "v-devops",
            metadata: VaultMetadata(name: "DevOps"),
            keyBytes: Data(repeating: 2, count: 32),
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )
        store.vaults = [personal, devops]

        let github = VaultItemPayload(
            id: "item-github",
            vaultId: "v-personal",
            category: .login,
            title: "GitHub",
            favorite: true,
            urls: ["https://github.com/login"],
            username: "alice@example.com",
            password: "synthetic-demo-password-only",
            totp: "JBSWY3DPEHPK3PXP",
            emailAlias: "github.8k2m@mail.nonepwd.dev",
            notes: "主开发账号 · 已绑定硬件密钥与 2FA",
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )
        let cloudflare = VaultItemPayload(
            id: "item-cf",
            vaultId: "v-devops",
            category: .login,
            title: "Cloudflare",
            favorite: true,
            urls: ["https://dash.cloudflare.com"],
            username: "ops@example.com",
            password: "cf-synthetic-password",
            totp: "GEZDGNBVGY3TQOJQ",
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )
        let openai = VaultItemPayload(
            id: "item-openai",
            vaultId: "v-devops",
            category: .apiCredential,
            title: "OpenAI Production Key",
            urls: ["https://platform.openai.com"],
            username: "prod-org",
            password: "sk-proj-demo-key-placeholder",
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )
        let card = VaultItemPayload(
            id: "item-card-visa",
            vaultId: "v-personal",
            category: .card,
            title: "招商银行 Visa 全币卡",
            favorite: true,
            card: CardDetails(
                cardholderName: "ZHANG SAN",
                number: "4000123456784242",
                expMonth: "09",
                expYear: "2029",
                cvv: "842",
                brand: "Visa"
            ),
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )
        let identity = VaultItemPayload(
            id: "item-identity-home",
            vaultId: "v-personal",
            category: .identity,
            title: "常用收货与账单地址",
            identity: IdentityDetails(
                fullName: "张三",
                email: "alice@example.com",
                phone: "13800138000",
                company: "NonePwd Lab",
                address1: "海淀区西北旺东路 10 号院",
                address2: "A 座 8 层 802",
                city: "北京市",
                state: "北京",
                postalCode: "100193",
                country: "中国"
            ),
            createdAt: "2026-11-17T00:00:00Z",
            updatedAt: "2026-11-17T00:00:00Z"
        )

        store.items = [github, cloudflare, card, identity, openai]
        store.emails = [
            DecryptedEmailPayload(
                id: "em-1",
                from: "GitHub <noreply@github.com>",
                to: "github.8k2m@mail.nonepwd.dev",
                subject: "[GitHub] Sudo verification code",
                snippet: "Your GitHub verification code is 849201.",
                textBody: "Please enter verification code 849201 within 10 minutes.",
                otpCode: "849201",
                confidence: 0.98,
                magicLink: nil,
                senderDomain: "github.com",
                receivedAt: "2026-11-17T09:40:00Z"
            ),
        ]
        store.clipboardStatus = "已复制 密码"
        store.clipboardRemaining = 26
        store.refreshTotps()
        return store
    }
}
