import AVFoundation
import Combine
import HotMicCore
import UIKit
import UserNotifications

/// Keeps the microphone open, but writes audio to disk only while the voice
/// gate is awake. The audio-thread work lives in AudioPipeline; this class is
/// the main-thread face of it: session, recovery, counts and sync.
///
/// The rule throughout: never claim to be listening when it is not. Every way
/// the microphone can be lost ends in `.interrupted`, which keeps retrying and
/// tells the user, rather than in a state that needs them to notice and tap.
@MainActor
final class Recorder: ObservableObject {
    enum State: Equatable { case off, listening, recording, interrupted, denied, failed(String) }

    @Published private(set) var state: State = .off
    @Published private(set) var problem: String?          // recording trouble, shown in red
    @Published private(set) var pendingCount = 0
    @Published private(set) var pendingBytes: Int64 = 0
    @Published private(set) var refusedCount = 0          // segments the Mac would not take
    @Published private(set) var recordedSec: Double = 0
    @Published private(set) var lastSyncAt: Date? = UserDefaults.standard.object(forKey: "lastSyncAt") as? Date
    @Published private(set) var syncProblem: String?      // needs the user: wrong token, wrong address, wrong Mac
    @Published private(set) var syncNote: String?         // expected: the Mac is simply not reachable from here
    @Published private(set) var pinnedCertificate: String? = UserDefaults.standard.string(forKey: "macCertificate")
    @Published private(set) var offeredCertificate: String?   // seen at the Mac's address, not yet trusted

