// swift-tools-version: 5.10
import Foundation
import PackageDescription

let desktopDir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let repoRoot = desktopDir.deletingLastPathComponent().deletingLastPathComponent()
let libDir = repoRoot.appendingPathComponent("dist/lib").path

let package = Package(
    name: "NonePwd",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(name: "NonePwd", targets: ["NonePwd"]),
    ],
    targets: [
        .target(
            name: "CNpCore",
            path: "Sources/CNpCore",
            publicHeadersPath: "include"
        ),
        .executableTarget(
            name: "NonePwd",
            dependencies: ["CNpCore"],
            path: "Sources/NonePwd",
            linkerSettings: [
                .unsafeFlags([
                    "-L\(libDir)",
                    "-lnonepwd_core",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
                    "-Xlinker", "-rpath", "-Xlinker", libDir,
                ]),
                .linkedFramework("SwiftUI"),
                .linkedFramework("AppKit"),
                .linkedFramework("LocalAuthentication"),
                .linkedFramework("Security"),
                .linkedFramework("UniformTypeIdentifiers"),
            ]
        ),
        .testTarget(
            name: "NonePwdTests",
            dependencies: ["NonePwd", "CNpCore"],
            path: "Tests/NonePwdTests",
            linkerSettings: [
                .unsafeFlags([
                    "-L\(libDir)",
                    "-lnonepwd_core",
                    "-Xlinker", "-rpath", "-Xlinker", libDir,
                ]),
            ]
        ),
    ]
)
