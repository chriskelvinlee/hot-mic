// Hot Mic ingest: receives recorded segments from the phone over the local
// network and transcribes them with whisper.cpp on this Mac.
//
// Output goes to ~/HotMicArchive (override with HOTMIC_ARCHIVE). That folder is
// deliberately outside ~/brain and outside Dropbox: raw ambient transcripts are
// intake, and nothing here writes to GBrain. Promote by hand, after review.
//
// Unlike the HUD server this one listens on the LAN, because the phone has to
// reach it. It serves HTTPS with its own self-signed certificate, which the
// phone remembers on first contact, so neither the token nor the audio crosses
// shared Wi-Fi in the clear and no other host can pose as this Mac. Every
// request also needs the bearer token in ~/.hotmic/ingest-token.

import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync,
  unlinkSync, writeFileSync,
} from "node:fs";
import { homedir, networkInterfaces, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { X509Certificate, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { loadConfig } from "./config";
import { loadLibrary } from "./library";
import { EntityMatcher, likelyPeople } from "./match";
import { DEFAULT_GATE, keepRegions, speechRegions } from "./voicegate";
import { choose, cleanLines, introducedNames } from "./transcript";

const env = process.env;
const ARCHIVE = resolve(env.HOTMIC_ARCHIVE?.replace(/^~/, homedir()) || join(homedir(), "HotMicArchive"));
const PORT = Number(env.HOTMIC_INGEST_PORT || 4750);
const TLS = !["off", "0", "false"].includes((env.HOTMIC_INGEST_TLS || "on").toLowerCase());
const WHISPER = env.HOTMIC_WHISPER_CLI || "/opt/homebrew/bin/whisper-cli";
const FFMPEG = env.HOTMIC_FFMPEG || "/opt/homebrew/bin/ffmpeg";
const MODEL = resolve(env.HOTMIC_WHISPER_MODEL?.replace(/^~/, homedir()) || join(import.meta.dir, "..", "models", "ggml-small.en.bin"));
const MAX_BYTES = 64 * 1024 * 1024; // fifteen minutes at 32 kbps is under 4 MB; this is a ceiling, not a target
const ID_RE = /^\d{8}T\d{6}Z-p\d{1,3}$/; // the only accepted shape, so an id can never be a path
const EXTS = ["aac", "m4a"] as const;
const log = (...a: unknown[]) => console.log("[ingest]", ...a);

// ---- secrets: token, and the certificate the phone pins ------------------------
const secretDir = join(homedir(), ".hotmic");
const tokenPath = join(secretDir, "ingest-token");
const keyPath = join(secretDir, "ingest-key.pem");
const certPath = join(secretDir, "ingest-cert.pem");
mkdirSync(secretDir, { recursive: true, mode: 0o700 });
if (!existsSync(tokenPath)) writeFileSync(tokenPath, randomBytes(24).toString("base64url") + "\n", { mode: 0o600 });
chmodSync(tokenPath, 0o600);
const TOKEN = readFileSync(tokenPath, "utf8").trim();

let fingerprint = "";
if (TLS) {
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    const r = Bun.spawnSync(["/usr/bin/openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "3650",
      "-subj", "/CN=hotmic-ingest", "-keyout", keyPath, "-out", certPath], { stdout: "ignore", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`could not create the certificate: ${r.stderr.toString().slice(0, 200)}`);
  }
  chmodSync(keyPath, 0o600);
  fingerprint = createHash("sha256").update(new X509Certificate(readFileSync(certPath)).raw).digest("hex");
}

function authorized(req: Request): boolean {
  const got = Buffer.from((req.headers.get("authorization") || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && timingSafeEqual(got, want);
}

// ---- archive layout ----------------------------------------------------------
const dayOf = (id: string) => `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}`;
const audioDir = (id: string) => join(ARCHIVE, "audio", dayOf(id));
const audioPath = (id: string, ext: string) => join(audioDir(id), `${id}.${ext}`);
const existingAudio = (id: string) => EXTS.map((e) => audioPath(id, e)).find((p) => existsSync(p));
const infoPath = (id: string) => join(audioDir(id), `${id}.json`);
const textDir = (id: string) => join(ARCHIVE, "transcripts", dayOf(id));
const textPath = (id: string) => join(textDir(id), `${id}.txt`);
mkdirSync(join(ARCHIVE, "audio"), { recursive: true, mode: 0o700 });
mkdirSync(join(ARCHIVE, "transcripts"), { recursive: true, mode: 0o700 });

// Bun's fsyncSync is plain fsync(2), which on macOS does not make the drive commit its cache
// (see `man fsync`); F_FULLFSYNC does. fd and cmd are fixed arguments, so the call is safe on
// arm64. Failing to load it must never stop the receiver starting.
const F_FULLFSYNC = 51;
let fullSync: ((fd: number) => boolean) | null = null;
if (process.platform === "darwin") {
  try {
    const libc = dlopen("libSystem.B.dylib", { fcntl: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    fullSync = (fd) => libc.symbols.fcntl(fd, F_FULLFSYNC) === 0;
  } catch (e) { console.log(`[ingest] F_FULLFSYNC unavailable, falling back to fsync: ${(e as Error).message}`); }
}

/** Flushes a file or directory to stable storage. The phone deletes its only copy once we answer. */
function durable(path: string): void {
  const fd = openSync(path, "r");
  try { if (!fullSync?.(fd)) fsyncSync(fd); } finally { closeSync(fd); } // fsync for volumes without F_FULLFSYNC
}

interface Info { startedAt?: string; durationSec?: number; device?: string }
function readInfo(id: string): Info {
  try {
    const j = JSON.parse(readFileSync(infoPath(id), "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

/** Inserts or replaces one segment's block in a day file, so re-transcribing never duplicates it. */
function upsertDayBlock(dayFile: string, header: string, id: string, block: string): void {
  const marker = `<!-- ${id} -->\n`;
  let body = existsSync(dayFile) ? readFileSync(dayFile, "utf8") : header;
  const at = body.indexOf(marker);
  if (at >= 0) {
    const prevEnd = body.lastIndexOf("-->\n", at - 1);
    const start = prevEnd >= 0 ? prevEnd + 4 : header.length;
    body = body.slice(0, start) + block + body.slice(at + marker.length);
  } else body += block;
  const tmp = `${dayFile}.part`;
  writeFileSync(tmp, body, { mode: 0o600 });
  renameSync(tmp, dayFile); // a crash cannot leave half a day file
}

// ---- transcription -------------------------------------------------------------
// Names are what whisper gets wrong ("Sachi Patel from Supercent"), and a hint
// fixes them. But a long hint is harmful: measured on a real room recording, an
// 80-name hint made whisper drop a whole sentence. So the hint is built per
// segment: transcribe once with no hint, find the brain's names in that text
// (the matcher tolerates the manglings), and hint with only those.
function glossaryFor(firstPass: string): string[] {
  try {
    const cfg = loadConfig();
    const pages = loadLibrary(cfg.brainDir, cfg.packDirs).pages;
    const hits = new EntityMatcher(pages).match(firstPass);
    return [...new Set([...likelyPeople(firstPass, pages), ...hits.filter((h) => h.score >= 0.5).map((h) => h.page)].map((p) => p.title))].slice(0, 12);
  } catch { return []; }
}

const queue: string[] = [];
let working = false;

async function sh(cmd: string[]): Promise<{ code: number; err: string }> {
  const p = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  return { code: await p.exited, err };
}

function dayFileFor(id: string, info: Info): { path: string; header: string; when: string; mins: string } {
  // The day file follows the local calendar: a 5:40 pm conversation belongs to today, not to UTC's tomorrow.
  const started = info.startedAt ? new Date(info.startedAt) : null;
  const ok = started && !isNaN(+started);
  const localDay = ok ? `${started!.getFullYear()}-${String(started!.getMonth() + 1).padStart(2, "0")}-${String(started!.getDate()).padStart(2, "0")}` : dayOf(id);
  return {
    path: join(ARCHIVE, "transcripts", `${localDay}.md`),
    header: `# ${localDay}\n\nRaw ambient transcript. Unreviewed. Speakers are not identified.\n`,
    when: ok ? started!.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }) : `${id.slice(9, 11)}:${id.slice(11, 13)} UTC`,
    mins: typeof info.durationSec === "number" ? ` (${Math.max(1, Math.round(info.durationSec / 60))} min)` : "",
  };
}

async function transcribe(id: string): Promise<void> {
  const source = existingAudio(id);
  if (!source) throw new Error("audio file is missing");
  const wav = join(tmpdir(), `hotmic-${id}-${process.pid}.wav`);
  const outStem = join(tmpdir(), `hotmic-${id}-${process.pid}`);
  try {
    const r = await sh([FFMPEG, "-loglevel", "error", "-y", "-i", source, "-ar", "16000", "-ac", "1", wav]);
    if (r.code !== 0) throw new Error(`ffmpeg: ${r.err.trim().slice(0, 200)}`);

    // Whisper only ever sees the stretches with sustained speech. Given room noise it
    // invents sentences and loops on them; given speech regions it did not (measured).
    const raw = readFileSync(wav);
    const pcm = new Float32Array((raw.length - 44) >> 1);
    for (let i = 0; i < pcm.length; i++) pcm[i] = raw.readInt16LE(44 + i * 2) / 32768;
    // The floor here is the recording's own quiet end. The live gate's absolute minFloor is for
    // waking; applied here it sits about 2x above a clean room and cut a quiet second speaker
    // out before whisper heard them (measured: answers recovered 27/36 -> 36/36 without it).
    const regions = speechRegions(pcm, { cfg: { ...DEFAULT_GATE, minFloor: 0.0004 } });
    let text = "", disclosure = "", note: string | undefined;
    if (regions.length) {
      const kept = keepRegions(pcm, regions);
      const out = Buffer.alloc(44 + kept.length * 2);
      out.write("RIFF", 0); out.writeUInt32LE(36 + kept.length * 2, 4); out.write("WAVEfmt ", 8); out.writeUInt32LE(16, 16);
      out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22); out.writeUInt32LE(16000, 24); out.writeUInt32LE(32000, 28);
      out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(kept.length * 2, 40);
      for (let i = 0; i < kept.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(kept[i] * 32768))), 44 + i * 2);
      writeFileSync(wav, out);

      const pass = async (hint: string): Promise<string> => {
        const w = await sh([WHISPER, "-m", MODEL, "-f", wav, "-l", "en", "-otxt", "-of", outStem, "-np", ...(hint ? ["--prompt", hint] : [])]);
        if (w.code !== 0) throw new Error(`whisper: ${w.err.trim().slice(0, 200)}`);
        return readFileSync(`${outStem}.txt`, "utf8");
      };
      const plain = await pass("");
      const names = glossaryFor(plain);
      const hintedRaw = names.length ? await pass(names.join(", ") + ".") : null;
      // Slack is for names the hint actually changed, not for names offered.
      const changed = hintedRaw === null ? 0 : introducedNames(cleanLines(hintedRaw), cleanLines(plain), names).length;
      const picked = choose(plain, hintedRaw, changed);
      text = picked.text; note = picked.note;
      // whisper sometimes lower-cases a hinted name ("satya Patel"); restore the brain's spelling
      for (const name of names.filter((n) => n.length > 3)) {
        text = text.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), name);
      }
      if (picked.used === "hinted") {
        // Code cannot tell a mangled "Satya Patel" from a real "Sasha Patel". So when a name is in the
        // transcript only because the hint put it there, say so and keep what was heard without the hint.
        const plainClean = cleanLines(plain);
        const introduced = introducedNames(text, plainClean, names, true); // a respelling is not worth a warning
        if (introduced.length) {
          mkdirSync(textDir(id), { recursive: true, mode: 0o700 });
          writeFileSync(join(textDir(id), `${id}.plain.txt`), plainClean + "\n", { mode: 0o600 });
          disclosure = `\n\n_(name taken from a brain hint, not heard independently: ${introduced.join(", ")}. Unhinted version: ${id}.plain.txt)_`;
        }
      }
      if (note) log(`${id}: ${note}`);
    }

    // Day file first, .txt last: the .txt existing is what marks a segment as done on restart,
    // so a crash in between retries the segment, and the upsert makes the retry harmless.
    const day = dayFileFor(id, readInfo(id));
    upsertDayBlock(day.path, day.header, id, `\n## ${day.when}${day.mins}\n\n${(text || "_(no speech recognised)_") + disclosure}\n\n<!-- ${id} -->\n`);
    mkdirSync(textDir(id), { recursive: true, mode: 0o700 });
    writeFileSync(textPath(id), text + disclosure + "\n", { mode: 0o600 });
    log(`transcribed ${id}: ${text.split(/\s+/).filter(Boolean).length} words`); // counts only: no transcript text in logs
  } finally {
    for (const f of [wav, `${outStem}.txt`]) try { unlinkSync(f); } catch { /* not created */ }
  }
}

async function pump(): Promise<void> {
  if (working) return;
  working = true;
  while (queue.length) {
    const id = queue.shift()!;
    try { await transcribe(id); }
    catch (e) {
      log(`FAILED ${id}: ${(e as Error).message} (audio kept; will retry on restart)`);
      try { // a conversation that could not be transcribed must still show up in the day
        const day = dayFileFor(id, readInfo(id));
        upsertDayBlock(day.path, day.header, id, `\n## ${day.when}${day.mins}\n\n_(not transcribed yet: ${(e as Error).message.slice(0, 120)}. The audio is in the archive.)_\n\n<!-- ${id} -->\n`);
      } catch { /* the log line above still records it */ }
    }
  }
  working = false;
}

// Anything received earlier but never transcribed. Finder drops .DS_Store files in here, so
// only real day folders are entered, and nothing in this scan may stop the receiver starting.
for (const d of readdirSync(join(ARCHIVE, "audio"), { withFileTypes: true })) {
  if (!d.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(d.name)) continue;
  let files: string[] = [];
  try { files = readdirSync(join(ARCHIVE, "audio", d.name)); } catch (e) { log(`skipping audio/${d.name}: ${(e as Error).message}`); continue; }
  for (const f of files) {
    const m = f.match(/^(.+)\.(aac|m4a)$/);
    if (m && ID_RE.test(m[1]) && !existsSync(textPath(m[1])) && !queue.includes(m[1])) queue.push(m[1]);
  }
}
if (queue.length) log(`${queue.length} earlier segment(s) to transcribe`);
void pump();

// ---- http --------------------------------------------------------------------
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let receiving = 0;

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: PORT,
  maxRequestBodySize: MAX_BYTES,
  ...(TLS ? { tls: { key: Bun.file(keyPath), cert: Bun.file(certPath) } } : {}),
  async fetch(req) {
    if (!authorized(req)) return json({ error: "unauthorized" }, 401); // before any body is read
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, queued: queue.length + (working ? 1 : 0) });

    const m = url.pathname.match(/^\/segments\/([^/]+)$/);
    if (req.method === "PUT" && m) {
      const id = m[1];
      if (!ID_RE.test(id)) return json({ error: "bad segment id" }, 400);
      if (receiving >= 2) return json({ error: "busy" }, 503); // the phone sends one at a time; bounds memory
      receiving++;
      try {
        const ext = (req.headers.get("content-type") || "").includes("aac") ? "aac" : "m4a";
        const body = new Uint8Array(await req.arrayBuffer());
        if (body.byteLength < 1000) return json({ error: "empty segment" }, 400);
        const digest = sha256(body);
        const claimed = (req.headers.get("x-hotmic-sha256") || "").toLowerCase();
        if (claimed && claimed !== digest) return json({ error: "checksum mismatch" }, 400);

        const newDay = !existsSync(audioDir(id));
        mkdirSync(audioDir(id), { recursive: true, mode: 0o700 });
        const have = existingAudio(id);
        if (have) {
          // Same bytes: a retry after a lost reply. Different bytes: never replace a recording.
          if (sha256(readFileSync(have)) === digest) return json({ id, bytes: body.byteLength, sha256: digest, duplicate: true });
          log(`REFUSED ${id}: a different recording with this id is already archived`);
          return json({ error: "a different recording with this id already exists" }, 409);
        }
        const final = audioPath(id, ext), tmp = `${final}.part`;
        writeFileSync(tmp, body, { mode: 0o600 });
        durable(tmp);                // data on stable storage before it takes its final name
        renameSync(tmp, final);      // the file appears whole or not at all
        durable(audioDir(id));
        if (newDay) durable(join(ARCHIVE, "audio")); // the new day folder's own entry
        const header = req.headers.get("x-hotmic-info");
        if (header) {
          try { // stored only if it is the small object we expect
            const j = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
            if (j && typeof j === "object" && !Array.isArray(j)) {
              writeFileSync(infoPath(id), JSON.stringify({
                startedAt: typeof j.startedAt === "string" ? j.startedAt.slice(0, 40) : undefined,
                durationSec: typeof j.durationSec === "number" ? j.durationSec : undefined,
                device: typeof j.device === "string" ? j.device.slice(0, 80) : undefined,
                part: typeof j.part === "number" ? j.part : undefined,
              }), { mode: 0o600 });
            }
          } catch { /* metadata is optional */ }
        }
        if (!queue.includes(id)) queue.push(id);
        void pump();
        // The phone deletes its copy only when this digest matches the file it sent.
        return json({ id, bytes: body.byteLength, sha256: digest, duplicate: false });
      } finally { receiving--; }
    }
    return json({ error: "not found" }, 404);
  },
});

const lan = Object.values(networkInterfaces()).flat().filter((n) => n && n.family === "IPv4" && !n.internal).map((n) => n!.address);
const scheme = TLS ? "https" : "http";
log(`archive: ${ARCHIVE}`);
log(`listening on port ${server.port}. In the iPhone app, set the Mac address to: ${lan.map((a) => `${scheme}://${a}:${server.port}`).join("  or  ") || "(no network found)"}`);
log(`the token to paste into the app is in: ${tokenPath}`);
if (TLS) log(`certificate fingerprint (the app shows the one it remembered; they should match): ${fingerprint.slice(0, 32)}…`);
else log("WARNING: HTTPS is off, so the token and the audio cross the network unencrypted.");
process.on("SIGINT", () => { server.stop(true); process.exit(0); });
