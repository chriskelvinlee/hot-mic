import SwiftUI
import Security

@main
struct HotMicApp: App {
    @StateObject private var recorder = Recorder()
    @Environment(\.scenePhase) private var phase
    var body: some Scene {
        WindowGroup {
            ContentView().environmentObject(recorder)
                .onChange(of: phase) { _, p in if p == .active { Task { await recorder.sync() } } }
                .task {
                    #if targetEnvironment(simulator)
                    // Simulator only: lets a test pass the token on the command line.
                    if let t = UserDefaults.standard.string(forKey: "simIngestToken"), !t.isEmpty { Keychain.write("ingestToken", t) }
                    #endif
                    if UserDefaults.standard.bool(forKey: "autostart") { await recorder.start() }
                    await recorder.sync() // anything left from last time, including a recording recovered after a crash
                }
        }
    }
}

struct ContentView: View {
    @EnvironmentObject var recorder: Recorder
    @AppStorage("macURL") private var macURL = ""
    @AppStorage("autostart") private var autostart = false
    @State private var token = Keychain.read("ingestToken") ?? ""
    @State private var showSettings = false
    @State private var tokenSaveFailed = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 28) {
                Spacer()
                Circle().fill(color).frame(width: 120, height: 120)
                    .overlay(Image(systemName: icon).font(.system(size: 48)).foregroundStyle(.white))
                Text(title).font(.title2.weight(.semibold))
                Text(subtitle).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(.horizontal)

                // One large control, reachable without looking: pausing must be instant.
                Button(recorder.isOn ? "Pause" : "Start listening") {
                    Task { if recorder.isOn { recorder.stop() } else { await recorder.start() } }
                }
                .font(.title3.weight(.semibold)).frame(maxWidth: .infinity).padding(.vertical, 18)
                .background(recorder.isOn ? Color.secondary.opacity(0.25) : Color.accentColor).foregroundStyle(recorder.isOn ? Color.primary : .white)
                .clipShape(RoundedRectangle(cornerRadius: 16)).padding(.horizontal, 28)

                Spacer()
                VStack(spacing: 6) {
                    if let problem = recorder.problem { Text(problem).foregroundStyle(.red) }
                    Text("\(recorder.pendingCount) recording(s) waiting · \(ByteCountFormatter.string(fromByteCount: recorder.pendingBytes, countStyle: .file))")
                    Text("Recorded since launch: \(Int(recorder.recordedSec / 60)) min · last sync: \(lastSyncText)")
                    if recorder.refusedCount > 0 { Text("\(recorder.refusedCount) recording(s) the Mac refused. They are kept on the phone.").foregroundStyle(.orange) }
                    if let p = recorder.syncProblem { Text(p).foregroundStyle(.red) }
                    else if let n = recorder.syncNote, recorder.pendingCount > 0 { Text(n) }
                    if macURL.isEmpty || token.isEmpty { Text("Set the Mac address and token in Settings to sync.").foregroundStyle(.orange) }
                }.font(.footnote).foregroundStyle(.secondary).padding(.bottom)
            }
            .onAppear { token = Keychain.read("ingestToken") ?? token }
            .navigationTitle("Hot Mic")
            .toolbar { Button { showSettings = true } label: { Image(systemName: "gearshape") } }
            .sheet(isPresented: $showSettings) { settings }
        }
    }

    private var settings: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://10.0.0.97:4750", text: $macURL).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    SecureField("Token", text: $token).onChange(of: token) { _, t in tokenSaveFailed = !Keychain.write("ingestToken", t.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    if tokenSaveFailed { Text("The token could not be saved to the keychain.").foregroundStyle(.red).font(.footnote) }
                    Button("Sync now") { Task { await recorder.sync() } }
                    if let offered = recorder.offeredCertificate {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("The computer at this address shows this certificate. It must match the fingerprint the Mac prints:").font(.footnote)
                            Text(offered.prefix(32) + "…").font(.caption.monospaced())
                        }
                        Button("Trust this Mac") { recorder.trustOffered() }
                    }
                    if let pin = recorder.pinnedCertificate {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("This phone only sends to the Mac with this certificate:").font(.footnote)
                            Text(pin.prefix(32) + "…").font(.caption.monospaced()).foregroundStyle(.secondary)
                        }
                        Button("Forget this Mac", role: .destructive) { recorder.forgetMac() }
                    }
                } header: {
                    Text("Mac")
                } footer: {
                    Text("Run bin/hotmic-ingest on the Mac. It prints the address. The token is in ~/.hotmic/ingest-token. Tap Sync now, compare the certificate with the fingerprint the Mac prints, then tap Trust this Mac. Recordings leave the phone only after the Mac proves it holds identical copies.")
                }
                Section {
                    Toggle("Start listening when the app opens", isOn: $autostart)
                }
                Section("Recording other people") {
                    Text("California and several other states require everyone's consent to record a private conversation. iOS shows the orange microphone dot while this app listens. Pause before any conversation where the other person has not agreed.")
                        .font(.footnote)
                }
            }
            .navigationTitle("Settings").toolbar { Button("Done") { showSettings = false } }
        }
    }

    private var lastSyncText: String {
        guard let at = recorder.lastSyncAt else { return "never" }
        return at.formatted(.relative(presentation: .named))
    }

    private var color: Color {
        switch recorder.state { case .recording: .red; case .listening: .green; case .interrupted: .orange; case .off: .gray; default: .orange }
    }
    private var icon: String {
        switch recorder.state { case .recording: "waveform"; case .listening: "ear"; case .off: "pause.fill"; default: "exclamationmark.triangle" }
    }
    private var title: String {
        switch recorder.state {
        case .off: "Paused"; case .listening: "Listening for voices"; case .recording: "Recording a conversation"
        case .interrupted: "Not listening: another app has the microphone"; case .denied: "Microphone access is off"
        case .failed(let m): "Stopped: \(m)"
        }
    }
    private var subtitle: String {
        switch recorder.state {
        case .listening: "Nothing is being saved. It starts when someone speaks and stops 12 seconds after the last word."
        case .recording: "Saving audio on this phone. It will go to your Mac, and nowhere else."
        case .denied: "Turn it on in Settings › Privacy & Security › Microphone."
        case .interrupted: "It will try again by itself, and when you open this app."
        default: ""
        }
    }
}

enum Keychain {
    @discardableResult
    static func write(_ key: String, _ value: String) -> Bool {
        let base: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "hotmic", kSecAttrAccount as String: key]
        SecItemDelete(base as CFDictionary)
        var add = base; add[kSecValueData as String] = Data(value.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock // readable while locked in a pocket
        return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
    }
    static func read(_ key: String) -> String? {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "hotmic", kSecAttrAccount as String: key,
                                kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }
}
