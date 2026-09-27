import AVFoundation
import HotMicCore

/// Everything that runs off the main thread: format conversion, the voice gate,
/// and writing segments. All mutable state here is touched only on `queue`.
///
/// This is deliberately not main-actor isolated. A tap block created inside a
/// main-actor type inherits that isolation, and Swift 6 aborts at runtime when
/// the audio thread calls it.
final class AudioPipeline: @unchecked Sendable {
    enum Event: Sendable { case woke, slept, segmentClosed(seconds: Double), failed(String) }
    enum PipelineError: LocalizedError {
        case noInput
        var errorDescription: String? { "No microphone input is available right now." }
    }

    let queue = DispatchQueue(label: "hotmic.audio")
    private let store: SegmentStore
    private let deviceName: String
    private let onEvent: @Sendable (Event) -> Void

    private var gate = VoiceGate()
    private var preRoll = PreRoll()
    private var converter: AVAudioConverter?
    private var carry: [Float] = []
    private var file: AVAudioFile?
    private var segmentId = ""
    private var segmentStart = Date()
    private var segmentSamples = 0
    private var part = 1
    private var lastBuffer = Date.distantPast
    private var framesSinceSpaceCheck = 0
    private let frameLen = 320 // 20 ms at 16 kHz
    private let minFreeBytes: Int64 = 50_000_000
    private let target = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000, channels: 1, interleaved: false)!

    init(store: SegmentStore, deviceName: String, onEvent: @escaping @Sendable (Event) -> Void) {
        self.store = store; self.deviceName = deviceName; self.onEvent = onEvent
    }

    /// Installs the tap. Call again after any route or configuration change.
    ///
    /// The tap is installed with `format: nil` and the converter is built from the
    /// buffers that actually arrive. Passing a format captured a moment earlier can
    /// mismatch the bus after a route change, and AVAudioEngine answers that with an
    /// Objective-C exception that Swift cannot catch.
    func attach(to input: AVAudioInputNode) throws {
        input.removeTap(onBus: 0)
        let hw = input.inputFormat(forBus: 0), out = input.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0, out.sampleRate > 0, out.channelCount > 0 else { throw PipelineError.noInput }
        queue.sync { converter = nil; carry.removeAll(); lastBuffer = Date() }
        input.installTap(onBus: 0, bufferSize: 4096, format: nil) { [weak self] buffer, _ in
            guard let self, buffer.frameLength > 0, let copy = buffer.deepCopy() else { return } // the engine reuses its buffer
            self.queue.async { self.consume(copy) }
        }
    }

    /// Closes any open segment and puts the gate back to sleep. Used on pause, on an
    /// interruption and before any engine restart.
    ///
    /// The gate reset matters: closing the file while the gate stays awake leaves it
    /// "awake with nothing open", and every frame after that was silently discarded
    /// until 12 s of silence let it sleep and wake again.
    func finish() {
        queue.sync {
            let wasAwake = gate.isAwake
            closeSegment()
            gate.reset(); preRoll = PreRoll(); carry.removeAll()
            if wasAwake { onEvent(.slept) }
        }
    }

    /// How long since the microphone last delivered audio. Large while "listening" means the engine died quietly.
    func secondsSinceLastBuffer() -> Double { queue.sync { Date().timeIntervalSince(lastBuffer) } }

    private func consume(_ buffer: AVAudioPCMBuffer) {
        lastBuffer = Date()
        if converter?.inputFormat != buffer.format { converter = AVAudioConverter(from: buffer.format, to: target); carry.removeAll() }
        guard let converter else { return }
        let ratio = target.sampleRate / buffer.format.sampleRate
        guard let out = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64) else { return }
        var fed = false
        var err: NSError?
        converter.convert(to: out, error: &err) { _, status in
            if fed { status.pointee = .noDataNow; return nil }
            fed = true; status.pointee = .haveData; return buffer
        }
        guard err == nil, out.frameLength > 0, let ch = out.floatChannelData?[0] else { return }
        carry.append(contentsOf: UnsafeBufferPointer(start: ch, count: Int(out.frameLength)))

        var offset = 0
        while carry.count - offset >= frameLen {
            let frame = Array(carry[offset..<offset + frameLen]); offset += frameLen
            let wasAwake = gate.isAwake
            switch gate.process(frame) {
            case .wake:
                openSegment(startingAt: Date().addingTimeInterval(-Double(preRoll.count) / 16_000), part: 1)
                write(preRoll.drain())
                write(frame)
                if file != nil { onEvent(.woke) } // a failed open or first write already sent .failed and reset the gate
            case .split:
                write(frame)
                let next = part + 1
                closeSegment()
                openSegment(startingAt: Date(), part: next)
            case .sleep:
                write(frame)
                closeSegment()
                onEvent(.slept)
            case nil:
                // Everything heard while awake is kept, pauses included. Shortening pauses here
                // threw away a quiet second speaker for good (measured: 0.02 s of a 9 s answer
                // survived). The Mac cuts silence before transcribing, and it can be redone there.
                if gate.isAwake {
                    if file == nil { openSegment(startingAt: Date(), part: part + 1) } // a failed open must not drop the rest
                    write(frame)
                } else if wasAwake { write(frame) } else { preRoll.push(frame) }
            }
        }
        carry.removeFirst(offset)
    }

    private func freeBytes() -> Int64 {
        // A fresh URL each time: resource values are cached on the URL object.
        let v = try? URL(fileURLWithPath: store.dir.path).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return v?.volumeAvailableCapacityForImportantUsage ?? .max
    }

    private func openSegment(startingAt requested: Date, part: Int) {
        guard freeBytes() >= minFreeBytes else {
            file = nil; gate.reset()
            onEvent(.failed("iPhone storage is nearly full, so nothing is being recorded."))
            return
        }
        // Ids have one-second resolution; never reuse one that is on disk.
        var date = requested
        while store.isTaken(SegmentStore.makeId(date, part: part)) { date.addTimeInterval(1) }
        segmentId = SegmentStore.makeId(date, part: part)
        segmentStart = date; segmentSamples = 0; self.part = part; framesSinceSpaceCheck = 0

        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 16_000, AVNumberOfChannelsKey: 1,
            // Measured on the Mac: whisper is as accurate at 24 kbps as at 64. 32 leaves margin.
            AVEncoderBitRateKey: 32_000,
        ]
        do {
            file = try AVAudioFile(forWriting: store.audioURL(segmentId), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
        } catch {
            try? FileManager.default.removeItem(at: store.audioURL(segmentId)) // a zero-byte stub
            do {
                file = try AVAudioFile(forWriting: store.legacyAudioURL(segmentId), settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            } catch {
                file = nil; gate.reset()
                onEvent(.failed("Could not start a recording: \(error.localizedDescription)"))
            }
        }
    }

    private func write(_ samples: [Float]) {
        guard let file, !samples.isEmpty, let buf = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buf.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { buf.floatChannelData![0].update(from: $0.baseAddress!, count: samples.count) }
        do {
            try file.write(from: buf)
            segmentSamples += samples.count
        } catch {
            // Keep what was written, stop pretending, and let the next speech try a fresh file.
            closeSegment(); gate.reset()
            onEvent(.failed("Recording stopped: \(error.localizedDescription)"))
            return
        }
        framesSinceSpaceCheck += 1
        if framesSinceSpaceCheck >= 1500 { // every 30 s of recording
            framesSinceSpaceCheck = 0
            if freeBytes() < minFreeBytes {
                closeSegment(); gate.reset()
                onEvent(.failed("iPhone storage is nearly full, so recording stopped."))
            }
        }
    }

    private func closeSegment() {
        guard file != nil else { return }
        file = nil // releasing the AVAudioFile flushes the encoder
        let seconds = Double(segmentSamples) / 16_000
        if seconds > 1.5 {
            // The .json is written last: its presence means "this segment is complete".
            try? store.save(SegmentInfo(id: segmentId, startedAt: segmentStart, durationSec: seconds, part: part, device: deviceName))
        } else {
            store.remove(segmentId)
        }
        onEvent(.segmentClosed(seconds: seconds))
    }
}

