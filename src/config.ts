// All settings come from the environment, with defaults that work on this Mac.
// An optional ~/.hotmic/config.json supplies the same keys for daily use.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface Config {
  port: number;
  brainDir: string | null;
  packDirs: string[];
  owner?: string;
  whisperBin: string;
  whisperModel: string;
  whisperPort: number;
  whisperThreads: number;
  ollamaUrl: string;
  embedModel: string | null;
  judgeModel: string | null;
  cooldownSec: number;
  minCardScore: number;
  minSimilarity: number;
  minConfidence: number;
}

const PROJECT = resolve(import.meta.dir, "..");

function fileConfig(): Record<string, unknown> {
  const p = join(homedir(), ".hotmic", "config.json");
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function expand(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : resolve(p);
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const f = fileConfig();
  const pick = (envKey: string, fileKey: string, dflt: string): string =>
    env[envKey] ?? (f[fileKey] !== undefined ? String(f[fileKey]) : dflt);
  const off = (v: string) => ["", "off", "none", "0", "false"].includes(v.toLowerCase());

  const brain = pick("HOTMIC_BRAIN_DIR", "brainDir", "~/brain");
  const packs = pick("HOTMIC_PACKS", "packs", join(PROJECT, "packs", "demo"));
  const embed = pick("HOTMIC_EMBED_MODEL", "embedModel", "bge-m3");
  const judge = pick("HOTMIC_JUDGE_MODEL", "judgeModel", "llama3");
  const owner = pick("HOTMIC_OWNER", "owner", "");

  return {
    port: Number(pick("HOTMIC_PORT", "port", "4747")),
    brainDir: off(brain) ? null : expand(brain),
    packDirs: off(packs) ? [] : packs.split(",").map((s) => expand(s.trim())).filter(Boolean),
    owner: owner || undefined,
    whisperBin: pick("HOTMIC_WHISPER_BIN", "whisperBin", "/opt/homebrew/bin/whisper-server"),
    whisperModel: expand(pick("HOTMIC_WHISPER_MODEL", "whisperModel", join(PROJECT, "models", "ggml-small.en.bin"))),
    whisperPort: Number(pick("HOTMIC_WHISPER_PORT", "whisperPort", "4748")),
    whisperThreads: Number(pick("HOTMIC_WHISPER_THREADS", "whisperThreads", "6")),
    ollamaUrl: pick("HOTMIC_OLLAMA_URL", "ollamaUrl", "http://127.0.0.1:11434"),
    embedModel: off(embed) ? null : embed,
    judgeModel: off(judge) ? null : judge,
    cooldownSec: Number(pick("HOTMIC_COOLDOWN_SEC", "cooldownSec", "1200")),
    minCardScore: Number(pick("HOTMIC_MIN_CARD_SCORE", "minCardScore", "0.6")),
    minSimilarity: Number(pick("HOTMIC_MIN_SIMILARITY", "minSimilarity", "0.55")),
    minConfidence: Number(pick("HOTMIC_MIN_CONFIDENCE", "minConfidence", "0.75")),
  };
}
