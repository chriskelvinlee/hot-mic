// Hot Mic server. Everything binds to 127.0.0.1; nothing is reachable from the
// network. Audio is transcribed in memory and discarded. Transcripts live only
// in this process and vanish when it exits.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfig } from "./config";
import { loadLibrary } from "./library";
import { Engine, type HudEvent } from "./engine";
import { ReceiptLane, OllamaEmbedder, OllamaJudge } from "./receipts";
import { Stt } from "./stt";

const cfg = loadConfig();
const PUBLIC = resolve(import.meta.dir, "..", "public");
const TOKEN = randomBytes(18).toString("base64url");
const log = (...a: unknown[]) => console.log("[hot-mic]", ...a);

async function ollamaHas(model: string): Promise<boolean> {
  try {
    const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
    const j = (await r.json()) as { models: { name: string }[] };
    return j.models.some((m) => m.name === model || m.name.split(":")[0] === model);
  } catch {
    return false;
  }
}

// ---- build the pipeline ----------------------------------------------------
let library = loadLibrary(cfg.brainDir, cfg.packDirs);
log(`library: ${library.counts.brain} brain pages, ${library.counts.pack} pack pages, ${library.counts.takes} dated claims`);

const embedder = cfg.embedModel && (await ollamaHas(cfg.embedModel)) ? new OllamaEmbedder(cfg.ollamaUrl, cfg.embedModel) : null;
const judge = cfg.judgeModel && (await ollamaHas(cfg.judgeModel)) ? new OllamaJudge(cfg.ollamaUrl, cfg.judgeModel) : null;
if (!judge) log("receipts OFF: no local judge model (is Ollama running? `ollama list`)");
if (judge && !embedder) log("receipts in keyword mode: embedding model not found");

function buildEngine(): { engine: Engine; lane: ReceiptLane } {
  const lane = new ReceiptLane(library.takes, embedder, judge, {
    owner: cfg.owner, minSimilarity: cfg.minSimilarity, minConfidence: cfg.minConfidence, maxJudged: 2,
  });
  const engine = new Engine(library, lane, { minCardScore: cfg.minCardScore, cooldownSec: cfg.cooldownSec });
  return { engine, lane };
}
let { engine, lane } = buildEngine();

const stt = new Stt({ bin: cfg.whisperBin, model: cfg.whisperModel, port: cfg.whisperPort, threads: cfg.whisperThreads });
let sttReady = false;
let sttError = "";

// ---- event fan-out ---------------------------------------------------------
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
function broadcast(e: HudEvent | { type: "status" } & Record<string, unknown>): void {
  const frame = enc.encode(`data: ${JSON.stringify(e)}\n\n`);
  for (const c of clients) {
    try {
      c.enqueue(frame);
    } catch {
      clients.delete(c);
    }
  }
}
let unsubscribe = engine.subscribe(broadcast);

function status() {
  return {
    type: "status" as const,
    pages: library.pages.length, brainPages: library.counts.brain, packPages: library.counts.pack,
    claims: lane.takeCount, receipts: lane.mode, stt: sttReady ? "ready" : sttError ? "error" : "starting",
    sttError, judgeModel: judge ? cfg.judgeModel : null, cooldownSec: cfg.cooldownSec,
  };
}

// warm everything in the background so the page can load immediately
(async () => {
  try {
    await stt.start();
    stt.setVocabulary(engine.vocabulary());
    sttReady = true;
    log("speech-to-text ready");
  } catch (e) {
    sttError = (e as Error).message;
    log("speech-to-text unavailable:", sttError, "- typed input still works");
  }
  broadcast(status());
})();
(async () => {
  await lane.warm();
  if (judge) await judge.warm();
  log(`receipts: ${lane.mode}`);
  broadcast(status());
})();

// ---- http ------------------------------------------------------------------
function authorized(req: Request): boolean {
  const url = new URL(req.url);
  const host = req.headers.get("host") || "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false; // blocks DNS-rebinding
  return (req.headers.get("x-hotmic-token") || url.searchParams.get("token")) === TOKEN;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

let busy: Promise<unknown> = Promise.resolve();
/** Utterances are handled one at a time, in order. */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const next = busy.then(fn, fn);
  busy = next.catch(() => {});
  return next;
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: cfg.port,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = readFileSync(join(PUBLIC, "index.html"), "utf8").replace("__HOTMIC_TOKEN__", TOKEN);
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }

    if (!url.pathname.startsWith("/api/")) return new Response("not found", { status: 404 });
    if (!authorized(req)) return json({ error: "forbidden" }, 403);

    if (url.pathname === "/api/events") {
      let ctrl: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          ctrl = c;
          clients.add(c);
          c.enqueue(enc.encode(`data: ${JSON.stringify(status())}\n\n`));
        },
        cancel() {
          clients.delete(ctrl);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
      });
    }

    if (url.pathname === "/api/status") return json(status());

    if (req.method === "POST" && url.pathname === "/api/utterance") {
      if (!sttReady) return json({ error: sttError || "speech-to-text is still starting" }, 503);
      const wav = await req.arrayBuffer();
      if (wav.byteLength < 8000) return json({ events: [], note: "too short" });
      if (wav.byteLength > 12_000_000) return json({ error: "clip too long (keep it under a minute)" }, 413);
      return serial(async () => {
        const t0 = Date.now();
        const text = await stt.transcribe(wav);
        const sttMs = Date.now() - t0;
        if (!text) {
          broadcast({ type: "quiet", id: 0, ms: sttMs });
          return json({ events: [], note: "no speech" });
        }
        return json({ events: await engine.handle(text, "voice", sttMs) });
      }).catch((e) => json({ error: (e as Error).message }, 500));
    }

    if (req.method === "POST" && url.pathname === "/api/say") {
      const { text } = (await req.json().catch(() => ({}))) as { text?: string };
      if (!text || !text.trim()) return json({ events: [] });
      return serial(async () => json({ events: await engine.handle(text.slice(0, 600), "typed") }));
    }

    if (req.method === "POST" && url.pathname === "/api/reset") {
      engine.reset();
      return json({ ok: true });
    }

    if (req.method === "POST" && url.pathname === "/api/reload") {
      library = loadLibrary(cfg.brainDir, cfg.packDirs);
      unsubscribe();
      ({ engine, lane } = buildEngine());
      unsubscribe = engine.subscribe(broadcast);
      stt.setVocabulary(engine.vocabulary());
      await lane.warm();
      broadcast(status());
      return json(status());
    }

    return json({ error: "not found" }, 404);
  },
});

setInterval(() => broadcast(status()), 25_000); // also keeps the event stream open

function shutdown() {
  stt.stop();
  server.stop(true);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

log(`open http://127.0.0.1:${server.port}  (hold Space to talk)`);