extension SegmentStore {
    /// Segments that were open when the process died. An .aac cut off anywhere still
    /// plays, so it is given its .json and uploaded like any other; anything unreadable
    /// or too short is removed so it cannot sit on the phone for ever.
    func adoptOrphans(deviceName: String) -> Int {
        var adopted = 0
        for url in orphans() {
            let id = url.deletingPathExtension().lastPathComponent
            let seconds = (try? AVAudioFile(forReading: url)).map { Double($0.length) / $0.fileFormat.sampleRate } ?? 0
            if seconds > 1.5, let parsed = SegmentStore.parseId(id),
               (try? save(SegmentInfo(id: id, startedAt: parsed.date, durationSec: seconds, part: parsed.part, device: deviceName))) != nil {
                adopted += 1
            } else {
                try? FileManager.default.removeItem(at: url)
            }
        }
        return adopted
    }
}

private extension AVAudioPCMBuffer {
    func deepCopy() -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameLength) else { return nil }
        copy.frameLength = frameLength
        let src = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: audioBufferList))
        let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
        for i in 0..<min(src.count, dst.count) {
            guard let s = src[i].mData, let d = dst[i].mData else { continue }
            memcpy(d, s, min(Int(src[i].mDataByteSize), Int(dst[i].mDataByteSize)))
        }
        return copy
    }
}
