import AppKit
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

public enum QrCodeScanner {
    public enum ScreenCaptureOutcome: Equatable, Sendable {
        case cancelled
        case decoded([String])
        case failed(String)
    }

    public static func decodePayloads(from cgImage: CGImage) -> [String] {
        var results: [String] = []
        var seen = Set<String>()

        func append(_ raw: String?) {
            guard let trimmed = raw?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !trimmed.isEmpty,
                  !seen.contains(trimmed)
            else { return }
            seen.insert(trimmed)
            results.append(trimmed)
        }

        let request = VNDetectBarcodesRequest()
        request.symbologies = [.qr]
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
            let observations: [VNBarcodeObservation] = request.results ?? []
            for obs in observations {
                append(obs.payloadStringValue)
            }
        } catch {
            // Fall through to CoreImage detector
        }

        if results.isEmpty,
           let detector = CIDetector(
               ofType: CIDetectorTypeQRCode,
               context: nil,
               options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
           )
        {
            let ciImage = CIImage(cgImage: cgImage)
            for feature in detector.features(in: ciImage) {
                if let qr = feature as? CIQRCodeFeature {
                    append(qr.messageString)
                }
            }
        }

        if results.isEmpty, let cpuDecoded = CpuQrDecoder.decode(cgImage: cgImage) {
            append(cpuDecoded)
        }

