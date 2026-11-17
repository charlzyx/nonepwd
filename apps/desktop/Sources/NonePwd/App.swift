import AppKit
import SwiftUI

@main
enum NonePwdLauncher {
    static func main() {
        let args = CommandLine.arguments
        if let idx = args.firstIndex(of: "--capture-ui"), idx + 1 < args.count {
            let outDir = args[idx + 1]
            MainActor.assumeIsolated {
                ShowcaseSnapshotter.run(outputDir: outDir)
            }
            return
        }
        NonePwdApp.main()
    }
}

struct NonePwdApp: App {
    @StateObject private var store = VaultStore()

    init() {
        NSApplication.shared.setActivationPolicy(.regular)
        if let iconURL = Bundle.main.url(forResource: "AppIcon", withExtension: "icns"),
           let icon = NSImage(contentsOf: iconURL)
        {
            NSApplication.shared.applicationIconImage = icon
        }
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    var body: some Scene {
        WindowGroup(id: "main") {
            Group {
                if store.isUnlocked {
                    MainWorkspaceView(store: store)
                } else {
                    UnlockView(store: store)
                }
            }
            .frame(minWidth: 880, minHeight: 560)
        }
        .windowToolbarStyle(.unified)
        .defaultSize(width: 1120, height: 720)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("新建密码") {
                    guard store.isUnlocked else { return }
                    store.editingItem = nil
                    store.editingCategory = .login
                    store.showEditor = true
                }
                .keyboardShortcut("n", modifiers: .command)
                .disabled(!store.isUnlocked)

                Button("新建银行卡") {
                    guard store.isUnlocked else { return }
                    store.editingItem = nil
                    store.editingCategory = .card
                    store.showEditor = true
                }
                .keyboardShortcut("c", modifiers: [.command, .shift])
                .disabled(!store.isUnlocked)

                Button("新建身份与地址") {
                    guard store.isUnlocked else { return }
                    store.editingItem = nil
                    store.editingCategory = .identity
                    store.showEditor = true
                }
                .keyboardShortcut("a", modifiers: [.command, .shift])
                .disabled(!store.isUnlocked)

                Divider()

                Button("浏览器自动填充扩展…") {
                    guard store.isUnlocked else { return }
                    store.showExtensionSheet = true
                }
                .keyboardShortcut("e", modifiers: [.command, .shift])
                .disabled(!store.isUnlocked)

                Button("导入 CSV / 2FA…") {
                    guard store.isUnlocked else { return }
                    store.showImportSheet = true
                }
                .keyboardShortcut("i", modifiers: [.command, .shift])
                .disabled(!store.isUnlocked)
            }

            CommandGroup(after: .sidebar) {
                Button("立即同步") {
                    guard store.isUnlocked else { return }
                    Task { try? await store.syncAll() }
                }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(!store.isUnlocked)

                Button("锁定密码库") {
                    store.lock()
                }
                .keyboardShortcut("l", modifiers: .command)
                .disabled(!store.isUnlocked)
            }
        }

        MenuBarExtra("NonePwd", systemImage: "key.fill") {
            MenuBarPopoverView(store: store)
        }
        .menuBarExtraStyle(.window)
    }
}
