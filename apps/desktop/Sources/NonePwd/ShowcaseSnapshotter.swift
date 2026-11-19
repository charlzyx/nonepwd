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
        wsStore.clipboardStatus = ""
        wsStore.clipboardRemaining = 0
        wsStore.destination = .all
        wsStore.selectedItemId = "item-github"
        captureWindow(
            rootView: MainWorkspaceView(store: wsStore)
                .frame(width: 1160, height: 740),
            sidebarOverlay: AnyView(MainWorkspaceView(store: wsStore).showcaseSidebarSnapshotView),
            size: NSSize(width: 1160, height: 740),
            appearance: NSAppearance(named: .aqua),
            isDark: false,
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
                .frame(width: 1160, height: 740),
            sidebarOverlay: AnyView(MainWorkspaceView(store: wsStore).showcaseSidebarSnapshotView),
            size: NSSize(width: 1160, height: 740),
            appearance: NSAppearance(named: .darkAqua),
            isDark: true,
            to: outURL.appendingPathComponent("macos-05-vault-dark-mode.png")
        )

        // 6. Live Email OTP Inbox with Multi-Mailbox Dropdown Filter
        let inboxStore = makeDemoStore(unlocked: true)
        inboxStore.clipboardStatus = ""
        inboxStore.clipboardRemaining = 0
        inboxStore.destination = .emailOtp
        inboxStore.selectedEmailId = "em-cf"
        captureWindow(
            rootView: MainWorkspaceView(store: inboxStore)
                .frame(width: 1160, height: 740),
            sidebarOverlay: AnyView(MainWorkspaceView(store: inboxStore).showcaseSidebarSnapshotView),
            size: NSSize(width: 1160, height: 740),
            appearance: NSAppearance(named: .aqua),
            isDark: false,
            to: outURL.appendingPathComponent("macos-06-email-otp-inbox.png")
        )

        captureWindow(
            rootView: MainWorkspaceView(store: inboxStore)
                .frame(width: 1160, height: 740),
            sidebarOverlay: AnyView(MainWorkspaceView(store: inboxStore).showcaseSidebarSnapshotView),
            size: NSSize(width: 1160, height: 740),
            appearance: NSAppearance(named: .darkAqua),
            isDark: true,
            to: outURL.appendingPathComponent("macos-07-email-otp-dark.png")
        )

        print("Captured 6 macOS SwiftUI snapshots to \(outURL.path)")
    }

    private static func normalizeVisualEffects(_ view: NSView) {
        if let vev = view as? NSVisualEffectView {
            vev.blendingMode = .withinWindow
            vev.state = .active
        }
        for sub in view.subviews {
            normalizeVisualEffects(sub)
        }
    }

    private static func captureWindow<V: View>(
        rootView: V,
        sidebarOverlay: AnyView? = nil,
        size: NSSize,
        appearance: NSAppearance?,
        isDark: Bool = false,
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

        for _ in 0..<10 {
            RunLoop.main.run(until: Date().addingTimeInterval(0.08))
            win.layoutIfNeeded()
            hosting.layoutSubtreeIfNeeded()
        }

        let targetView = win.contentView?.superview ?? hosting
        normalizeVisualEffects(targetView)
        win.displayIfNeeded()
        targetView.layoutSubtreeIfNeeded()

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

        if let sidebarOverlay {
            let sidebarWidth: CGFloat = 244
            let topBarHeight: CGFloat = 52
            let sidebarHeight = max(100, bounds.height - topBarHeight)
            let sidebarRoot = sidebarOverlay
                .frame(width: sidebarWidth, height: sidebarHeight)
                .background(
                    isDark
                        ? Color(red: 0.14, green: 0.14, blue: 0.15)
                        : Color(red: 0.945, green: 0.945, blue: 0.955)
                )
            let sbWin = NSWindow(
                contentRect: NSRect(origin: NSPoint(x: -2000, y: -2000), size: NSSize(width: sidebarWidth, height: sidebarHeight)),
                styleMask: [.borderless],
                backing: .buffered,
                defer: false
            )
            sbWin.appearance = appearance
            let sbHosting = NSHostingView(rootView: sidebarRoot)
            sbHosting.appearance = appearance
            sbHosting.frame = NSRect(origin: .zero, size: NSSize(width: sidebarWidth, height: sidebarHeight))
            sbWin.contentView = sbHosting
            sbWin.orderFrontRegardless()
            for _ in 0..<6 {
                RunLoop.main.run(until: Date().addingTimeInterval(0.04))
                sbWin.layoutIfNeeded()
                sbHosting.layoutSubtreeIfNeeded()
            }
            if let sbRep = NSBitmapImageRep(
                bitmapDataPlanes: nil,
                pixelsWide: Int(sidebarWidth * scale),
                pixelsHigh: Int(sidebarHeight * scale),
                bitsPerSample: 8,
                samplesPerPixel: 4,
                hasAlpha: true,
                isPlanar: false,
                colorSpaceName: .deviceRGB,
                bytesPerRow: 0,
                bitsPerPixel: 0
            ) {
                sbRep.size = NSSize(width: sidebarWidth, height: sidebarHeight)
                sbHosting.cacheDisplay(in: sbHosting.bounds, to: sbRep)
                let sbImg = NSImage(size: sbRep.size)
                sbImg.addRepresentation(sbRep)
                NSGraphicsContext.saveGraphicsState()
                if let ctx = NSGraphicsContext(bitmapImageRep: rep) {
                    NSGraphicsContext.current = ctx
                    sbImg.draw(
                        in: NSRect(x: 0, y: 0, width: sidebarWidth, height: sidebarHeight),
                        from: .zero,
                        operation: .sourceOver,
                        fraction: 1.0
                    )
                }
                NSGraphicsContext.restoreGraphicsState()
            }
            sbWin.orderOut(nil)
            sbWin.close()
        }

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
        store.imapAccounts = [
            ImapAccountPublic(
                id: "imap-work",
                label: "Work Gmail",
                enabled: true,
                host: "imap.gmail.com",
                port: 993,
                tls: true,
                username: "alice@example.com",
                hasPassword: true,
                status: "listening"
            ),
            ImapAccountPublic(
                id: "imap-ops",
                label: "Ops 邮箱",
                enabled: true,
                host: "imap.qq.com",
                port: 993,
                tls: true,
                username: "ops@example.com",
                hasPassword: true,
                status: "listening"
            ),
        ]
        store.emails = [
            DecryptedEmailPayload(
                id: "em-cf",
                from: "Cloudflare <noreply@notify.cloudflare.com>",
                to: "ops@example.com",
                subject: "Cloudflare Access login code",
                snippet: "Your Cloudflare Access verification code is 343113.",
                textBody: "Hi,\n\nYour one-time login verification code for Cloudflare Access is:\n\n343113\n\nThis code expires in 10 minutes.",
                otpCode: "343113",
                confidence: 0.99,
                magicLink: nil,
                senderDomain: "cloudflare.com",
                receivedAt: "2026-11-18 22:15",
                source: "imap",
                envelopeTo: "ops@example.com"
            ),
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
                receivedAt: "2026-11-18 22:08",
                source: "cf_webhook",
                envelopeTo: "alice@example.com"
            ),
            DecryptedEmailPayload(
                id: "em-stripe",
                from: "Stripe <notifications@stripe.com>",
                to: "alice@example.com",
                subject: "Confirm your Stripe Dashboard sign-in",
                snippet: "Your Stripe verification code is 519042.",
                textBody: "Enter code 519042 to finish signing in to your Stripe Dashboard.",
                otpCode: "519042",
                confidence: 0.97,
                magicLink: nil,
                senderDomain: "stripe.com",
                receivedAt: "2026-11-18 21:42",
                source: "imap",
                envelopeTo: "alice@example.com"
            ),
        ]
        store.clipboardStatus = "已复制 密码"
        store.clipboardRemaining = 26
        store.refreshTotps()
        return store
    }
}