        return results
    }

    public static func decodePayloads(from image: NSImage) -> [String] {
        var rect = NSRect(origin: .zero, size: image.size)
        if let cgImage = image.cgImage(forProposedRect: &rect, context: nil, hints: nil) {
            return decodePayloads(from: cgImage)
        }
        if let tiffData = image.tiffRepresentation,
           let rep = NSBitmapImageRep(data: tiffData),
           let cgImage = rep.cgImage
        {
            return decodePayloads(from: cgImage)
        }
        return []
    }

    public static func decodePayloads(fromImageData data: Data) -> [String] {
        if let source = CGImageSourceCreateWithData(data as CFData, nil),
           let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
        {
            return decodePayloads(from: cgImage)
        }
        if let image = NSImage(data: data) {
            return decodePayloads(from: image)
        }
        return []
    }

    public static func decodeFromImageURLs(_ urls: [URL]) -> [String] {
        var combined: [String] = []
        var seen = Set<String>()

        for url in urls {
            let decoded: [String]
            if let source = CGImageSourceCreateWithURL(url as CFURL, nil),
               let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil)
            {
                decoded = decodePayloads(from: cgImage)
            } else if let image = NSImage(contentsOf: url) {
                decoded = decodePayloads(from: image)
            } else {
                decoded = []
            }

            for item in decoded where !seen.contains(item) {
                seen.insert(item)
                combined.append(item)
            }
        }
        return combined
    }

    public static func decodeFromPasteboard(_ pasteboard: NSPasteboard = .general) -> [String] {
        var combined: [String] = []
        var seen = Set<String>()

        func appendAll(_ items: [String]) {
            for item in items where !seen.contains(item) {
                seen.insert(item)
                combined.append(item)
            }
        }

        if let urls = pasteboard.readObjects(
            forClasses: [NSURL.self],
            options: [.urlReadingFileURLsOnly: true]
        ) as? [URL], !urls.isEmpty {
            appendAll(decodeFromImageURLs(urls))
        }

        if let images = pasteboard.readObjects(forClasses: [NSImage.self], options: nil) as? [NSImage],
           !images.isEmpty
        {
            for img in images {
                appendAll(decodePayloads(from: img))
            }
        }

        if combined.isEmpty {
            let rawTypes: [NSPasteboard.PasteboardType] = [
                .png,
                .tiff,
                NSPasteboard.PasteboardType("public.jpeg"),
                NSPasteboard.PasteboardType("public.heic"),
            ]
            for type in rawTypes {
                if let data = pasteboard.data(forType: type) {
                    appendAll(decodePayloads(fromImageData: data))
                    if !combined.isEmpty { break }
                }
            }
        }

        return combined
    }

    public static func extractOtpAuthPayloads(from payloads: [String]) -> [String] {
        var out: [String] = []
        var seen = Set<String>()

        func append(_ uri: String) {
            guard !uri.isEmpty, !seen.contains(uri) else { return }
            seen.insert(uri)
            out.append(uri)
        }

        for raw in payloads {
            let lines = raw
                .components(separatedBy: .newlines)
                .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }

            for line in lines {
                let lower = line.lowercased()
                if lower.hasPrefix("otpauth://") {
                    let rest = line.dropFirst("otpauth://".count)
                    append("otpauth://\(rest)")
                } else if lower.hasPrefix("otpauth-migration://") {
                    let rest = line.dropFirst("otpauth-migration://".count)
                    append("otpauth-migration://\(rest)")
                } else if let normalizedBase32 = normalizeRawBase32Secret(line) {
                    append("otpauth://totp/2FA?secret=\(normalizedBase32)")
                }
            }
        }

        return out
    }

    private static func normalizeRawBase32Secret(_ raw: String) -> String? {
        let stripped = raw
            .uppercased()
            .filter { !$0.isWhitespace && $0 != "-" }
        guard stripped.count >= 16 else { return nil }
        let trimmedPadding = stripped.replacingOccurrences(of: "=", with: "")
        guard trimmedPadding.count >= 16 else { return nil }
        let base32Chars = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
        guard trimmedPadding.unicodeScalars.allSatisfy({ base32Chars.contains($0) }) else {
            return nil
        }
        return trimmedPadding
    }

    @MainActor
    public static func decodeFromItemProviders(_ providers: [NSItemProvider]) async -> [String] {
        var combined: [String] = []
        var seen = Set<String>()

        func appendAll(_ items: [String]) {
            for item in items where !seen.contains(item) {
                seen.insert(item)
                combined.append(item)
            }
        }

        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                if let url = await loadFileURL(from: provider) {
                    appendAll(decodeFromImageURLs([url]))
                    continue
                }
            }
            let imageTypes: [UTType] = [.image, .png, .tiff]
            var decodedImage = false
            for imgType in imageTypes where provider.hasItemConformingToTypeIdentifier(imgType.identifier) {
                if let data = await loadImageData(from: provider, typeIdentifier: imgType.identifier) {
                    appendAll(decodePayloads(fromImageData: data))
                    decodedImage = true
                    break
                }
            }
            if !decodedImage, let image = await loadNSImage(from: provider) {
                appendAll(decodePayloads(from: image))
            }
        }
        return combined
    }

    private static func loadFileURL(from provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, _ in
                if let url = item as? URL {
                    continuation.resume(returning: url)
                } else if let data = item as? Data,
                          let str = String(data: data, encoding: .utf8),
                          let url = URL(string: str.trimmingCharacters(in: .whitespacesAndNewlines))
                {
                    continuation.resume(returning: url)
                } else {
                    continuation.resume(returning: nil)
                }
            }
        }
    }

    private static func loadImageData(from provider: NSItemProvider, typeIdentifier: String) async -> Data? {
        await withCheckedContinuation { continuation in
            provider.loadDataRepresentation(forTypeIdentifier: typeIdentifier) { data, _ in
                continuation.resume(returning: data)
            }
        }
    }

    private static func loadNSImage(from provider: NSItemProvider) async -> NSImage? {
        guard provider.canLoadObject(ofClass: NSImage.self) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadObject(ofClass: NSImage.self) { object, _ in
                continuation.resume(returning: object as? NSImage)
            }
        }
    }

    @MainActor
    public static func captureScreenRegionToPasteboard() async -> ScreenCaptureOutcome {
        let pasteboard = NSPasteboard.general
        let previousChangeCount = pasteboard.changeCount

        let runResult: Result<Int32, Error> = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let proc = Process()
                proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
                proc.arguments = ["-i", "-c"]
                do {
                    try proc.run()
                    proc.waitUntilExit()
                    continuation.resume(returning: .success(proc.terminationStatus))
                } catch {
                    continuation.resume(returning: .failure(error))
                }
            }
        }

        switch runResult {
        case .failure(let error):
            return .failed("无法启动系统截图工具: \(error.localizedDescription)")
        case .success:
            if pasteboard.changeCount == previousChangeCount {
                return .cancelled
            }
            let decoded = decodeFromPasteboard(pasteboard)
            return .decoded(decoded)
        }
    }
}

