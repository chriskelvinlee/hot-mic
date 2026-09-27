import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_GATE, PreRoll, VoiceGate, type GateEvent } from "../src/voicegate";

const SR = 16_000, FRAME = 320; // 20 ms
let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 0xffffffff) * 2 - 1;
const gen = (sec: number, f: (t: number) => number) => Float32Array.from({ length: Math.floor(sec * SR) }, (_, i) => f(i / SR));
const noise = (sec: number, amp: number) => gen(sec, () => rnd() * amp);
const tone = (sec: number, hz: number, amp: number) => gen(sec, (t) => Math.sin(2 * Math.PI * hz * t) * amp);
/** Voice-like: a 140 Hz buzz with harmonics at syllable rate, over faint room noise. */
const voice = (sec: number, amp: number) =>
  gen(sec, (t) => {
    const syll = Math.max(0, Math.sin(2 * Math.PI * 3.5 * t));
    const buzz = Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 280 * t) + 0.4 * Math.sin(2 * Math.PI * 700 * t) + 0.25 * Math.sin(2 * Math.PI * 1900 * t);
    return buzz * 0.4 * amp * syll + rnd() * 0.002;
  });
const cat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};

function run(signal: Float32Array, cfg = DEFAULT_GATE) {
  const gate = new VoiceGate(cfg), pre = new PreRoll();
  const events: { e: GateEvent; at: number }[] = [];
  let recorded = 0;
  for (let i = 0; i + FRAME <= signal.length; i += FRAME) {
    const frame = signal.subarray(i, i + FRAME);
    const wasAwake = gate.isAwake;
    const e = gate.process(frame);
    if (e) {
      events.push({ e, at: (i + FRAME) / SR });
      if (e === "wake") recorded += pre.drain().length / SR;
    }
    if (gate.isAwake || wasAwake) recorded += FRAME / SR; else pre.push(frame.slice());
  }
  return { kinds: events.map((x) => x.e), events, recorded };
}

