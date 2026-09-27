// Builds the Chief of Staff demo page: scores the skill run against the
// independent grader, inlines all data, and writes two files:
//   cos/dist/chief-of-staff.html  fragment for the claude.ai Artifact viewer
//   cos/dist/index.html           full document for offline use (file:// or any static server)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "..");
const COS = join(ROOT, "cos");
const PACK = join(ROOT, "packs", "cos-demo");
const SKILL = join(ROOT, "skills", "chief-of-staff", "SKILL.md");
const MARKER = '<script id="cos-data">window.COS_DATA = null;</script>';

type Route = "you" | "precedent" | "agent" | "drop";
const ROUTES: Route[] = ["you", "precedent", "agent", "drop"];

const readJson = (name: string) => JSON.parse(readFileSync(join(COS, "demo", name), "utf8"));
const day = readJson("day.json");
const triage = readJson("triage.json");
const gold = readJson("gold.json");
const baseline = readJson("baseline.json");

// ---- precedents: GBrain takes tables from the pack ----
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : f.endsWith(".md") ? [p] : [];
  });
}
function frontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const precedents = walk(PACK).sort().map((path) => {
  const text = readFileSync(path, "utf8");
  const fm = frontmatter(text);
  const block = text.match(/gbrain:takes:begin -->([\s\S]*?)<!--- gbrain:takes:end/);
  const rows = (block ? block[1].split("\n") : [])
    .filter((l) => /^\|\s*\d+\s*\|/.test(l))
    .map((l) => l.split("|").slice(1, -1).map((c) => c.trim()))
    .map(([, claim, kind, who, weight, since, source]) => ({
      claim, kind, who, weight: Number(weight), since, source,
      real: /real/i.test(source ?? ""),
    }));
  const title = fm.title || (text.match(/^# (.+)$/m)?.[1] ?? relative(PACK, path));
  return { page: relative(ROOT, path), title, lane: fm.lane ?? "", rows };
});

// ---- skill ----
const skillMd = readFileSync(SKILL, "utf8");
const sfm = skillMd.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
const skill = {
  name: sfm.match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? "chief-of-staff",
  version: sfm.match(/^version:\s*(.+)$/m)?.[1]?.trim() ?? "0.1.0",
  description: (sfm.match(/^description:\s*\|?\s*\n?([\s\S]*?)\n\w+:/m)?.[1] ?? "")
    .split("\n").map((s) => s.trim()).filter(Boolean).join(" "),
  markdown: skillMd,
};

// ---- eval: skill output vs the blind grader ----
const items: any[] = triage.items;
const goldItems: any[] = gold.items;
const overlap = (a: string[], b: string[]) => a.filter((u) => b.includes(u)).length;

const confusion: Record<string, Record<string, number>> = {};
for (const g of ROUTES) confusion[g] = { you: 0, precedent: 0, agent: 0, drop: 0, missing: 0 };

const perItem = goldItems.map((g) => {
  let best: any = null, bestScore = 0;
  for (const t of items) {
    const s = overlap(g.utterances, t.utterances);
    // ties go to the item whose route agrees with the grader
    if (s > bestScore || (s === bestScore && s > 0 && t.route === g.route && best?.route !== g.route)) {
      best = t; bestScore = s;
    }
  }
  const cosRoute = best ? best.route : null;
  confusion[g.route][cosRoute ?? "missing"]++;
  return {
    gold_id: g.id, triage_id: best?.id ?? null, gold_route: g.route, cos_route: cosRoute,
    agree: cosRoute === g.route, summary: g.summary, severity: g.severity_if_missed,
  };
});

const agree = perItem.filter((p) => p.agree).length;
const goldYou = goldItems.filter((g) => g.route === "you");
const cosYou = items.filter((t) => t.route === "you");
const caught = perItem.filter((p) => p.gold_route === "you" && p.cos_route === "you").length;
const cosYouHit = cosYou.filter((t) => goldYou.some((g) => overlap(g.utterances, t.utterances) > 0)).length;
const pct = (n: number, d: number) => (d ? Math.round((100 * n) / d) : 100);

const missed = perItem
  .filter((p) => p.gold_route !== "drop" && (p.cos_route === "drop" || p.cos_route === null))
  .map((p) => ({ gold_id: p.gold_id, summary: p.summary, severity: p.severity, cos_route: p.cos_route ?? "missing" }));

const interruptions = cosYou
  .filter((t) => !goldYou.some((g) => overlap(g.utterances, t.utterances) > 0))
  .map((t) => {
    const g = goldItems
      .map((g) => [g, overlap(g.utterances, t.utterances)] as const)
      .sort((a, b) => b[1] - a[1])[0];
    return { triage_id: t.id, title: t.title, gold_route: g && g[1] > 0 ? g[0].route : "none" };
  });

const goldNoise = goldItems.filter((g) => g.route === "drop");
const cosAmplified = perItem.filter((p) => p.gold_route === "drop" && p.cos_route && p.cos_route !== "drop").length;
const baselineAmplified = goldNoise.filter((g) =>
  baseline.action_items.some((b: any) => overlap(g.utterances, b.utterances ?? []) > 0)).length;

const count = (r: Route) => items.filter((t) => t.route === r).length;
const evalOut = {
  grader: gold.labeler,
  gold_items: goldItems.length,
  route_agreement: { agree, total: goldItems.length, pct: pct(agree, goldItems.length) },
  confusion,
  needs_you: {
    recall_pct: pct(caught, goldYou.length), precision_pct: pct(cosYouHit, cosYou.length),
    caught, gold_total: goldYou.length, cos_total: cosYou.length,
  },
  missed,
  interruptions,
  noise: { gold_noise_total: goldNoise.length, cos_amplified: cosAmplified, baseline_amplified: baselineAmplified },
  compression: {
    utterances: day.utterances.length, contexts: day.contexts.length,
    baseline_action_items: baseline.action_items.length,
    you: count("you"), precedent: count("precedent"), agent: count("agent"), drop: count("drop"),
  },
  per_item: perItem,
};

// ---- sanity checks: every referenced utterance must exist ----
const ids = new Set(day.utterances.map((u: any) => u.id));
const dangling = [
  ...items.flatMap((t) => t.utterances.map((u: string) => [t.id, u])),
  ...goldItems.flatMap((g) => g.utterances.map((u: string) => [g.id, u])),
  ...baseline.action_items.flatMap((b: any) => (b.utterances ?? []).map((u: string) => [b.id, u])),
].filter(([, u]) => !ids.has(u));
if (dangling.length) console.warn("warning: unknown utterance ids", dangling);

// ---- inline and write ----
const data = { day, triage, gold, baseline, precedents, skill, eval: evalOut, built_at: new Date().toISOString() };
const json = JSON.stringify(data)
  .replace(/</g, "\\u003c")
  .replace(/\u2028/g, "\\u2028")
  .replace(/\u2029/g, "\\u2029");
const app = readFileSync(join(COS, "app.html"), "utf8");
if (!app.includes(MARKER)) throw new Error("cos/app.html is missing the data marker line");
const fragment = app.replace(MARKER, () => `<script id="cos-data">window.COS_DATA = ${json};</script>`);

mkdirSync(join(COS, "dist"), { recursive: true });
writeFileSync(join(COS, "dist", "chief-of-staff.html"), fragment);
writeFileSync(
  join(COS, "dist", "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<style>body{margin:0}img{max-width:100%}[hidden]{display:none!important}</style>
</head>
<body>
${fragment}
</body>
</html>
`,
);

console.log(JSON.stringify({
  utterances: day.utterances.length, contexts: day.contexts.length,
  routes: evalOut.compression, baseline: baseline.action_items.length,
  agreement: evalOut.route_agreement, needs_you: evalOut.needs_you,
  missed: missed.map((m) => m.gold_id), interruptions: interruptions.map((i) => i.triage_id),
  noise: evalOut.noise, precedent_pages: precedents.length,
  bytes: fragment.length, existsIndex: existsSync(join(COS, "dist", "index.html")),
}, null, 2));