/// Pure-CPU QR Code Model 2 fallback decoder (ISO/IEC 18004) for environments
/// where CoreImage/Vision IOSurface rendering is restricted (e.g., headless sandboxed tests).
private enum CpuQrDecoder {
    private struct FinderCandidate {
        var cx: Double
        var cy: Double
        var moduleSize: Double
        var count: Int = 1
    }

    // (ecCodewordsPerBlock, numBlocks) for [L, M, Q, H] across Versions 1..40
    private static let ecTable: [[(Int, Int)]] = [
        [(7, 1), (10, 1), (13, 1), (17, 1)],
        [(10, 1), (16, 1), (22, 1), (28, 1)],
        [(15, 1), (26, 1), (18, 2), (22, 2)],
        [(20, 1), (18, 2), (26, 2), (16, 4)],
        [(26, 1), (24, 2), (18, 4), (22, 4)],
        [(18, 2), (16, 4), (24, 4), (28, 4)],
        [(20, 2), (18, 4), (18, 6), (26, 5)],
        [(24, 2), (22, 4), (22, 6), (26, 6)],
        [(30, 2), (22, 5), (20, 8), (24, 8)],
        [(18, 4), (26, 5), (24, 8), (28, 8)],
        [(20, 4), (30, 5), (28, 8), (24, 11)],
        [(24, 4), (22, 8), (26, 10), (28, 11)],
        [(26, 4), (22, 9), (24, 12), (22, 16)],
        [(30, 4), (24, 9), (20, 16), (24, 16)],
        [(22, 6), (24, 10), (30, 12), (24, 18)],
        [(24, 6), (28, 10), (24, 17), (30, 16)],
        [(28, 6), (28, 11), (28, 16), (28, 19)],
        [(30, 6), (26, 13), (28, 18), (28, 21)],
        [(28, 7), (26, 14), (26, 21), (26, 25)],
        [(28, 8), (26, 16), (30, 20), (28, 25)],
        [(28, 8), (26, 17), (28, 23), (30, 25)],
        [(28, 9), (28, 17), (30, 23), (24, 34)],
        [(30, 9), (28, 18), (30, 25), (30, 30)],
        [(30, 10), (28, 20), (30, 27), (30, 32)],
        [(26, 12), (28, 21), (30, 29), (30, 35)],
        [(28, 12), (28, 23), (28, 34), (30, 37)],
        [(30, 12), (28, 25), (30, 34), (30, 40)],
        [(30, 13), (28, 26), (30, 35), (30, 42)],
        [(30, 14), (28, 28), (30, 38), (30, 45)],
        [(30, 15), (28, 29), (30, 40), (30, 48)],
        [(30, 16), (28, 31), (30, 43), (30, 51)],
        [(30, 17), (28, 33), (30, 45), (30, 54)],
        [(30, 18), (28, 35), (30, 48), (30, 57)],
        [(30, 19), (28, 37), (30, 51), (30, 60)],
        [(30, 19), (28, 38), (30, 53), (30, 63)],
        [(30, 20), (28, 40), (30, 56), (30, 66)],
        [(30, 21), (28, 43), (30, 59), (30, 70)],
        [(30, 22), (28, 45), (30, 62), (30, 74)],
        [(30, 24), (28, 47), (30, 65), (30, 77)],
        [(30, 25), (28, 49), (30, 68), (30, 81)],
    ]

