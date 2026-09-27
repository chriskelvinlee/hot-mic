// `bun run doctor`: is everything Hot Mic needs present on this Mac?

import { existsSync } from "node:fs";
import { loadConfig } from "./config";
import { loadLibrary } from "./library";

const cfg = loadConfig();
let failed = 0;
const line = (ok: boolean | "warn", what: string, fix = "") => {
  const tag = ok === true ? "PASS" : ok === "warn" ? "WARN" : "FAIL";
  if (ok === false) failed++;
  console.log(`  ${tag}  ${what}${ok === true || !fix ? "" : `\n        fix: ${fix}`}`);
};

console.log("Hot Mic doctor\n");
line(existsSync(cfg.whisperBin), `speech server at ${cfg.whisperBin}`, "brew install whisper-cpp");
line(existsSync(cfg.whisperModel), `speech model at ${cfg.whisperModel}`, "put a ggml-*.en.bin model there, or set HOTMIC_WHISPER_MODEL");

let models: string[] = [];
try {
  const r = await fetch(`${cfg.ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(2500) });
  models = ((await r.json()) as { models: { name: string }[] }).models.map((m) => m.name.split(":")[0]);
  line(true, `Ollama reachable at ${cfg.ollamaUrl}`);
} catch {
  line("warn", "Ollama not reachable, so receipts will be off (cards still work)", "brew services start ollama");
}
if (models.length) {
  if (cfg.judgeModel) line(models.includes(cfg.judgeModel) ? true : "warn", `judge model "${cfg.judgeModel}"`, `ollama pull ${cfg.judgeModel}`);
  if (cfg.embedModel) line(models.includes(cfg.embedModel) ? true : "warn", `embedding model "${cfg.embedModel}" (without it receipts use keyword matching)`, `ollama pull ${cfg.embedModel}`);
}

const lib = loadLibrary(cfg.brainDir, cfg.packDirs);
line(lib.pages.length > 0, `${lib.counts.brain} brain pages from ${cfg.brainDir ?? "(off)"}, ${lib.counts.pack} pack pages`, "check HOTMIC_BRAIN_DIR and HOTMIC_PACKS");
line(lib.counts.takes > 0 ? true : "warn", `${lib.counts.takes} dated claims available for receipts`, "add a takes table to a page");
if (lib.counts.brain < 25) {
  console.log(`\n  Note: only ${lib.counts.brain} pages come from your own brain. Until it has more, most cards will come from packs.`);
}
console.log(failed ? `\n${failed} problem(s) to fix.` : "\nReady. Start with: bin/hotmic");
process.exit(failed ? 1 : 0);
