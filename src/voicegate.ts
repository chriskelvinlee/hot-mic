// Voice gate: decides when a passive recorder should be recording.
//
// This is the reference implementation. ios/Sources/HotMicCore/VoiceGate.swift
// is a line-for-line port with the same constants; change both together.
//
// Wake: speech-band energy stays well above the room's noise floor for wakeMs.
// Sleep: no speech for hangoverSec. The floor adapts while asleep, so a loud
// cafe and a quiet office both work.

export interface VoiceGateConfig {
  sampleRate: number;
  wakeMs: number; // speech must persist this long to wake
  stayMs: number; // and this long to restart the hangover: one click must not keep it awake
  hangoverSec: number; // silence that ends a conversation
  maxSegmentSec: number; // long conversations are cut into parts
  wakeRatio: number; // energy must exceed the floor by this factor
  stayRatio: number; // easier to stay awake than to wake
  minFloor: number; // never treat digital silence as the floor
  minZeroCrossRate: number; // rumble (fans, traffic) has few crossings
  maxZeroCrossRate: number; // hiss and clatter have many
}

export const DEFAULT_GATE: VoiceGateConfig = {
  sampleRate: 16_000, wakeMs: 240, stayMs: 160, hangoverSec: 12, maxSegmentSec: 600,
  wakeRatio: 3.2, stayRatio: 1.9, minFloor: 0.0012, minZeroCrossRate: 0.02, maxZeroCrossRate: 0.35,
};

export type GateEvent = "wake" | "split" | "sleep";

export function rms(frame: Float32Array): number {
  if (!frame.length) return 0;
  let sum = 0;
  for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
  return Math.sqrt(sum / frame.length);
}

export function zeroCrossRate(frame: Float32Array): number {
  if (frame.length < 2) return 0;
  let n = 0;
  for (let i = 1; i < frame.length; i++) if (frame[i - 1] < 0 !== frame[i] < 0) n++;
  return n / (frame.length - 1);
}

export class VoiceGate {
  isAwake = false;
  noiseFloor: number;
  /** Whether the last frame looked like speech. Recorders use it to shorten long pauses. */
  lastFrameSpeech = false;
  /** True while awake and speech has been sustained; a single click does not set it. */
  speechSustained = false;
  private speechRunMs = 0;
  private silenceSec = 0;
  private segmentSec = 0;
  private winMin = Infinity; // lowest frame energy in the current 8 s window
  private winSec = 0;

  constructor(private cfg: VoiceGateConfig = DEFAULT_GATE) {
    this.noiseFloor = cfg.minFloor * 2;
  }

  /** Back to asleep, keeping the learned noise floor. Call when a segment is force-closed. */
  reset(): void {
    this.isAwake = false; this.speechRunMs = 0; this.silenceSec = 0; this.segmentSec = 0;
    this.speechSustained = false; this.lastFrameSpeech = false;
  }

  process(frame: Float32Array): GateEvent | null {
    const c = this.cfg;
    const frameSec = frame.length / c.sampleRate;
    const energy = rms(frame);
    const zcr = zeroCrossRate(frame);
    const voiced = zcr >= c.minZeroCrossRate && zcr <= c.maxZeroCrossRate;
    const ratio = this.isAwake ? c.stayRatio : c.wakeRatio;
    const speech = voiced && energy > Math.max(this.noiseFloor, c.minFloor) * ratio;
    this.lastFrameSpeech = speech;

    if (!speech) {
      // Track the room. Fall quickly, rise slowly, so speech never becomes the floor.
      const rate = energy < this.noiseFloor ? 0.2 : this.isAwake ? 0.002 : 0.02;
      this.noiseFloor = Math.max(c.minFloor, this.noiseFloor + (energy - this.noiseFloor) * rate);
    }

    // Minimum statistics: speech dips to room level every few seconds, steady noise never
    // does. Without this a fan, a car or a shower that starts suddenly counts as speech on
    // every frame, the floor (which only learns from non-speech frames) freezes, and the
    // gate never sleeps.
    this.winMin = Math.min(this.winMin, energy); this.winSec += frameSec;
    if (this.winSec >= 8) { if (this.winMin > this.noiseFloor) this.noiseFloor = this.winMin; this.winMin = Infinity; this.winSec = 0; }

    if (this.isAwake) {
      this.segmentSec += frameSec;
      // Only sustained speech restarts the hangover. Measured in a real room: a
      // single 20 ms click every few seconds otherwise keeps it recording forever.
      // Capped, so a long sentence does not take seconds to drain before the hangover can start.
      this.speechRunMs = speech ? Math.min(c.stayMs * 2, this.speechRunMs + frameSec * 1000) : Math.max(0, this.speechRunMs - frameSec * 500);
      this.speechSustained = this.speechRunMs >= c.stayMs;
      this.silenceSec = this.speechSustained ? 0 : this.silenceSec + frameSec;
      if (this.silenceSec >= c.hangoverSec) {
        this.isAwake = false; this.speechRunMs = 0; this.silenceSec = 0; this.segmentSec = 0; this.speechSustained = false;
        return "sleep";
      }
      // Cut in a real pause (speech no longer sustained), never on one quiet frame mid-word;
      // but at 1.5x the limit cut anyway, so no segment is unbounded.
      if (this.segmentSec >= c.maxSegmentSec && (!this.speechSustained || this.segmentSec >= c.maxSegmentSec * 1.5)) {
        this.segmentSec = 0;
        return "split";
      }
      return null;
    }

    this.speechRunMs = speech ? this.speechRunMs + frameSec * 1000 : Math.max(0, this.speechRunMs - frameSec * 500);
    if (this.speechRunMs >= c.wakeMs) {
      this.isAwake = true; this.silenceSec = 0; this.segmentSec = 0; this.speechRunMs = 0;
      return "wake";
    }
    return null;
  }
}