    static func decode(cgImage: CGImage) -> String? {
        let w = cgImage.width
        let h = cgImage.height
        guard w >= 21, h >= 21 else { return nil }

        var pixels = [UInt8](repeating: 255, count: w * h)
        guard let ctx = CGContext(
            data: &pixels,
            width: w,
            height: h,
            bitsPerComponent: 8,
            bytesPerRow: w,
            space: CGColorSpaceCreateDeviceGray(),
            bitmapInfo: CGImageAlphaInfo.none.rawValue
        ) else {
            return nil
        }
        ctx.setFillColor(gray: 1, alpha: 1)
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        ctx.draw(cgImage, in: CGRect(x: 0, y: 0, width: w, height: h))

        var minVal: UInt8 = 255
        var maxVal: UInt8 = 0
        for p in pixels {
            if p < minVal { minVal = p }
            if p > maxVal { maxVal = p }
        }
        guard Int(maxVal) - Int(minVal) >= 20 else { return nil }
        let threshold = UInt8((Int(minVal) + Int(maxVal)) / 2)

        let normalDark = pixels.map { $0 < threshold }
        if let decoded = decodeBinary(grid: normalDark, width: w, height: h) {
            return decoded
        }
        let invertedDark = pixels.map { $0 >= threshold }
        return decodeBinary(grid: invertedDark, width: w, height: h)
    }

    private static func decodeBinary(grid: [Bool], width w: Int, height h: Int) -> String? {
        let candidates = findFinderCandidates(grid: grid, width: w, height: h)
        guard candidates.count >= 3 else { return nil }

        // Pick top-left, top-right, bottom-left finder centers
        let topClusters = Array(candidates.prefix(12))
        var bestTriple: (tl: FinderCandidate, tr: FinderCandidate, bl: FinderCandidate)?
        var bestScore = Double.greatestFiniteMagnitude

        for i in 0..<topClusters.count {
            for j in 0..<topClusters.count where j != i {
                for k in 0..<topClusters.count where k != i && k != j {
                    let tl = topClusters[i]
                    let tr = topClusters[j]
                    let bl = topClusters[k]
                    let dxR = tr.cx - tl.cx
                    let dyR = tr.cy - tl.cy
                    let dxB = bl.cx - tl.cx
                    let dyB = bl.cy - tl.cy
                    guard dxR > tl.moduleSize * 10, dyB > tl.moduleSize * 10 else { continue }
                    let orthoErr = abs(dyR) + abs(dxB)
                    let sizeErr = abs(dxR - dyB)
                    if orthoErr > max(dxR, dyB) * 0.25 { continue }
                    let modErr = abs(tl.moduleSize - tr.moduleSize) + abs(tl.moduleSize - bl.moduleSize)
                    let score = orthoErr + sizeErr * 0.5 + modErr * 4.0
                    if score < bestScore {
                        bestScore = score
                        bestTriple = (tl, tr, bl)
                    }
                }
            }
        }

        guard let (tl, tr, bl) = bestTriple else { return nil }
        let distX = tr.cx - tl.cx
        let distY = bl.cy - tl.cy
        let avgMod = (tl.moduleSize + tr.moduleSize + bl.moduleSize) / 3.0
        let estSize = ((distX + distY) / (2.0 * avgMod)) + 7.0
        let baseVersion = max(1, min(40, Int(((estSize - 17.0) / 4.0).rounded())))

        var candidateVersions = [baseVersion]
        if baseVersion > 1 { candidateVersions.append(baseVersion - 1) }
        if baseVersion < 40 { candidateVersions.append(baseVersion + 1) }

        for version in candidateVersions {
            let size = 4 * version + 17
            let cellW = distX / Double(size - 7)
            let cellH = distY / Double(size - 7)
            let originX = tl.cx - 3.5 * cellW
            let originY = tl.cy - 3.5 * cellH

            var modules = [[Bool]](repeating: [Bool](repeating: false, count: size), count: size)
            for r in 0..<size {
                let py = min(h - 1, max(0, Int(floor(originY + (Double(r) + 0.5) * cellH))))
                for c in 0..<size {
                    let px = min(w - 1, max(0, Int(floor(originX + (Double(c) + 0.5) * cellW))))
                    modules[r][c] = grid[py * w + px]
                }
            }

            if let text = decodeModules(modules, version: version, size: size) {
                return text
            }
        }
        return nil
    }

