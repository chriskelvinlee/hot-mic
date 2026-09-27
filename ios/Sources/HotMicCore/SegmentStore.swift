import CryptoKit
import Foundation

/// One recorded conversation (or part of one) waiting to reach the Mac.
public struct SegmentInfo: Codable, Equatable, Sendable {
    public var id: String            // also the file stem
    public var startedAt: Date
    public var durationSec: Double
    public var part: Int             // 1, 2, 3... when a long conversation was split
    public var device: String
    public init(id: String, startedAt: Date, durationSec: Double, part: Int, device: String) {
        self.id = id; self.startedAt = startedAt; self.durationSec = durationSec; self.part = part; self.device = device
    }
}

/// Files on the phone: <id>.aac plus <id>.json. The .json is written last, so its
/// presence means the segment is complete. A segment is deleted only after the
/// Mac confirms it holds identical bytes.
///
/// Audio is ADTS (.aac), not .m4a. Measured: an .m4a or .caf that is still open
/// when the process dies is unreadable (no moov atom / packet table); an .aac cut
/// off at any point plays up to the cut. `.m4a` is kept as a fallback and for
/// segments recorded by earlier builds.
public struct SegmentStore: Sendable {
    public let dir: URL
    public init(dir: URL) throws {
        self.dir = dir
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Pending audio must never ride along in iCloud or Finder backups; the Mac is the only other copy.
        var d = dir
        var rv = URLResourceValues(); rv.isExcludedFromBackup = true
        try? d.setResourceValues(rv)
    }

    private static func formatter() -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX"); f.timeZone = TimeZone(identifier: "UTC")
        f.dateFormat = "yyyyMMdd'T'HHmmss'Z'"
        return f
    }

    public static func makeId(_ date: Date, part: Int) -> String { "\(formatter().string(from: date))-p\(part)" }

    public static func parseId(_ id: String) -> (date: Date, part: Int)? {
        let bits = id.components(separatedBy: "-p")
        guard bits.count == 2, let date = formatter().date(from: bits[0]), let part = Int(bits[1]) else { return nil }
        return (date, part)
    }

    public func audioURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).aac") }
    public func legacyAudioURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).m4a") }
    public func infoURL(_ id: String) -> URL { dir.appendingPathComponent("\(id).json") }
    public func existingAudioURL(_ id: String) -> URL? {
        [audioURL(id), legacyAudioURL(id)].first { FileManager.default.fileExists(atPath: $0.path) }
    }

    /// True if any file already uses this id. Ids have one-second resolution.
    public func isTaken(_ id: String) -> Bool {
        existingAudioURL(id) != nil || FileManager.default.fileExists(atPath: infoURL(id).path)
    }

    public func save(_ info: SegmentInfo) throws {
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        try enc.encode(info).write(to: infoURL(info.id), options: .atomic)
    }

    /// Finished segments, oldest first.
    public func pending() -> [SegmentInfo] {
        let dec = JSONDecoder(); dec.dateDecodingStrategy = .iso8601
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { $0.pathExtension == "json" }
            .compactMap { try? dec.decode(SegmentInfo.self, from: Data(contentsOf: $0)) }
            .filter { existingAudioURL($0.id) != nil }
            .sorted { $0.startedAt < $1.startedAt }
    }

    /// Audio files with no .json: a segment that was open when the process died.
    public func orphans() -> [URL] {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return files.filter { ["aac", "m4a"].contains($0.pathExtension) }
            .filter { !FileManager.default.fileExists(atPath: infoURL($0.deletingPathExtension().lastPathComponent).path) }
    }

    public func remove(_ id: String) {
        for url in [audioURL(id), legacyAudioURL(id), infoURL(id)] { try? FileManager.default.removeItem(at: url) }
    }

    public func bytesOnDisk() -> Int64 {
        let files = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: [.fileSizeKey])) ?? []
        return files.reduce(0) { $0 + Int64((try? $1.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0) }
    }
}

/// Accepts exactly one server certificate. The Mac's certificate is self-signed,
/// so the usual chain check cannot apply; instead the phone shows the certificate's
/// SHA-256 and sends nothing until the user trusts it (as SSH does with host keys),
/// and refuses any other from then on. A different host answering at the Mac's
/// address therefore gets neither the token nor the audio.
public final class CertificatePin: NSObject, URLSessionDelegate, @unchecked Sendable {
    private var expected: String?          // guarded by lock; nil = accept the first certificate seen, then only that one
    private let lock = NSLock()
    private var _seen: String?
    public var seen: String? { lock.lock(); defer { lock.unlock() }; return _seen }