/** Holds the last few seconds while asleep, so the words that woke the gate are kept. */
export class PreRoll {
  private frames: Float32Array[] = [];
  private samples = 0;
  private capacity: number;
  constructor(seconds = 2, sampleRate = 16_000) {
    this.capacity = Math.floor(seconds * sampleRate);
  }
  push(frame: Float32Array): void {
    this.frames.push(frame);
    this.samples += frame.length;
    while (this.frames.length && this.samples - this.frames[0].length >= this.capacity) {
      this.samples -= this.frames.shift()!.length;
    }
  }
  drain(): Float32Array {
    const out = new Float32Array(this.samples);
    let o = 0;
    for (const f of this.frames) { out.set(f, o); o += f.length; }
    this.frames = []; this.samples = 0;
    return out;
  }
  get count(): number { return this.samples; }
}

/**
 * Speech regions of a finished recording, as [startSample, endSample) pairs.
 * Used before transcription: whisper invents sentences when given room noise
 * (measured: one sentence repeated 15 times over 30 s of clatter), so it is only
 * ever given the stretches where speech was sustained.
 */
export function speechRegions(
  pcm: Float32Array,
  opts: { padSec?: number; mergeGapSec?: number; minSec?: number; cfg?: VoiceGateConfig } = {},
): [number, number][] {
  const cfg = opts.cfg ?? DEFAULT_GATE;
  const sr = cfg.sampleRate, frame = Math.round(sr * 0.02);
  const pad = Math.round((opts.padSec ?? 0.35) * sr), mergeGap = Math.round((opts.mergeGapSec ?? 0.8) * sr), minLen = Math.round((opts.minSec ?? 0.3) * sr);

  // The floor is the quiet end of the recording itself: the 10th percentile of frame energy.
  const energies: number[] = [];
  for (let i = 0; i + frame <= pcm.length; i += frame) energies.push(rms(pcm.subarray(i, i + frame)));
  if (!energies.length) return [];
  const sorted = [...energies].sort((a, b) => a - b);
  const floor = Math.max(cfg.minFloor, sorted[Math.floor(sorted.length * 0.1)]);

  // Sustained speech only: the same run counter the live gate uses, so one click is not a region.
  const raw: [number, number][] = [];
  let run = 0, start = -1, lastSpeech = -1;
  for (let k = 0; k < energies.length; k++) {
    const f = pcm.subarray(k * frame, (k + 1) * frame);
    const z = zeroCrossRate(f);
    const speech = z >= cfg.minZeroCrossRate && z <= cfg.maxZeroCrossRate && energies[k] > floor * cfg.stayRatio;
    run = speech ? Math.min(cfg.stayMs * 2, run + 20) : Math.max(0, run - 10);
    if (run >= cfg.stayMs) {
      if (start < 0) start = Math.max(0, k * frame - Math.round((cfg.stayMs / 1000) * sr)); // include the onset that built the run
      lastSpeech = (k + 1) * frame;
    } else if (start >= 0 && run === 0) {
      raw.push([start, lastSpeech]); start = -1;
    }
  }
  if (start >= 0) raw.push([start, lastSpeech]);

  const out: [number, number][] = [];
  for (const [a, b] of raw) {
    const s = Math.max(0, a - pad), e = Math.min(pcm.length, b + pad);
    const prev = out[out.length - 1];
    if (prev && s - prev[1] <= mergeGap) prev[1] = Math.max(prev[1], e); else out.push([s, e]);
  }
  return out.filter(([a, b]) => b - a >= minLen);
}

/** Concatenates regions with a short gap between them, so words from separate stretches do not run together. */
export function keepRegions(pcm: Float32Array, regions: [number, number][], gapSec = 0.5, sampleRate = 16_000): Float32Array {
  const gap = Math.round(gapSec * sampleRate);
  const total = regions.reduce((n, [a, b]) => n + (b - a), 0) + gap * Math.max(0, regions.length - 1);
  const out = new Float32Array(total);
  let o = 0;
  regions.forEach(([a, b], i) => { out.set(pcm.subarray(a, b), o); o += b - a; if (i < regions.length - 1) o += gap; });
  return out;
}