    private static func findFinderCandidates(grid: [Bool], width w: Int, height h: Int) -> [FinderCandidate] {
        var clusters: [FinderCandidate] = []

        for y in 0..<h {
            let rowOffset = y * w
            var stateCount = [0, 0, 0, 0, 0]
            var currentState = 0
            var x = 0

            while x < w {
                let dark = grid[rowOffset + x]
                if dark {
                    if currentState & 1 == 1 {
                        currentState += 1
                    }
                    stateCount[currentState] += 1
                } else if currentState == 0 && stateCount[0] == 0 {
                    // Ignore leading light pixels before the first dark module
                } else {
                    if currentState & 1 == 0 {
                        if currentState == 4 {
                            if checkRatio(stateCount) {
                                let total = stateCount.reduce(0, +)
                                let cx = Double(x) - Double(stateCount[4] + stateCount[3]) - Double(stateCount[2]) / 2.0
                                if let (cy, totalV) = crossCheckVertical(
                                    grid: grid,
                                    width: w,
                                    height: h,
                                    x: Int(floor(cx)),
                                    startY: y,
                                    maxCount: stateCount[2]
                                ) {
                                    let modSize = Double(total + totalV) / 14.0
                                    mergeCandidate(cx: cx, cy: cy, moduleSize: modSize, into: &clusters)
                                }
                                stateCount = [0, 0, 0, 0, 0]
                                currentState = 0
                                x += 1
                                continue
                            } else {
                                stateCount[0] = stateCount[2]
                                stateCount[1] = stateCount[3]
                                stateCount[2] = stateCount[4]
                                stateCount[3] = 1
                                stateCount[4] = 0
                                currentState = 3
                            }
                        } else {
                            currentState += 1
                            stateCount[currentState] += 1
                        }
                    } else {
                        stateCount[currentState] += 1
                    }
                }
                x += 1
            }
            if currentState == 4 && checkRatio(stateCount) {
                let total = stateCount.reduce(0, +)
                let cx = Double(w) - Double(stateCount[4] + stateCount[3]) - Double(stateCount[2]) / 2.0
                if let (cy, totalV) = crossCheckVertical(
                    grid: grid,
                    width: w,
                    height: h,
                    x: Int(floor(cx)),
                    startY: y,
                    maxCount: stateCount[2]
                ) {
                    let modSize = Double(total + totalV) / 14.0
                    mergeCandidate(cx: cx, cy: cy, moduleSize: modSize, into: &clusters)
                }
            }
        }

        return clusters.sorted { $0.count > $1.count }
    }

    private static func checkRatio(_ counts: [Int]) -> Bool {
        let total = counts.reduce(0, +)
        guard total >= 7 else { return false }
        let mod = Double(total) / 7.0
        let tol = max(0.8, mod * 0.55)
        return abs(Double(counts[0]) - mod) <= tol
            && abs(Double(counts[1]) - mod) <= tol
            && abs(Double(counts[2]) - 3.0 * mod) <= tol * 3.0
            && abs(Double(counts[3]) - mod) <= tol
            && abs(Double(counts[4]) - mod) <= tol
    }

