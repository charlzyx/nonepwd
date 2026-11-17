import AppKit
import Foundation

@MainActor
public final class FaviconLoader {
    public static let shared = FaviconLoader()

    private let memCache = NSCache<NSString, NSImage>()
    private var failedDomains = Set<String>()
    private var inflight: [String: Task<NSImage?, Never>] = [:]

    private let urlSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 5
        cfg.timeoutIntervalForResource = 5
        cfg.requestCachePolicy = .returnCacheDataElseLoad
        return URLSession(configuration: cfg)
    }()

    private lazy var cacheDir: URL? = {
        guard let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first else {
            return nil
        }
        let dir = base.appendingPathComponent("dev.nonepwd.macos/favicons-v2", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    public nonisolated static func extractPublicDomain(from raw: String?) -> String? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !trimmed.contains(" ") else { return nil }

        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        guard var host = URL(string: candidate)?.host?.lowercased(), !host.isEmpty else {
            return nil
        }
        if host.hasPrefix("www.") {
            host.removeFirst(4)
        }
        guard host.contains("."),
              host != "localhost",
              !host.hasSuffix(".local"),
              !host.hasSuffix(".internal"),
              !host.hasSuffix(".lan"),
              !host.allSatisfy({ $0.isNumber || $0 == "." })
        else {
            return nil
        }
        return host
    }

    public func cachedImage(for domain: String) -> NSImage? {
        if let hit = memCache.object(forKey: domain as NSString) {
            return hit
        }
        if let dir = cacheDir {
            let file = diskCacheURL(dir: dir, domain: domain)
            if let img = NSImage(contentsOf: file), isUsableImage(img) {
                memCache.setObject(img, forKey: domain as NSString)
                return img
            }
        }
        return nil
    }

    public func loadFavicon(for domain: String) async -> NSImage? {
        if let cached = cachedImage(for: domain) {
            return cached
        }
        if failedDomains.contains(domain) {
            return nil
        }
        if let task = inflight[domain] {
            return await task.value
        }

        let session = urlSession
        let task = Task<NSImage?, Never> { [weak self] in
            let candidates = [
                "https://\(domain)/apple-touch-icon.png",
                "https://www.google.com/s2/favicons?domain=\(domain)&sz=128",
                "https://icons.duckduckgo.com/ip3/\(domain).ico",
                "https://\(domain)/favicon.ico",
            ]

            for urlString in candidates {
                guard let url = URL(string: urlString) else { continue }
                var req = URLRequest(url: url)
                req.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
                guard let (data, resp) = try? await session.data(for: req),
                      let http = resp as? HTTPURLResponse,
                      http.statusCode == 200,
                      let rawImg = NSImage(data: data),
                      Self.isUsableImageStatic(rawImg)
                else {
                    continue
                }
                let img = Self.trimUniformWhiteMargin(rawImg)
                self?.store(image: img, domain: domain)
                self?.inflight[domain] = nil
                return img
            }

            self?.failedDomains.insert(domain)
            self?.inflight[domain] = nil
            return nil
        }

        inflight[domain] = task
        return await task.value
    }

    private func store(image: NSImage, domain: String) {
        memCache.setObject(image, forKey: domain as NSString)
        guard let dir = cacheDir,
              let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let png = rep.representation(using: .png, properties: [:])
        else { return }
        let file = diskCacheURL(dir: dir, domain: domain)
        try? png.write(to: file, options: .atomic)
    }

    private func diskCacheURL(dir: URL, domain: String) -> URL {
        let safe = domain.replacingOccurrences(of: "/", with: "_")
        return dir.appendingPathComponent("\(safe).png")
    }

    private func isUsableImage(_ img: NSImage) -> Bool {
        Self.isUsableImageStatic(img)
    }

    private nonisolated static func isUsableImageStatic(_ img: NSImage) -> Bool {
        if let rep = img.representations.first, rep.pixelsWide >= 16, rep.pixelsHigh >= 16 {
            return true
        }
        return img.size.width >= 16 && img.size.height >= 16
    }

    private nonisolated static func trimUniformWhiteMargin(_ img: NSImage) -> NSImage {
        guard let tiff = img.tiffRepresentation,
              let src = NSBitmapImageRep(data: tiff)
        else { return img }
        let w = src.pixelsWide
        let h = src.pixelsHigh
        guard w >= 32, h >= 32 else { return img }

        let isNearWhite: (Int, Int) -> Bool = { x, y in
            guard let c = src.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { return false }
            if c.alphaComponent < 0.08 { return true }
            return c.redComponent >= 0.96 && c.greenComponent >= 0.96 && c.blueComponent >= 0.96
        }

        let cornersWhite =
            isNearWhite(0, 0) &&
            isNearWhite(w - 1, 0) &&
            isNearWhite(0, h - 1) &&
            isNearWhite(w - 1, h - 1)
        guard cornersWhite else { return img }

        var minX = w
        var maxX = -1
        var minY = h
        var maxY = -1
        for y in 0..<h {
            for x in 0..<w {
                if !isNearWhite(x, y) {
                    if x < minX { minX = x }
                    if x > maxX { maxX = x }
                    if y < minY { minY = y }
                    if y > maxY { maxY = y }
                }
            }
        }
        guard maxX > minX, maxY > minY else { return img }

        let cropW = maxX - minX + 1
        let cropH = maxY - minY + 1
        guard cropW >= 16, cropH >= 16,
              (Double(cropW) <= Double(w) * 0.90 || Double(cropH) <= Double(h) * 0.90),
              let cg = src.cgImage,
              let cropped = cg.cropping(to: CGRect(x: minX, y: minY, width: cropW, height: cropH))
        else { return img }

        return NSImage(cgImage: cropped, size: NSSize(width: cropW, height: cropH))
    }
}
