// Local speech-to-text. Runs whisper.cpp's whisper-server as a child process
// bound to 127.0.0.1. Audio is held in memory for the length of one request
// and is never written to disk.

import { existsSync } from "node:fs";
import type { Subprocess } from "bun";

export interface SttConfig {
  bin: string;
  model: string;
  port: number;
  threads: number;
}

// whisper emits these for silence or noise; they are not speech
const NON_SPEECH = /^\s*[\[(](?:blank_audio|silence|music|noise|inaudible|applause|laughter)[\])]\s*$/i;

export function cleanTranscript(raw: string): string {
  const text = raw
    .replace(/\[[^\]]*\]|\([^)]*\)/g, (m) => (NON_SPEECH.test(m) ? " " : m))
    .replace(/\s+/g, " ")
    .trim();
  return NON_SPEECH.test(text) ? "" : text;
}

export class Stt {
  private proc: Subprocess | null = null;
  private vocabulary = "";

  constructor(private cfg: SttConfig) {}

  get url(): string {
    return `http://127.0.0.1:${this.cfg.port}`;
  }

  /** Proper nouns from the brain, passed to whisper as a spelling hint. */
  setVocabulary(names: string[]): void {
    this.vocabulary = names.length ? `Names that may be mentioned: ${names.join(", ")}.` : "";
  }

  async start(): Promise<void> {
    if (!existsSync(this.cfg.model)) throw new Error(`speech model not found: ${this.cfg.model}`);
    this.proc = Bun.spawn(
      [this.cfg.bin, "-m", this.cfg.model, "--host", "127.0.0.1", "--port", String(this.cfg.port),
        "-t", String(this.cfg.threads), "-l", "en", "-nt"],
      { stdout: "ignore", stderr: "ignore" },
    );
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) throw new Error("whisper-server exited during startup (is the port in use?)");
      try {
        const r = await fetch(this.url, { signal: AbortSignal.timeout(1000) });
        if (r.status < 500) return;
      } catch {
        // not listening yet
      }
      await Bun.sleep(250);
    }
    throw new Error("whisper-server did not start within 30s");
  }

  stop(): void {
    try {
      this.proc?.kill();
    } catch {
      // already gone
    }
    this.proc = null;
  }

  async transcribe(wav: ArrayBuffer | Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    form.append("response_format", "json");
    form.append("temperature", "0.0");
    if (this.vocabulary) form.append("prompt", this.vocabulary);
    const r = await fetch(`${this.url}/inference`, { method: "POST", body: form, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`whisper-server ${r.status}`);
    const j = (await r.json()) as { text?: string };
    return cleanTranscript(j.text || "");
  }
}
