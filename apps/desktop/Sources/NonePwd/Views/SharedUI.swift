import SwiftUI

public enum AvatarPalette {
    private static let gradients: [(Color, Color)] = [
        (Color(red: 0.16, green: 0.48, blue: 0.96), Color(red: 0.08, green: 0.34, blue: 0.84)),
        (Color(red: 0.35, green: 0.34, blue: 0.84), Color(red: 0.24, green: 0.22, blue: 0.68)),
        (Color(red: 0.10, green: 0.68, blue: 0.45), Color(red: 0.05, green: 0.50, blue: 0.35)),
        (Color(red: 0.94, green: 0.50, blue: 0.12), Color(red: 0.80, green: 0.34, blue: 0.06)),
        (Color(red: 0.65, green: 0.26, blue: 0.86), Color(red: 0.48, green: 0.16, blue: 0.72)),
        (Color(red: 0.06, green: 0.58, blue: 0.72), Color(red: 0.04, green: 0.42, blue: 0.56)),
        (Color(red: 0.86, green: 0.24, blue: 0.34), Color(red: 0.68, green: 0.14, blue: 0.24)),
        (Color(red: 0.24, green: 0.27, blue: 0.33), Color(red: 0.14, green: 0.16, blue: 0.21)),
    ]

    public static func gradient(for seed: String) -> LinearGradient {
        let hash = seed.unicodeScalars.reduce(0) { ($0 &* 31) &+ Int($1.value) }
        let idx = abs(hash) % gradients.count
        let pair = gradients[idx]
        return LinearGradient(colors: [pair.0, pair.1], startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}

public struct SquircleAvatar: View {
    public let title: String
    public let category: ItemCategory
    public var urlHint: String? = nil
    public var size: CGFloat = 32

    @State private var favicon: NSImage?

    public init(title: String, category: ItemCategory, urlHint: String? = nil, size: CGFloat = 32) {
        self.title = title
        self.category = category
        self.urlHint = urlHint
        self.size = size
    }

    private var faviconDomain: String? {
        guard category == .login || category == .apiCredential else { return nil }
        return FaviconLoader.extractPublicDomain(from: urlHint ?? title)
    }

    private var fillColor: Color {
        switch category {
        case .card:
            return Color(red: 0.18, green: 0.72, blue: 0.32)
        case .identity:
            return Color(red: 0.22, green: 0.58, blue: 0.90)
        case .sshKey:
            return Color(red: 0.36, green: 0.38, blue: 0.84)
        case .apiCredential:
            return Color(red: 0.42, green: 0.44, blue: 0.49)
        case .secureNote:
            return Color(red: 0.90, green: 0.54, blue: 0.16)
        case .login:
            return Color(red: 0.53, green: 0.55, blue: 0.58)
        }
    }

    public var body: some View {
        let resolvedImage = favicon ?? faviconDomain.flatMap { FaviconLoader.shared.cachedImage(for: $0) }
        Group {
            if let img = resolvedImage {
                Image(nsImage: img)
                    .resizable()
                    .interpolation(.high)
                    .antialiased(true)
                    .scaledToFill()
                    .frame(width: size, height: size)
                    .background(Color.primary.opacity(0.04))
                    .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
            } else {
                ZStack {
                    RoundedRectangle(cornerRadius: size * 0.22, style: .continuous)
                        .fill(fillColor)

                    if category == .card || category == .identity || category == .sshKey {
                        Image(systemName: category.systemImage)
                            .font(.system(size: size * 0.44, weight: .medium))
                            .foregroundStyle(.white)
                    } else {
                        let first = title.trimmingCharacters(in: .whitespacesAndNewlines).prefix(1).uppercased()
                        Text(first.isEmpty ? "N" : first)
                            .font(.system(size: size * 0.53, weight: .regular))
                            .foregroundStyle(.white)
                    }
                }
            }
        }
        .frame(width: size, height: size)
        .task(id: faviconDomain) {
            guard let domain = faviconDomain else {
                favicon = nil
                return
            }
            if let loaded = await FaviconLoader.shared.loadFavicon(for: domain) {
                favicon = loaded
            }
        }
    }
}

public struct PasswordsKeyEmblem: View {
    public var category: ItemCategory = .login
    public var size: CGFloat = 48

    public var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.225, style: .continuous)
                .fill(Color(red: 0.11, green: 0.11, blue: 0.12))

            if category == .login {
                HStack(spacing: -size * 0.085) {
                    Image(systemName: "key.fill")
                        .font(.system(size: size * 0.42, weight: .semibold))
                        .foregroundStyle(Color(red: 0.96, green: 0.80, blue: 0.18))
                    Image(systemName: "key.fill")
                        .font(.system(size: size * 0.42, weight: .semibold))
                        .foregroundStyle(Color(red: 0.24, green: 0.80, blue: 0.38))
                        .offset(y: size * 0.045)
                    Image(systemName: "key.fill")
                        .font(.system(size: size * 0.42, weight: .semibold))
                        .foregroundStyle(Color(red: 0.24, green: 0.54, blue: 0.98))
                }
            } else {
                Image(systemName: category.systemImage)
                    .font(.system(size: size * 0.44, weight: .medium))
                    .foregroundStyle(Color.accentColor)
            }
        }
        .frame(width: size, height: size)
        .shadow(color: .black.opacity(0.14), radius: 6, y: 2)
    }
}