    /// True when a certificate was presented and it was not the remembered one.
    public var mismatch: Bool { lock.lock(); defer { lock.unlock() }; guard let expected, let _seen else { return false }; return _seen != expected }

    public init(expected: String?) { self.expected = expected?.lowercased() }

    public func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                           completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let leaf = (SecTrustCopyCertificateChain(trust) as? [SecCertificate])?.first else {
            completionHandler(.performDefaultHandling, nil); return
        }
        let der = SecCertificateCopyData(leaf) as Data
        let print = SHA256.hash(data: der).map { String(format: "%02x", $0) }.joined()
        lock.lock(); _seen = print; if expected == nil { expected = print }; let ok = expected == print; lock.unlock()
        if ok { completionHandler(.useCredential, URLCredential(trust: trust)) }
        else { completionHandler(.cancelAuthenticationChallenge, nil) }
    }
}

/// Sends finished segments to the Mac over the local network.
public struct Uploader: Sendable {
    public var baseURL: URL          // e.g. https://10.0.0.97:4750
    public var token: String
    public let pin: CertificatePin
    private let session: URLSession

    public enum UploadError: Error, Equatable { case rejected(Int), notConfirmed, wrongCertificate }

    public init(baseURL: URL, token: String, pinnedCertificate: String?) {
        self.baseURL = baseURL; self.token = token
        pin = CertificatePin(expected: pinnedCertificate)
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30      // no bytes moving for this long: give up
        cfg.timeoutIntervalForResource = 300
        cfg.waitsForConnectivity = false
        session = URLSession(configuration: cfg, delegate: pin, delegateQueue: nil)
    }

    public func finish() { session.finishTasksAndInvalidate() }

    public static func sha256(of file: URL) throws -> String {
        SHA256.hash(data: try Data(contentsOf: file, options: .mappedIfSafe)).map { String(format: "%02x", $0) }.joined()
    }

    public func upload(_ info: SegmentInfo, audio: URL) async throws {
        var req = URLRequest(url: baseURL.appendingPathComponent("segments").appendingPathComponent(info.id))
        req.httpMethod = "PUT"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue(audio.pathExtension == "aac" ? "audio/aac" : "audio/mp4", forHTTPHeaderField: "Content-Type")
        let enc = JSONEncoder(); enc.dateEncodingStrategy = .iso8601
        req.setValue(try enc.encode(info).base64EncodedString(), forHTTPHeaderField: "X-HotMic-Info")
        let digest = try Self.sha256(of: audio)
        req.setValue(digest, forHTTPHeaderField: "X-HotMic-SHA256")

        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.upload(for: req, fromFile: audio) }
        catch let e as URLError where e.code == .cancelled || e.code == .serverCertificateUntrusted || e.code == .secureConnectionFailed {
            if pin.mismatch { throw UploadError.wrongCertificate }
            throw e
        }
        guard let http = resp as? HTTPURLResponse else { throw UploadError.rejected(0) }
        guard http.statusCode == 200 else { throw UploadError.rejected(http.statusCode) }
        // The phone deletes its only copy on the strength of this reply, so it must prove the Mac
        // holds the same bytes, not merely the same number of them.
        struct Ack: Decodable { let sha256: String }
        guard (try? JSONDecoder().decode(Ack.self, from: data))?.sha256.lowercased() == digest else { throw UploadError.notConfirmed }
    }
}

extension Uploader {
    /// The certificate presented at an address. Handshake only: no token and no audio are sent.
    /// The Mac answers 401, which is expected.
    public static func fingerprint(of baseURL: URL) async -> String? {
        let pin = CertificatePin(expected: nil)
        let s = URLSession(configuration: .ephemeral, delegate: pin, delegateQueue: nil)
        defer { s.finishTasksAndInvalidate() }
        var req = URLRequest(url: baseURL.appendingPathComponent("health")); req.timeoutInterval = 10
        _ = try? await s.data(for: req)
        return pin.seen
    }
}
