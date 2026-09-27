# Hot Mic for iPhone: passive, voice-gated recording

The phone listens all day but saves audio only while people are talking. Recordings go to your Mac over your local network, where local Whisper transcribes them into `~/HotMicArchive`. Nothing goes to a cloud service, and pending recordings are excluded from iCloud and Finder backups.

## Status

| Piece | State |
|---|---|
| Wake/sleep logic | Tested in TypeScript (`../src/voicegate.ts`, 21 checks) and in Swift (`./selfcheck.sh`), including real room recordings. The two are line-for-line ports; change both together. |
| App | Builds with Xcode 27 / Swift 6.4, no warnings. Runs in the iOS 27 simulator. |
| Full chain in the simulator, with real sound | Verified: wake, sleep 12 s after the last word, HTTPS upload, deletion only after the Mac proves it holds identical bytes, transcription. |
| Crash recovery | Verified: app killed mid-sentence, relaunched, the cut-off recording was recovered, uploaded and transcribed. |
| Trusting the Mac | Verified: before the Mac's certificate is confirmed nothing is sent; with a different certificate at the same address nothing is sent and the recording stays on the phone. |
| A physical iPhone | **Never run.** Unmeasured: battery over a day, audio from a pocket, hours with the screen locked, phone calls, Siri, AirPods and CarPlay, a full disk. The code for those paths was reviewed twice but cannot be exercised in the simulator. |

## How it behaves

- **Asleep:** the microphone is open and the last 2 seconds sit in memory. Nothing is written.
- **Wakes** after about a quarter second of speech that stands clear of the room's noise, and keeps the 2 seconds before that. A quiet room, steady hiss, low rumble, a fan or car that starts suddenly, and stray clicks do not keep it recording.
- **Sleeps** 12 seconds after the last sustained speech. Everything heard while awake is kept, pauses included; the Mac cuts silence before transcribing.
- Conversations longer than 10 minutes are cut into parts in a pause, and at 15 minutes regardless.
- It wakes for any voice, not only yours. Gating on your voice alone would drop every stretch where you are listening. Telling speakers apart is not built.
- It shares the microphone: music, a podcast or a video in another app does not stop it. The cost is that sound from the phone's own speaker can wake it.
- A phone call or Siri takes the microphone. The app closes the recording, shows "Not listening", and retries by itself and whenever you open it.
- **If it stops, it tells you.** While listening, the app keeps pushing a "Hot Mic is not listening" notification 15 minutes into the future. If the app is killed, crashes, hangs or loses the microphone, nothing pushes it back and it fires. iOS never relaunches a killed audio app, so this is the only warning possible. Allow notifications when asked.
- iOS shows its orange microphone dot the whole time the app is listening. That cannot be hidden.

## Recording format, measured

16 kHz mono AAC at 32 kbps in a streamable `.aac` file: about 15 MB per hour of speech.

- Bitrate: ordinary words were transcribed correctly at every bitrate from 24 to 64 kbps, and names were unreliable at every bitrate. Higher bitrates buy nothing.
- Container: an `.m4a` or `.caf` that is open when the app dies is unreadable. An `.aac` cut off anywhere plays up to the cut (tested: 6.08 of 6.1 seconds recovered), so that is what the app writes.

## Set up

1. Generate and open the project:

```bash
cd ios && xcodegen && open HotMic.xcodeproj
```

2. In Xcode, select the HotMic target, then Signing & Capabilities, and choose your Apple ID as the Team. Plug in the phone and press Run. A free Apple ID works but the app expires after 7 days; a paid developer account lasts a year.
3. On the Mac, start the receiver. It prints the address to enter in the app. The token is in `~/.hotmic/ingest-token`.

```bash
./bin/hotmic-ingest
```

4. In the app's Settings, enter the address (`https://...:4750`), paste the token and tap Sync now. Settings then shows the certificate of whatever computer answered. Check it against the fingerprint the receiver prints, and tap Trust this Mac. Nothing is sent before that, and afterwards the phone sends only to that certificate. "Forget this Mac" starts this step again.

Recordings upload when one finishes, when you open the app, and every five minutes while it is listening. Away from home they wait on the phone.

Check the core logic at any time, without Xcode's project:

```bash
./ios/selfcheck.sh
```

## Where it goes on the Mac

```
~/HotMicArchive/audio/2026-09-27/<id>.aac              the recordings, exactly as recorded
~/HotMicArchive/transcripts/2026-09-27.md              one readable file per day, local dates
~/HotMicArchive/transcripts/2026-09-27/<id>.txt        one file per recording
~/HotMicArchive/transcripts/2026-09-27/<id>.plain.txt  only when a name came from a hint (see below)
```

The archive is outside `~/brain` and outside Dropbox on purpose, and is readable only by your user. Nothing here writes to GBrain. Your Otter test batch found ambient recordings with unlabelled speakers were mostly not worth ingesting, and that drafts needed an independent check. Treat this archive the same way: intake to be triaged, not memory.

## What the transcript can and cannot be trusted for

Whisper on ambient audio has two failure modes, both seen on real room recordings here: given room noise it invented a sentence and repeated it fifteen times, and given a long list of names as a hint it dropped a whole sentence.

- Whisper is only ever given the stretches with sustained speech. The original audio is kept untouched, so this can be redone.
- Names are fixed by a second pass hinted with only the brain names found in the first pass. The hinted version is used only if it otherwise says the same thing, word for word within a small tolerance.
- When a name appears only because the hint put it there (not a mere respelling of what was heard), the transcript says so and keeps the unhinted version beside it. Code cannot tell a mangled "Satya Patel" from a real "Sasha Patel".
- A repetition loop is collapsed to one copy and marked "may be invented. Check the audio."
- A quiet speaker far from the phone may still be missing from the transcript. They are in the audio.

## Before you carry it

California requires the consent of everyone in a private conversation before it is recorded (Penal Code 632), and so do about ten other states. An always-on recorder will capture people who have not agreed unless you pause it. The app's one large button is Pause for that reason. This is also the material your own rules keep out of any index: lawyer calls, health, co-parenting, anything involving a minor.

## Not built

- Telling speakers apart, including picking out your own voice.
- Finding the Mac by name. The address is a typed IP, which goes stale if your router hands the Mac a different one.
- An Apple Watch or lock-screen control for Pause.
