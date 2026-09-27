import Foundation

/// Decides when to record. Feed it fixed-size frames of mono audio; it says
/// when a conversation starts and ends. Pure logic, no audio APIs, so it can be
/// tested anywhere.
///
/// Wake: speech-band energy stays well above the room's noise floor for
/// `wakeMs`. Sleep: no speech for `hangoverSec`. The noise floor adapts slowly
/// while asleep, so a loud cafe and a quiet office both work.
public struct VoiceGateConfig: Sendable {
    public var sampleRate: Double = 16_000
    public var wakeMs: Double = 240          // speech must persist this long to wake
    public var stayMs: Double = 160          // and this long to restart the hangover: one click must not keep it awake
    public var hangoverSec: Double = 12      // silence that ends a conversation
    public var maxSegmentSec: Double = 600   // long conversations are cut into parts
    public var wakeRatio: Float = 3.2        // energy must exceed floor by this factor
    public var stayRatio: Float = 1.9        // easier to stay awake than to wake
    public var minFloor: Float = 0.0012      // never treat digital silence as the floor
    public var minZeroCrossRate: Float = 0.02 // rumble (fans, traffic) has few crossings
    public var maxZeroCrossRate: Float = 0.35 // hiss and clatter have many
    public init() {}
}

public enum VoiceGateEvent: Equatable, Sendable {
    case wake            // start a segment; include the pre-roll
    case split           // close this segment and open the next, no gap
    case sleep           // close the segment
}

public struct VoiceGate {
    public private(set) var isAwake = false
    public private(set) var noiseFloor: Float
    /// Whether the last frame looked like speech. Recorders use it to shorten long pauses.
    public private(set) var lastFrameSpeech = false
    /// True while awake and speech has been sustained; a single click does not set it.
    public private(set) var speechSustained = false
    private let cfg: VoiceGateConfig
    private var speechRunMs: Double = 0
    private var silenceSec: Double = 0
    private var segmentSec: Double = 0
    private var winMin: Float = .infinity // lowest frame energy in the current 8 s window
    private var winSec: Double = 0

    public init(config: VoiceGateConfig = .init()) {
        cfg = config
        noiseFloor = config.minFloor * 2
    }

    /// Back to asleep, keeping the learned noise floor. Call when a segment is force-closed.
    public mutating func reset() {
        isAwake = false; speechRunMs = 0; silenceSec = 0; segmentSec = 0
        speechSustained = false; lastFrameSpeech = false
    }

    public static func rms(_ frame: [Float]) -> Float {
        guard !frame.isEmpty else { return 0 }
        var sum: Float = 0
        for s in frame { sum += s * s }
        return (sum / Float(frame.count)).squareRoot()
    }

    public static func zeroCrossRate(_ frame: [Float]) -> Float {
        guard frame.count > 1 else { return 0 }
        var n = 0
        for i in 1..<frame.count where (frame[i - 1] < 0) != (frame[i] < 0) { n += 1 }
        return Float(n) / Float(frame.count - 1)
    }

    public mutating func process(_ frame: [Float]) -> VoiceGateEvent? {
        let frameSec = Double(frame.count) / cfg.sampleRate
        let energy = Self.rms(frame)
        let zcr = Self.zeroCrossRate(frame)
        let voiced = zcr >= cfg.minZeroCrossRate && zcr <= cfg.maxZeroCrossRate
        let ratio = isAwake ? cfg.stayRatio : cfg.wakeRatio
        let speech = voiced && energy > max(noiseFloor, cfg.minFloor) * ratio
        lastFrameSpeech = speech

        if !speech {
            // Track the room. Fall quickly, rise slowly, so speech never becomes the floor.
            let rate: Float = energy < noiseFloor ? 0.2 : (isAwake ? 0.002 : 0.02)
            noiseFloor = max(cfg.minFloor, noiseFloor + (energy - noiseFloor) * rate)
        }

        // Minimum statistics: speech dips to room level every few seconds, steady noise never
        // does. Without this a fan, a car or a shower that starts suddenly counts as speech on
        // every frame, the floor (which only learns from non-speech frames) freezes, and the
        // gate never sleeps.
        winMin = min(winMin, energy); winSec += frameSec
        if winSec >= 8 { if winMin > noiseFloor { noiseFloor = winMin }; winMin = .infinity; winSec = 0 }

        if isAwake {
            segmentSec += frameSec
            // Only sustained speech restarts the hangover. Measured in a real room: a
            // single 20 ms click every few seconds otherwise keeps it recording forever.
            // Capped, so a long sentence does not take seconds to drain before the hangover can start.
            speechRunMs = speech ? min(cfg.stayMs * 2, speechRunMs + frameSec * 1000) : max(0, speechRunMs - frameSec * 500)
            speechSustained = speechRunMs >= cfg.stayMs
            silenceSec = speechSustained ? 0 : silenceSec + frameSec
            if silenceSec >= cfg.hangoverSec {
                isAwake = false; speechRunMs = 0; silenceSec = 0; segmentSec = 0; speechSustained = false
                return .sleep
            }
            // Cut in a real pause (speech no longer sustained), never on one quiet frame mid-word;
            // but at 1.5x the limit cut anyway, so no segment is unbounded.
            if segmentSec >= cfg.maxSegmentSec && (!speechSustained || segmentSec >= cfg.maxSegmentSec * 1.5) {
                segmentSec = 0
                return .split
            }
            return nil
        }

        speechRunMs = speech ? speechRunMs + frameSec * 1000 : max(0, speechRunMs - frameSec * 500)
        if speechRunMs >= cfg.wakeMs {
            isAwake = true; silenceSec = 0; segmentSec = 0; speechRunMs = 0
            return .wake
        }
        return nil
    }
}

/// Holds the last few seconds of audio while asleep, so the words that woke the
/// gate are not lost.
public struct PreRoll {
    private var frames: [[Float]] = []
    private var samples = 0
    private let capacity: Int

    public init(seconds: Double = 2.0, sampleRate: Double = 16_000) {
        capacity = Int(seconds * sampleRate)
    }

    public mutating func push(_ frame: [Float]) {
        frames.append(frame); samples += frame.count
        while samples - (frames.first?.count ?? 0) >= capacity, !frames.isEmpty {
            samples -= frames.removeFirst().count
        }
    }

    public mutating func drain() -> [Float] {
        defer { frames.removeAll(keepingCapacity: true); samples = 0 }
        return frames.flatMap { $0 }
    }

    public var count: Int { samples }
}