    private static func crossCheckVertical(
        grid: [Bool],
        width w: Int,
        height h: Int,
        x: Int,
        startY: Int,
        maxCount: Int
    ) -> (cy: Double, total: Int)? {
        guard x >= 0, x < w, startY >= 0, startY < h, grid[startY * w + x] else { return nil }
        var counts = [0, 0, 0, 0, 0]
        var y = startY
        while y >= 0 && grid[y * w + x] { counts[2] += 1; y -= 1 }
        guard y >= 0, counts[2] <= maxCount * 2 else { return nil }
        while y >= 0 && !grid[y * w + x] { counts[1] += 1; y -= 1 }
        guard y >= 0 else { return nil }
        while y >= 0 && grid[y * w + x] { counts[0] += 1; y -= 1 }

        y = startY + 1
        while y < h && grid[y * w + x] { counts[2] += 1; y += 1 }
        guard y < h, counts[2] <= maxCount * 2 else { return nil }
        while y < h && !grid[y * w + x] { counts[3] += 1; y += 1 }
        guard y < h else { return nil }
        while y < h && grid[y * w + x] { counts[4] += 1; y += 1 }

        guard checkRatio(counts) else { return nil }
        let total = counts.reduce(0, +)
        let cy = Double(y) - Double(counts[4] + counts[3]) - Double(counts[2]) / 2.0
        return (cy, total)
    }

    private static func mergeCandidate(
        cx: Double,
        cy: Double,
        moduleSize: Double,
        into clusters: inout [FinderCandidate]
    ) {
        for idx in clusters.indices {
            let c = clusters[idx]
            let thresh = max(2.5, c.moduleSize * 2.5)
            if abs(c.cx - cx) < thresh && abs(c.cy - cy) < thresh && abs(c.moduleSize - moduleSize) <= max(1.5, c.moduleSize) {
                let n = Double(c.count)
                clusters[idx].cx = (c.cx * n + cx) / (n + 1.0)
                clusters[idx].cy = (c.cy * n + cy) / (n + 1.0)
                clusters[idx].moduleSize = (c.moduleSize * n + moduleSize) / (n + 1.0)
                clusters[idx].count += 1
                return
            }
        }
        clusters.append(FinderCandidate(cx: cx, cy: cy, moduleSize: moduleSize))
    }

    private static func decodeModules(_ modules: [[Bool]], version: Int, size: Int) -> String? {
        guard let (ecIndex, maskId) = decodeFormatInfo(modules: modules, size: size) else {
            return nil
        }
        let isFunc = buildFunctionMask(version: version, size: size)

        var bits: [Bool] = []
        bits.reserveCapacity(size * size)
        var right = size - 1
        var upward = true
        while right >= 1 {
            if right == 6 { right -= 1 }
            for i in 0..<size {
                let r = upward ? (size - 1 - i) : i
                for dx in 0...1 {
                    let c = right - dx
                    guard c >= 0, !isFunc[r][c] else { continue }
                    let raw = modules[r][c]
                    bits.append(applyMask(maskId, r: r, c: c) ? !raw : raw)
                }
            }
            upward.toggle()
            right -= 2
        }

        let totalCodewords = bits.count / 8
        guard totalCodewords >= 26 else { return nil }
        var codewords = [UInt8](repeating: 0, count: totalCodewords)
        for i in 0..<totalCodewords {
            var byte: UInt8 = 0
            for b in 0..<8 {
                if bits[i * 8 + b] {
                    byte |= (1 << (7 - b))
                }
            }
            codewords[i] = byte
        }

        let (ecPerBlock, numBlocks) = ecTable[version - 1][ecIndex]
        let totalDataBytes = totalCodewords - ecPerBlock * numBlocks
        guard totalDataBytes > 0, numBlocks > 0 else { return nil }

        let shortBlockLen = totalDataBytes / numBlocks
        let longBlocks = totalDataBytes % numBlocks
        let shortBlocks = numBlocks - longBlocks

        var blocks = [[UInt8]](repeating: [], count: numBlocks)
        var idx = 0
        for row in 0..<shortBlockLen {
            for b in 0..<numBlocks {
                guard idx < codewords.count else { return nil }
                blocks[b].append(codewords[idx])
                idx += 1
            }
            _ = row
        }
        if longBlocks > 0 {
            for b in shortBlocks..<numBlocks {
                guard idx < codewords.count else { return nil }
                blocks[b].append(codewords[idx])
                idx += 1
            }
        }

        var dataStream: [UInt8] = []
        dataStream.reserveCapacity(totalDataBytes)
        for b in 0..<numBlocks {
            dataStream.append(contentsOf: blocks[b])
        }

        return decodeDataStream(dataStream, version: version)
    }