    private var engine = AVAudioEngine()
    private let store: SegmentStore
    private var pipeline: AudioPipeline!
    private var observers: [NSObjectProtocol] = []
    private var resumeTask: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var syncing = false
    private var lastRestart = Date.distantPast
    private var recheck: Task<Void, Never>?
    private var resumeGeneration = 0          // stops a cancelled loop's defer from clearing its successor

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("segments")
        store = try! SegmentStore(dir: dir) // Application Support always exists for an installed app
        // Must stay writable while the phone is locked in a pocket.
        try? FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: dir.path)
        // Nothing is open at launch, so audio without a .json was cut off by a crash or a kill.
        _ = store.adoptOrphans(deviceName: UIDevice.current.name)
        pipeline = AudioPipeline(store: store, deviceName: UIDevice.current.name) { [weak self] event in
            Task { @MainActor in self?.handle(event) }
        }
        refreshCounts()
    }

    private func handle(_ event: AudioPipeline.Event) {
        switch event {
        case .woke: if isOn, state != .interrupted { state = .recording; problem = nil }
        case .slept: if isOn, state != .interrupted { state = .listening }
        case .segmentClosed(let seconds):
            recordedSec += seconds
            refreshCounts()
            Task { await sync() }
        case .failed(let message):
            problem = message
            if isOn, state != .interrupted { state = .listening }
        }
    }

    var isOn: Bool { state == .listening || state == .recording || state == .interrupted }

    // MARK: start, stop

    func start() async {
        guard !isOn else { return }
        guard await AVAudioApplication.requestRecordPermission() else { state = .denied; return }
        do {
            try configureSession()
            try AVAudioSession.sharedInstance().setActive(true)
            try startEngine()
            observe()
            state = .listening; problem = nil
            startWatchdog()
            // Asked after the microphone is running, and never awaited: listening must not
            // depend on the answer. Until it is allowed, the "not listening" warning cannot show.
            Task { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) }
        } catch { state = .failed(error.localizedDescription) }
    }

    func stop() {
        resumeTask?.cancel(); resumeTask = nil
        watchdog?.cancel(); watchdog = nil
        recheck?.cancel(); recheck = nil
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        pipeline.finish()
        observers.forEach(NotificationCenter.default.removeObserver); observers = []
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        Nudge.disarm()
        state = .off
        refreshCounts()
    }

    private func configureSession() throws {
        // Mixable, so music, a podcast or a video starting in another app does not take the
        // microphone away, and so iOS will let the session come back after a call while the
        // app is in the background (a non-mixable session is refused there). Trade-off: sound
        // from the phone's own speaker is heard by the microphone and can wake the recorder.
        // No .allowBluetooth: a hands-free headset microphone is 8 kHz and drops music to mono.
        try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .default,
                                                        options: [.mixWithOthers, .allowBluetoothA2DP, .defaultToSpeaker])
    }

    private func startEngine() throws {
        engine.stop()
        try pipeline.attach(to: engine.inputNode)
        engine.prepare()
        try engine.start()
    }

    // MARK: staying alive

    /// Closes the open segment and brings the engine back. On failure it does not give
    /// up: it becomes `.interrupted`, which retries now, on a timer, and when the app is opened.
    private func restart() {
        guard isOn else { return }
        // Route and configuration notifications arrive in bursts, and a restart can cause one.
        // A configuration change means the engine has stopped itself, so an event dropped here is
        // looked at again once the burst is over. That only restarts a dead engine, so it cannot loop.
        guard Date().timeIntervalSince(lastRestart) > 1 else {
            if recheck == nil {
                recheck = Task { @MainActor [weak self] in
                    try? await Task.sleep(for: .seconds(1.2))
                    guard let self, !Task.isCancelled else { return }
                    self.recheck = nil
                    if self.isOn, self.state != .interrupted, !self.engine.isRunning { self.restart() }
                }
            }
            return
        }
        lastRestart = Date()
        pipeline.finish()
        do {
            try startEngine()
            if state == .interrupted { state = .listening }
        } catch { lostMicrophone() }
    }

    private func lostMicrophone() {
        pipeline.finish()
        state = .interrupted
        Nudge.arm(after: 60, body: "Another app took the microphone. Open Hot Mic to resume.")
        resumeIfInterrupted()
    }

    /// iOS does not promise that an interruption ever reports its end, refuses to activate a
    /// session from the background in some cases, and says nothing when it does. So: retry a
    /// few times now, and again whenever the app comes to the front, where activation is allowed.
    ///
    /// `fresh` marks a real "the situation changed" signal (the interruption ended, the app was
    /// opened, the audio daemon restarted): drop any sleeping back-off and try from now.
    func resumeIfInterrupted(fresh: Bool = false) {
        guard state == .interrupted else { return }
        if fresh { resumeTask?.cancel(); resumeTask = nil }
        guard resumeTask == nil else { return }
        resumeGeneration += 1
        let mine = resumeGeneration
        resumeTask = Task { @MainActor [weak self] in
            defer { if let self, self.resumeGeneration == mine { self.resumeTask = nil } }
            for delay in [0.0, 1, 3, 8] {
                if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
                guard let self, !Task.isCancelled, self.state == .interrupted else { return }
                do {
                    try self.configureSession()
                    try AVAudioSession.sharedInstance().setActive(true)
                    try self.startEngine()
                    self.state = .listening
                    Nudge.arm(after: Nudge.deadManSeconds, body: Nudge.deadManBody)
                    return
                } catch { /* still interrupted; the next trigger tries again */ }
            }
        }
    }

    private func observe() {
        let nc = NotificationCenter.default
        observers.append(nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] note in
            let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
            let began = raw.flatMap(AVAudioSession.InterruptionType.init(rawValue:)) == .began
            Task { @MainActor in
                guard let self, self.isOn else { return }
                if began { self.lostMicrophone() }   // a call, Siri, another recorder
                else { self.resumeIfInterrupted(fresh: true) }
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in           // headphones, AirPods, CarPlay: the input format may change
                guard let self, self.state != .interrupted else { return }
                self.restart()
            }
        })
        // The engine stops itself, with no interruption, when the hardware format changes under
        // a mixable session. Without this it would sit dead behind a green "Listening".
        observers.append(nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.state != .interrupted else { return }
                self.restart()
            }
        })
        observers.append(nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in           // the audio daemon restarted: every audio object is dead
                guard let self, self.isOn else { return }
                self.pipeline.finish()
                self.engine = AVAudioEngine()
                self.state = .interrupted
                self.resumeIfInterrupted(fresh: true)
            }
        })
        observers.append(nc.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.resumeIfInterrupted(fresh: true) }
        })
    }

    /// Every five minutes while on: prove the microphone is still delivering audio, push the
    /// "not listening" notification further into the future, and try a sync. If the process
    /// dies or hangs, nothing pushes it back, and the notification fires by itself. That is
    /// the only way to tell the user, because iOS never relaunches a killed audio app.
    private func startWatchdog() {
        watchdog?.cancel()
        Nudge.arm(after: Nudge.deadManSeconds, body: Nudge.deadManBody)
        watchdog = Task { @MainActor [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(300))
                guard let self, !Task.isCancelled, self.isOn else { return }
                if self.state == .interrupted { self.resumeIfInterrupted(); continue }
                if !self.engine.isRunning || self.pipeline.secondsSinceLastBuffer() > 30 {
                    self.restart()          // the engine died without telling anyone
                    continue
                }
                Nudge.arm(after: Nudge.deadManSeconds, body: Nudge.deadManBody)
                await self.sync()
            }
        }
    }

    // MARK: sync

    func refreshCounts() {
        pendingCount = store.pending().count
        pendingBytes = store.bytesOnDisk()
    }

    func forgetMac() {
        UserDefaults.standard.removeObject(forKey: "macCertificate")
        pinnedCertificate = nil; offeredCertificate = nil; syncProblem = nil
        Task { await sync() }            // re-offer whatever answers now; nothing is sent until it is trusted
    }

    func trustOffered() {
        guard let c = offeredCertificate else { return }
        pinnedCertificate = c; UserDefaults.standard.set(c, forKey: "macCertificate")
        offeredCertificate = nil; syncProblem = nil
        Task { await sync() }
    }

    /// Forgives a missing scheme and stray spaces; rejects anything without a host, and anything
    /// that is not https: without TLS the certificate is never checked and the token travels in the clear.
    static func macBaseURL(_ raw: String) -> URL? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard let u = URL(string: s), u.scheme?.lowercased() == "https", let host = u.host, !host.isEmpty else { return nil }
        return u
    }

    /// Uploads oldest first. A segment leaves the phone only after the Mac proves it holds
    /// identical bytes. One segment the Mac refuses does not block the ones behind it.
    func sync() async {
        guard !syncing else { return }      // closing a segment and the watchdog can both ask at once
        syncing = true; defer { syncing = false; refreshCounts() }

        let raw = UserDefaults.standard.string(forKey: "macURL") ?? ""
        let token = Keychain.read("ingestToken") ?? ""
        if raw.isEmpty || token.isEmpty { syncProblem = nil; syncNote = nil; return }   // the main screen already asks for these
        guard let url = Self.macBaseURL(raw) else {
            syncProblem = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().hasPrefix("http://")
                ? "The Mac address must start with https://. Nothing was sent."
                : "The Mac address is not a valid address."
            return
        }
        if pinnedCertificate == nil {
            // Nothing leaves the phone for a computer the user has not confirmed. This is a handshake only.
            offeredCertificate = await Uploader.fingerprint(of: url)
            if offeredCertificate != nil { syncProblem = "Open Settings and confirm the Mac's certificate. Nothing is sent until you do."; syncNote = nil }
            else { syncProblem = nil; syncNote = "Mac not reachable. Recordings wait on the phone." }
            return
        }
        let pending = store.pending()
        guard !pending.isEmpty else { return }

        let up = Uploader(baseURL: url, token: token, pinnedCertificate: pinnedCertificate)
        defer { up.finish() }
        var sent = 0, refused = 0
        loop: for info in pending {
            guard let audio = store.existingAudioURL(info.id) else { continue }
            let size = (try? FileManager.default.attributesOfItem(atPath: audio.path)[.size] as? NSNumber)?.int64Value ?? 0
            if size < 1_000 || size > 64 * 1_024 * 1_024 { refused += 1; continue }   // the Mac's own limits; do not push 64 MB over Wi-Fi to be told no
            do {
                try await up.upload(info, audio: audio)
                store.remove(info.id); sent += 1
                syncProblem = nil; syncNote = nil
            } catch Uploader.UploadError.rejected(let code) where code == 400 || code == 409 || code == 413 {
                refused += 1                     // this segment only; it stays on the phone
            } catch Uploader.UploadError.rejected(401) {
                syncProblem = "The Mac refused the token. Check it in Settings."; break loop
            } catch Uploader.UploadError.wrongCertificate {
                syncProblem = "A different computer answered at the Mac's address, so nothing was sent."; break loop
            } catch Uploader.UploadError.notConfirmed {
                syncProblem = "The Mac did not confirm the recording, so it was kept on the phone."; break loop
            } catch Uploader.UploadError.rejected(let code) {
                syncProblem = "The Mac answered with an error (\(code))."; break loop
            } catch {
                syncNote = "Mac not reachable. Recordings wait on the phone."; break loop   // away from home: normal
            }
        }
        refusedCount = refused
        if sent > 0 {
            lastSyncAt = Date()
            UserDefaults.standard.set(lastSyncAt, forKey: "lastSyncAt")
        }
    }
}

/// One local notification, pushed into the future while all is well. It fires only if
/// the app stops pushing it: killed, crashed, hung, or shut out of the microphone.
enum Nudge {
    static let id = "hotmic.not-listening"
    static let deadManSeconds: TimeInterval = 900
    static let deadManBody = "Open Hot Mic to start listening again."

    static func arm(after seconds: TimeInterval, body: String) {
        let content = UNMutableNotificationContent()
        content.title = "Hot Mic is not listening"
        content.body = body
        content.sound = .default
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [id])
        // Adding a request with the same identifier replaces the pending one.
        center.add(UNNotificationRequest(identifier: id, content: content,
                                         trigger: UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)))
    }

    static func disarm() {
        let center = UNUserNotificationCenter.current()
        center.removePendingNotificationRequests(withIdentifiers: [id])
        center.removeDeliveredNotifications(withIdentifiers: [id])
    }
}