public struct BrandEmblem: View {
    public var size: CGFloat = 58

    public var body: some View {
        PasswordsKeyEmblem(category: .login, size: size)
    }
}

public struct BorderlessInputField: View {
    public let placeholder: String
    @Binding public var text: String
    public var isSecure: Bool = false
    public var isMonospaced: Bool = false
    public var onSubmit: (() -> Void)? = nil

    @FocusState private var focused: Bool

    public init(
        _ placeholder: String,
        text: Binding<String>,
        isSecure: Bool = false,
        isMonospaced: Bool = false,
        onSubmit: (() -> Void)? = nil
    ) {
        self.placeholder = placeholder
        self._text = text
        self.isSecure = isSecure
        self.isMonospaced = isMonospaced
        self.onSubmit = onSubmit
    }

    public var body: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text)
                    .onSubmit { onSubmit?() }
            } else {
                TextField(placeholder, text: $text)
                    .onSubmit { onSubmit?() }
            }
        }
        .textFieldStyle(.plain)
        .focusEffectDisabled()
        .font(isMonospaced ? .system(size: 13, design: .monospaced) : .system(size: 13.5))
        .focused($focused)
        .padding(.horizontal, 12)
        .frame(height: 36)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.primary.opacity(focused ? 0.085 : 0.055))
        )
    }
}

public struct ApplePillButtonStyle: ButtonStyle {
    public var isProminent: Bool = false
    public var height: CGFloat = 32
    public var cornerRadius: CGFloat = 8

    @Environment(\.isEnabled) private var isEnabled

    public init(isProminent: Bool = false, height: CGFloat = 32, cornerRadius: CGFloat = 8) {
        self.isProminent = isProminent
        self.height = height
        self.cornerRadius = cornerRadius
    }

    public func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: isProminent ? .medium : .regular))
            .foregroundStyle(
                isProminent
                    ? Color.white.opacity(isEnabled ? 1 : 0.85)
                    : Color.primary.opacity(isEnabled ? 1 : 0.45)
            )
            .padding(.horizontal, 14)
            .frame(height: height)
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(
                        isProminent
                            ? Color.accentColor.opacity(isEnabled ? (configuration.isPressed ? 0.82 : 1.0) : 0.42)
                            : Color.primary.opacity(configuration.isPressed ? 0.12 : 0.07)
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
    }
}

public struct FullWidthSegmentedTabs<Value: Hashable>: View {
    public let options: [(label: String, value: Value)]
    @Binding public var selection: Value

    public init(
        options: [(label: String, value: Value)],
        selection: Binding<Value>
    ) {
        self.options = options
        self._selection = selection
    }