describe("voice gate", () => {
  test("quiet room, one conversation: wakes fast, sleeps 12 s after the last word, records only that", () => {
    const r = run(cat(noise(5, 0.004), voice(6, 0.25), noise(20, 0.004)));
    expect(r.kinds).toEqual(["wake", "sleep"]);
    expect(r.events[0].at - 5).toBeLessThan(0.8);
    expect(Math.abs(r.events[1].at - 23)).toBeLessThan(1);
    expect(r.recorded).toBeGreaterThan(19);
    expect(r.recorded).toBeLessThan(22); // of 31 s
  });
  test("a quiet room never wakes it", () => expect(run(noise(60, 0.004)).kinds).toEqual([]));
  test("steady loud hiss (air conditioning, road noise) never wakes it", () =>
    expect(run(cat(noise(10, 0.004), noise(60, 0.05))).kinds).toEqual([]));
  test("low rumble never wakes it", () => expect(run(cat(noise(5, 0.004), tone(30, 50, 0.3))).kinds).toEqual([]));
  test("noisy cafe: still wakes for a voice over the din, then sleeps", () =>
    expect(run(cat(noise(20, 0.03), voice(6, 0.35), noise(20, 0.03))).kinds).toEqual(["wake", "sleep"]));
  test("a 5 s pause inside a conversation does not split it", () =>
    expect(run(cat(noise(3, 0.004), voice(4, 0.25), noise(5, 0.004), voice(4, 0.25), noise(20, 0.004))).kinds).toEqual(["wake", "sleep"]));
  test("a long conversation is cut into parts, in pauses", () => {
    const parts = [noise(2, 0.004)];
    for (let i = 0; i < 8; i++) parts.push(voice(5, 0.25), noise(2, 0.004));
    parts.push(noise(20, 0.004));
    const k = run(cat(...parts), { ...DEFAULT_GATE, maxSegmentSec: 20 }).kinds;
    expect(k[0]).toBe("wake");
    expect(k.at(-1)).toBe("sleep");
    expect(k.filter((x) => x === "split").length).toBeGreaterThanOrEqual(2);
  });
  test("steady in-band noise that starts suddenly (fan, car, shower) does not latch it awake", () => {
    // white noise through a one-pole low-pass: zero-crossing rate lands inside the speech band
    const a = Math.exp((-2 * Math.PI * 300) / SR); let y = 0;
    const raw = gen(90, () => (y = a * y + (1 - a) * rnd()));
    let e = 0; for (const v of raw) e += v * v; const k = 0.03 / Math.sqrt(e / raw.length);
    const fan = raw.map((v) => v * k);
    const r = run(cat(noise(15, 0.004), fan));
    expect(r.kinds.filter((x) => x === "wake").length).toBeLessThanOrEqual(1);
    if (r.kinds.length) { expect(r.kinds).toEqual(["wake", "sleep"]); expect(r.events[1].at).toBeLessThan(15 + 45); }
    // and speech over the fan still wakes it afterwards
    const r2 = run(cat(noise(15, 0.004), fan.subarray(0, 60 * SR), voice(5, 0.6).map((v, i) => v + fan[i]), fan.subarray(0, 30 * SR)));
    expect(r2.kinds.filter((x) => x === "wake").length).toBeGreaterThanOrEqual(1);
    expect(r2.kinds.at(-1)).toBe("sleep");
  });
  test("speech with no pause at all is still cut at 1.5x the limit", () => {
    const k = run(cat(noise(2, 0.004), gen(80, (t) => Math.sin(2 * Math.PI * 180 * t) * 0.2 + rnd() * 0.002), noise(20, 0.004)), { ...DEFAULT_GATE, maxSegmentSec: 20 }).kinds;
    expect(k.filter((x) => x === "split").length).toBeGreaterThanOrEqual(1);
  });
  test("reset puts it back to sleep and the next speech wakes it again", () => {
    const g = new VoiceGate(); const v = voice(3, 0.25);
    let woke = 0;
    const feed = (sig: Float32Array) => { for (let i = 0; i + FRAME <= sig.length; i += FRAME) if (g.process(sig.subarray(i, i + FRAME)) === "wake") woke++; };
    feed(noise(3, 0.004)); feed(v); expect(g.isAwake).toBe(true);
    g.reset(); expect(g.isAwake).toBe(false);
    feed(v); expect(woke).toBe(2);
  });
  test("stray clicks during the hangover do not keep it awake", () => {
    const tail = noise(30, 0.001);
    for (let t = 2; t < 30; t += 3) for (let i = 0; i < FRAME; i++) tail[Math.floor(t * SR) + i] += Math.sin(i * 0.9) * 0.05; // a 20 ms click every 3 s
    const r = run(cat(noise(3, 0.001), voice(5, 0.25), tail));
    expect(r.kinds).toEqual(["wake", "sleep"]);
    expect(r.events[1].at).toBeLessThan(3 + 5 + 12 + 1.5);
  });
  test("real room recording (speaker to microphone, with blips in the silence): sleeps 12 s after the speech", () => {
    const d = readFileSync(join(import.meta.dir, "fixtures", "room-say.wav"));
    const pcm = new Float32Array((d.length - 44) >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = d.readInt16LE(44 + i * 2) / 32768;
    const gate = new VoiceGate();
    let wokeAt = -1, sleptAt = -1;
    for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
      const e = gate.process(pcm.subarray(i, i + FRAME));
      if (e === "wake" && wokeAt < 0) wokeAt = i / SR;
      if (e === "sleep" && sleptAt < 0) sleptAt = i / SR;
    }
    expect(wokeAt).toBeGreaterThanOrEqual(0);
    expect(wokeAt).toBeLessThan(3);        // speech starts about 2 s in
    expect(sleptAt).toBeGreaterThan(20);   // speech ends about 9.5 s in
    expect(sleptAt).toBeLessThan(23.5);    // it used to run to the end of the file
  });
  test("pre-roll keeps about 2 s however long it has been asleep", () => {
    const p = new PreRoll(2);
    for (let i = 0; i < 500; i++) p.push(new Float32Array(FRAME));
    expect(p.count).toBeGreaterThanOrEqual(32_000);
    expect(p.count).toBeLessThan(32_000 + FRAME * 2);
    expect(p.drain().length).toBeGreaterThanOrEqual(32_000);
    expect(p.count).toBe(0);
  });
});

// Real speech, when clips are available (16 kHz mono 16-bit WAV).
const dir = process.env.HOTMIC_TEST_WAVS;
describe.skipIf(!dir || !existsSync(dir!))("voice gate on real speech", () => {
  for (const f of dir && existsSync(dir) ? readdirSync(dir).filter((x) => x.endsWith(".wav")) : []) {
    test(`${f}: wakes within 1 s and keeps the first word`, () => {
      const d = readFileSync(join(dir!, f));
      const pcm = new Float32Array((d.length - 44) >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = d.readInt16LE(44 + i * 2) / 32768;
      const r = run(cat(noise(4, 0.004), pcm, noise(16, 0.004)));
      expect(r.kinds).toEqual(["wake", "sleep"]);
      expect(r.events[0].at - 4).toBeLessThan(1);
      expect(r.recorded).toBeGreaterThan(pcm.length / SR + 11); // all the speech + hangover
    });
  }
});