    private static func decodeFormatInfo(modules: [[Bool]], size: Int) -> (ecIndex: Int, maskId: Int)? {
        func readBit(_ r: Int, _ c: Int) -> Int { modules[r][c] ? 1 : 0 }

        var fmt1 = 0
        for c in 0...5 { fmt1 = (fmt1 << 1) | readBit(8, c) }
        fmt1 = (fmt1 << 1) | readBit(8, 7)
        fmt1 = (fmt1 << 1) | readBit(8, 8)
        fmt1 = (fmt1 << 1) | readBit(7, 8)
        for r in stride(from: 5, through: 0, by: -1) {
            fmt1 = (fmt1 << 1) | readBit(r, 8)
        }

        var fmt2 = 0
        for r in stride(from: size - 1, through: size - 7, by: -1) {
            fmt2 = (fmt2 << 1) | readBit(r, 8)
        }
        for c in (size - 8)..<size {
            fmt2 = (fmt2 << 1) | readBit(8, c)
        }

        var bestData = -1
        var bestDist = Int.max
        for d in 0..<32 {
            var rem = d << 10
            for b in stride(from: 14, through: 10, by: -1) {
                if (rem & (1 << b)) != 0 {
                    rem ^= 0x537 << (b - 10)
                }
            }
            let codeword = ((d << 10) | rem) ^ 0x5412
            let dist = min((fmt1 ^ codeword).nonzeroBitCount, (fmt2 ^ codeword).nonzeroBitCount)
            if dist < bestDist {
                bestDist = dist
                bestData = d
            }
        }
        guard bestData >= 0, bestDist <= 3 else { return nil }
        let rawEc = (bestData >> 3) & 0x3
        let maskId = bestData & 0x7
        let ecMap = [1, 0, 3, 2] // 00->M(1), 01->L(0), 10->H(3), 11->Q(2)
        return (ecMap[rawEc], maskId)
    }

    private static func applyMask(_ maskId: Int, r: Int, c: Int) -> Bool {
        switch maskId {
        case 0: return (r + c) % 2 == 0
        case 1: return r % 2 == 0
        case 2: return c % 3 == 0
        case 3: return (r + c) % 3 == 0
        case 4: return (r / 2 + c / 3) % 2 == 0
        case 5: return (r * c) % 2 + (r * c) % 3 == 0
        case 6: return ((r * c) % 2 + (r * c) % 3) % 2 == 0
        case 7: return ((r + c) % 2 + (r * c) % 3) % 2 == 0
        default: return false
        }
    }

    private static func buildFunctionMask(version: Int, size: Int) -> [[Bool]] {
        var mask = [[Bool]](repeating: [Bool](repeating: false, count: size), count: size)
        func markRect(_ r0: Int, _ c0: Int, _ h: Int, _ w: Int) {
            for r in max(0, r0)..<min(size, r0 + h) {
                for c in max(0, c0)..<min(size, c0 + w) {
                    mask[r][c] = true
                }
            }
        }
        markRect(0, 0, 9, 9)
        markRect(0, size - 8, 9, 8)
        markRect(size - 8, 0, 8, 9)
        for i in 0..<size {
            mask[6][i] = true
            mask[i][6] = true
        }
        if version >= 7 {
            markRect(0, size - 11, 6, 3)
            markRect(size - 11, 0, 3, 6)
        }
        let alignPos = alignmentPositions(version: version, size: size)
        for ar in alignPos {
            for ac in alignPos {
                if (ar == 6 && ac == 6) || (ar == 6 && ac == size - 7) || (ar == size - 7 && ac == 6) {
                    continue
                }
                markRect(ar - 2, ac - 2, 5, 5)
            }
        }
        return mask
    }