    public var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(options.enumerated()), id: \.offset) { _, option in
                let isSelected = selection == option.value
                Button {
                    withAnimation(.snappy(duration: 0.18)) {
                        selection = option.value
                    }
                } label: {
                    Text(option.label)
                        .font(.system(size: 13, weight: isSelected ? .medium : .regular))
                        .foregroundStyle(isSelected ? Color.primary : Color.secondary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(
                            RoundedRectangle(cornerRadius: 7, style: .continuous)
                                .fill(isSelected ? Color(nsColor: .controlBackgroundColor) : Color.clear)
                                .shadow(
                                    color: isSelected ? .black.opacity(0.08) : .clear,
                                    radius: 2,
                                    y: 1
                                )
                        )
                        .contentShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(3)
        .frame(maxWidth: .infinity)
        .frame(height: 34)
        .background(
            RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(Color.primary.opacity(0.065))
        )
    }
}

public struct InsetGroupCard<Content: View>: View {
    public let header: String?
    public let content: () -> Content

    public init(header: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.header = header
        self.content = content
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let header {
                Text(header)
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 4)
            }
            VStack(spacing: 0) {
                content()
            }
            .background(Color.primary.opacity(0.042))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

public struct BentoCategoryTile: View {
    public let title: String
    public let count: Int
    public let systemImage: String
    public let tint: Color
    public let isSelected: Bool
    public let action: () -> Void

    public var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    ZStack {
                        Circle()
                            .fill(isSelected ? Color.white : tint)
                            .frame(width: 30, height: 30)
                        Image(systemName: systemImage)
                            .font(.system(size: 14.5, weight: .medium))
                            .foregroundStyle(isSelected ? tint : Color.white)
                    }
                    Spacer(minLength: 4)
                    Text("\(count)")
                        .font(.system(size: 13.5, weight: isSelected ? .medium : .regular))
                        .foregroundStyle(isSelected ? Color.white.opacity(0.92) : Color.secondary)
                        .monospacedDigit()
                        .padding(.top, 2)
                }
                Text(title)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(isSelected ? Color.white : Color.primary)
                    .lineLimit(1)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(isSelected ? tint : Color.primary.opacity(0.065))
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}

public struct CopyableFieldRow: View {
    public let label: String
    public let value: String
    public var isSecret: Bool = false
    public var isMonospaced: Bool = false
    public var revealedByDefault: Bool = true
    public let onCopy: () -> Void

    @State private var revealed: Bool
    @State private var copied = false

    public init(
        label: String,
        value: String,
        isSecret: Bool = false,
        isMonospaced: Bool = false,
        revealedByDefault: Bool = true,
        onCopy: @escaping () -> Void
    ) {
        self.label = label
        self.value = value
        self.isSecret = isSecret
        self.isMonospaced = isMonospaced
        self.revealedByDefault = revealedByDefault
        self.onCopy = onCopy
        self._revealed = State(initialValue: !isSecret || revealedByDefault)
    }

    public var body: some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.system(size: 13, weight: .regular))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: true, vertical: false)

            Spacer(minLength: 12)

            Group {
                if isSecret && !revealed {
                    Text(String(repeating: "•", count: min(max(value.count, 8), 16)))
                        .font(.system(size: 13.5, design: .monospaced))
                        .foregroundStyle(.secondary)
                } else {
                    Text(value)
                        .font(
                            isMonospaced || isSecret
                                ? .system(size: 13, design: .monospaced)
                                : .system(size: 13)
                        )
                        .foregroundStyle(isSecret && revealed ? .primary : .secondary)
                        .textSelection(.enabled)
                }
            }
            .multilineTextAlignment(.trailing)
            .lineLimit(2)

            HStack(spacing: 4) {
                if isSecret {
                    Button {
                        revealed.toggle()
                    } label: {
                        Image(systemName: revealed ? "eye.slash" : "eye")
                            .font(.system(size: 13, weight: .regular))
                            .foregroundStyle(.secondary)
                            .frame(width: 26, height: 26)
                            .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .help(revealed ? "隐藏" : "显示明文")
                }

                Button {
                    onCopy()
                    copied = true
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                        copied = false
                    }
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 13, weight: .regular))
                        .foregroundStyle(copied ? .green : .secondary)
                        .frame(width: 26, height: 26)
                        .contentShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(.plain)
                .help("复制 \(label)")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9.5)
        .frame(minHeight: 38)
    }
}

