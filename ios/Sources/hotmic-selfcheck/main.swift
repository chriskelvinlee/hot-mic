import Foundation
#if canImport(HotMicCore)
import HotMicCore
#endif

// Self-check for the recording logic. Run: swift run hotmic-selfcheck [wav ...]
var failures = 0
func check(_ ok: Bool, _ what: String) { print(ok ? "  PASS  \(what)" : "  FAIL  \(what)"); if !ok { failures += 1 } }

let sr = 16_000.0, frameLen = 320 // 20 ms
var seed: UInt64 = 42
func rnd() -> Float { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Float(Int64(bitPattern: seed >> 11) % 2_000_001) / 1_000_000 - 1 }
func noise(_ sec: Double, _ amp: Float) -> [Float] { (0..<Int(sec * sr)).map { _ in rnd() * amp } }
/// Voice-like: a 140 Hz buzz with harmonics, syllable-rate amplitude, over room noise.
func voice(_ sec: Double, _ amp: Float) -> [Float] {
    (0..<Int(sec * sr)).map { i in
        let t = Double(i) / sr
        let syll = Float(max(0, sin(2 * .pi * 3.5 * t)))
        let buzz = Float(sin(2 * .pi * 140 * t) + 0.6 * sin(2 * .pi * 280 * t) + 0.4 * sin(2 * .pi * 700 * t) + 0.25 * sin(2 * .pi * 1900 * t))
        return buzz * 0.4 * amp * syll + rnd() * 0.002
    }
}
func tone(_ sec: Double, hz: Double, _ amp: Float) -> [Float] { (0..<Int(sec * sr)).map { Float(sin(2 * .pi * hz * Double($0) / sr)) * amp } }

/// Runs a signal through the gate; returns (event, time in seconds) pairs and recorded seconds.
func run(_ signal: [Float], _ cfg: VoiceGateConfig = .init()) -> (events: [(VoiceGateEvent, Double)], recorded: Double) {
    var gate = VoiceGate(config: cfg), pre = PreRoll(), events: [(VoiceGateEvent, Double)] = [], recorded = 0.0
    var i = 0
    while i + frameLen <= signal.count {
        let frame = Array(signal[i..<i + frameLen]); i += frameLen
        let wasAwake = gate.isAwake
        if let e = gate.process(frame) {
            events.append((e, Double(i) / sr))
            if e == .wake { recorded += Double(pre.drain().count) / sr }
        }
        if gate.isAwake || wasAwake { recorded += Double(frameLen) / sr } else { pre.push(frame) }
    }
    return (events, recorded)
}

print("VoiceGate")
do {
    let r = run(noise(5, 0.004) + voice(6, 0.25) + noise(20, 0.004))
    check(r.events.map(\.0) == [.wake, .sleep], "quiet room, one conversation: wake then sleep")
    if r.events.count == 2 {
        check(r.events[0].1 > 5.0 && r.events[0].1 < 5.8, String(format: "wakes within 0.8 s of speech (%.2f s)", r.events[0].1 - 5))
        check(abs(r.events[1].1 - 23) < 1.0, String(format: "sleeps about 12 s after the last word (%.1f s)", r.events[1].1 - 11))
        check(r.recorded > 19 && r.recorded < 22, String(format: "records speech + pre-roll + hangover, not the whole 31 s (%.1f s)", r.recorded))
    }
}
check(run(noise(60, 0.004)).events.isEmpty, "a quiet room never wakes it")
check(run(noise(10, 0.004) + noise(60, 0.05)).events.isEmpty, "steady loud hiss (air conditioning, road noise) never wakes it")
check(run(noise(5, 0.004) + tone(30, hz: 50, 0.3)).events.isEmpty, "low rumble never wakes it")
do {
    let r = run(noise(20, 0.03) + voice(6, 0.35) + noise(20, 0.03))
    check(r.events.map(\.0) == [.wake, .sleep], "noisy cafe: still wakes for a raised voice, then sleeps")
}
do {
    let r = run(noise(3, 0.004) + voice(4, 0.25) + noise(5, 0.004) + voice(4, 0.25) + noise(20, 0.004))
    check(r.events.map(\.0) == [.wake, .sleep], "a 5 s pause inside a conversation does not split it")
}
do {
    var cfg = VoiceGateConfig(); cfg.maxSegmentSec = 20
    var sig = noise(2, 0.004); for _ in 0..<8 { sig += voice(5, 0.25) + noise(2, 0.004) }; sig += noise(20, 0.004)
    let kinds = run(sig, cfg).events.map(\.0)
    check(kinds.first == .wake && kinds.last == .sleep && kinds.filter { $0 == .split }.count >= 2, "a long conversation is cut into parts, in pauses")
}