    private static func alignmentPositions(version: Int, size: Int) -> [Int] {
        guard version >= 2 else { return [] }
        let numAlign = version / 7 + 2
        let step = version == 32 ? 26 : ((version * 4 + numAlign * 2 + 1) / (numAlign * 2 - 2)) * 2
        var result = [6]
        var pos = size - 7
        for _ in 1..<numAlign {
            result.insert(pos, at: 1)
            pos -= step
        }
        return result
    }

    private static func decodeDataStream(_ bytes: [UInt8], version: Int) -> String? {
        var bitPos = 0
        let totalBits = bytes.count * 8

        func readBits(_ count: Int) -> Int? {
            guard count >= 0, bitPos + count <= totalBits else { return nil }
            var val = 0
            for _ in 0..<count {
                let byteIdx = bitPos / 8
                let bitIdx = 7 - (bitPos % 8)
                val = (val << 1) | Int((bytes[byteIdx] >> bitIdx) & 1)
                bitPos += 1
            }
            return val
        }

        let alphaChars = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:")
        var outBytes: [UInt8] = []

        while bitPos + 4 <= totalBits {
            guard let mode = readBits(4) else { break }
            if mode == 0 { break }
            switch mode {
            case 1: // Numeric
                let ccBits = version <= 9 ? 10 : (version <= 26 ? 12 : 14)
                guard let count = readBits(ccBits) else { return nil }
                var rem = count
                while rem >= 3 {
                    guard let v = readBits(10), v < 1000 else { return nil }
                    outBytes.append(contentsOf: String(format: "%03d", v).utf8)
                    rem -= 3
                }
                if rem == 2 {
                    guard let v = readBits(7), v < 100 else { return nil }
                    outBytes.append(contentsOf: String(format: "%02d", v).utf8)
                } else if rem == 1 {
                    guard let v = readBits(4), v < 10 else { return nil }
                    outBytes.append(contentsOf: String(format: "%d", v).utf8)
                }
            case 2: // Alphanumeric
                let ccBits = version <= 9 ? 9 : (version <= 26 ? 11 : 13)
                guard let count = readBits(ccBits) else { return nil }
                var rem = count
                while rem >= 2 {
                    guard let v = readBits(11) else { return nil }
                    let a = v / 45
                    let b = v % 45
                    guard a < alphaChars.count, b < alphaChars.count else { return nil }
                    outBytes.append(contentsOf: String([alphaChars[a], alphaChars[b]]).utf8)
                    rem -= 2
                }
                if rem == 1 {
                    guard let v = readBits(6), v < alphaChars.count else { return nil }
                    outBytes.append(contentsOf: String(alphaChars[v]).utf8)
                }
            case 4: // Byte
                let ccBits = version <= 9 ? 8 : 16
                guard let count = readBits(ccBits) else { return nil }
                for _ in 0..<count {
                    guard let b = readBits(8) else { return nil }
                    outBytes.append(UInt8(b))
                }
            case 7: // ECI
                guard let first = readBits(8) else { return nil }
                if (first & 0x80) == 0 {
                    // 1-byte ECI
                } else if (first & 0xC0) == 0x80 {
                    guard readBits(8) != nil else { return nil }
                } else if (first & 0xE0) == 0xC0 {
                    guard readBits(16) != nil else { return nil }
                } else {
                    return nil
                }
            default:
                return nil
            }
        }

        return String(data: Data(outBytes), encoding: .utf8)
    }
}