public struct CountdownRing: View {
    public let remainingSeconds: Int
    public let period: Int

    private var progress: Double {
        guard period > 0 else { return 0 }
        return max(0, min(1, Double(remainingSeconds) / Double(period)))
    }

    private var ringColor: Color {
        remainingSeconds <= 5 ? .orange : .accentColor
    }

    public var body: some View {
        ZStack {
            Circle()
                .stroke(ringColor.opacity(0.18), lineWidth: 2)
            Circle()
                .trim(from: 0, to: progress)
                .stroke(ringColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.linear(duration: 0.25), value: progress)
            Text("\(remainingSeconds)")
                .font(.system(size: 9.5, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(remainingSeconds <= 5 ? .orange : .secondary)
        }
        .frame(width: 20, height: 20)
    }
}

public struct WalletCardPreview: View {
    public let card: CardDetails
    public let title: String
    public let showFullNumber: Bool

    private var formattedCardNumber: String {
        let raw = (card.number ?? "").filter(\.isNumber)
        guard !raw.isEmpty else { return "••••  ••••  ••••  ••••" }
        if !showFullNumber {
            let last4 = String(raw.suffix(4))
            return "••••  ••••  ••••  \(last4)"
        }
        var groups: [String] = []
        var idx = raw.startIndex
        while idx < raw.endIndex {
            let next = raw.index(idx, offsetBy: 4, limitedBy: raw.endIndex) ?? raw.endIndex
            groups.append(String(raw[idx..<next]))
            idx = next
        }
        return groups.joined(separator: "  ")
    }

    private var gradientColors: [Color] {
        let lower = (card.brand ?? title).lowercased()
        if lower.contains("visa") {
            return [Color(red: 0.12, green: 0.24, blue: 0.56), Color(red: 0.20, green: 0.42, blue: 0.78)]
        } else if lower.contains("master") {
            return [Color(red: 0.22, green: 0.18, blue: 0.24), Color(red: 0.42, green: 0.22, blue: 0.22)]
        } else if lower.contains("amex") {
            return [Color(red: 0.08, green: 0.44, blue: 0.48), Color(red: 0.14, green: 0.62, blue: 0.58)]
        }
        return [Color(red: 0.16, green: 0.18, blue: 0.22), Color(red: 0.29, green: 0.33, blue: 0.40)]
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                Text((card.brand?.nilIfBlank ?? title).uppercased())
                    .font(.system(size: 13, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .foregroundStyle(.white.opacity(0.92))
                Spacer()
                // Metallic EMV Chip
                RoundedRectangle(cornerRadius: 5, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color(red: 0.95, green: 0.86, blue: 0.58),
                                Color(red: 0.76, green: 0.65, blue: 0.36),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 34, height: 24)
                    .overlay(
                        RoundedRectangle(cornerRadius: 5, style: .continuous)
                            .strokeBorder(.white.opacity(0.35), lineWidth: 0.6)
                    )
            }

            Text(formattedCardNumber)
                .font(.system(size: 19, weight: .semibold, design: .monospaced))
                .foregroundStyle(.white)
                .tracking(1)

            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("持卡人")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.white.opacity(0.6))
                    Text(card.cardholderName?.nilIfBlank ?? "CARDHOLDER")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(.white)
                }
                Spacer()
                if !card.formattedExpiry.isEmpty {
                    VStack(alignment: .trailing, spacing: 2) {
                        Text("VALID THRU")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.white.opacity(0.6))
                        Text(card.formattedExpiry)
                            .font(.system(size: 13, weight: .semibold, design: .monospaced))
                            .foregroundStyle(.white)
                    }
                }
            }
        }
        .padding(20)
        .frame(maxWidth: 380)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(LinearGradient(colors: gradientColors, startPoint: .topLeading, endPoint: .bottomTrailing))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(.white.opacity(0.20), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
    }
}