do { // a 20 ms click every 3 s must not restart the hangover (found with a real room recording)
    var tail = noise(30, 0.001)
    var t = 2.0
    while t < 30 { let at = Int(t * sr); for i in 0..<frameLen { tail[at + i] += sin(Float(i) * 0.9) * 0.05 }; t += 3 }
    let r = run(noise(3, 0.001) + voice(5, 0.25) + tail)
    check(r.events.map(\.0) == [.wake, .sleep] && (r.events.last?.1 ?? 99) < 3 + 5 + 12 + 1.5, "stray clicks during the hangover do not keep it awake")
}
do { // steady in-band noise that starts suddenly: a fan, a car, a shower
    let a = Float(exp(-2 * Double.pi * 300 / sr)); var y: Float = 0
    var fan = (0..<Int(90 * sr)).map { _ -> Float in y = a * y + (1 - a) * rnd(); return y }
    let level = (fan.reduce(0) { $0 + $1 * $1 } / Float(fan.count)).squareRoot()
    fan = fan.map { $0 * 0.03 / level }
    let kinds = run(noise(15, 0.004) + fan).events
    check(kinds.isEmpty || (kinds.map(\.0) == [.wake, .sleep] && kinds[1].1 < 60), "sudden steady noise does not latch it awake (slept at \(kinds.last.map { String(format: "%.0f s", $0.1) } ?? "never woke"))")
}
do { // speech-like sound with no pause at all is still cut
    var cfg = VoiceGateConfig(); cfg.maxSegmentSec = 20
    let drone = (0..<Int(80 * sr)).map { Float(sin(2 * .pi * 180 * Double($0) / sr)) * 0.2 + rnd() * 0.002 }
    check(run(noise(2, 0.004) + drone + noise(20, 0.004), cfg).events.contains { $0.0 == .split }, "sound with no pause is still cut at 1.5x the limit")
}
do { // closing a segment by force must put the gate back to sleep, or everything after is dropped
    var g = VoiceGate(); var wakes = 0
    func feed(_ sig: [Float]) { var i = 0; while i + frameLen <= sig.count { if g.process(Array(sig[i..<i + frameLen])) == .wake { wakes += 1 }; i += frameLen } }
    feed(noise(3, 0.004)); feed(voice(3, 0.25))
    let awakeBefore = g.isAwake
    g.reset()
    let asleepAfter = !g.isAwake
    feed(voice(3, 0.25))
    check(awakeBefore && asleepAfter && wakes == 2, "reset() puts it to sleep and the next speech wakes it again")
}

print("PreRoll")
do {
    var p = PreRoll(seconds: 2)
    for _ in 0..<500 { p.push([Float](repeating: 0, count: frameLen)) }
    check(p.count >= 32_000 && p.count < 32_000 + frameLen * 2, "keeps about 2 s, however long it has been asleep")
    check(p.drain().count >= 32_000 && p.count == 0, "drain empties it")
}

print("SegmentStore")
do {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hotmic-\(UUID().uuidString)")
    let store = try SegmentStore(dir: dir)
    let d = Date(timeIntervalSince1970: 1_790_000_000)
    let id = SegmentStore.makeId(d, part: 1)
    check(id == "20260921T141320Z-p1", "ids are sortable UTC timestamps (\(id))")
    try Data([1, 2, 3]).write(to: store.audioURL(id))
    check(store.pending().isEmpty, "a segment still being written is not offered for upload")
    try store.save(SegmentInfo(id: id, startedAt: d, durationSec: 3, part: 1, device: "test"))
    check(store.pending().map(\.id) == [id], "a finished segment is pending")
    store.remove(id)
    check(store.pending().isEmpty && store.bytesOnDisk() == 0, "remove deletes audio and metadata")
    check(SegmentStore.parseId(id).map { $0.part == 1 && abs($0.date.timeIntervalSince(d)) < 1 } ?? false, "an id parses back to its date and part")
    try Data([9, 9, 9]).write(to: store.audioURL("20260921T150000Z-p1"))
    check(store.orphans().map(\.lastPathComponent) == ["20260921T150000Z-p1.aac"] && store.pending().isEmpty, "audio with no .json is an orphan, not a pending segment")
    check(store.isTaken("20260921T150000Z-p1") && !store.isTaken("20260921T150001Z-p1"), "an id already on disk is never reused")
    try? FileManager.default.removeItem(at: dir)
}

// Real speech: 16 kHz mono 16-bit WAV files given on the command line.
for path in CommandLine.arguments.dropFirst() {
    guard let d = FileManager.default.contents(atPath: path), d.count > 44 else { continue }
    let pcm: [Float] = stride(from: 44, to: d.count - 1, by: 2).map { Float(Int16(bitPattern: UInt16(d[$0]) | UInt16(d[$0 + 1]) << 8)) / 32768 }
    let r = run(noise(4, 0.004) + pcm + noise(16, 0.004))
    let wake = r.events.first.map { $0.1 - 4 } ?? -1
    check(r.events.map(\.0) == [.wake, .sleep] && wake < 1.0, String(format: "real speech %@: woke %.2f s in, slept after", (path as NSString).lastPathComponent, wake))
}

print(failures == 0 ? "\nAll checks passed." : "\n\(failures) check(s) failed.")
exit(failures == 0 ? 0 : 1)
