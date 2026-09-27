// Entity lane: find the one page the speaker just named. Zero-LLM, so it is
// fast enough to feel ambient. Speech-to-text mangles proper nouns ("G brain",
// "acme dot ai", "Babushkin"), so matching runs on a squashed form of the
// transcript with a bounded edit-distance tolerance, not on raw tokens.

import type { Page } from "./pages";

export interface EntityHit {
  page: Page;
  matchedName: string; // the title or alias that matched
  heard: string; // what the transcript actually said
  score: number; // 0..1
  exact: boolean;
}

// Names that are also ordinary words would fire constantly in conversation.
const COMMON = new Set([
  "river", "brain", "memory", "agent", "agents", "model", "models", "record", "docket", "thumb",
  "memorable", "page", "take", "takes", "skill", "skills", "factory", "market", "series",
]);

const SPOKEN_ACRONYMS = new Set(["ai", "ok", "us", "uk", "it", "vc", "pr", "hr", "pm", "am", "tv", "id", "ip", "ui", "ux", "ceo", "cto", "api", "llm"]);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\bdot\s+(ai|com|io|sh|dev)\b/g, ".$1")
    .replace(/[^a-z0-9.\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function squash(s: string): string {
  return normalize(s).replace(/[.\s]/g, "");
}

export function tokens(s: string): string[] {
  const n = normalize(s);
  return n ? n.split(" ") : [];
}

// Optimal-string-alignment distance (Levenshtein + adjacent transposition),
// with an early exit once the bound is exceeded.
export function editDistance(a: string, b: string, bound: number): number {
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur: number[] = new Array(b.length + 1).fill(0);
  let prevPrev = prev2;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prevPrev[j - 2] + 1);
      }
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > bound) return bound + 1;
    const tmp = prevPrev;
    prevPrev = prev;
    prev = cur;
    cur = tmp;
  }
  return prev[b.length];
}

interface NameEntry {
  page: Page;
  name: string;
  squashed: string;
  tokenCount: number;
  requiresExact: boolean;
}

export class EntityMatcher {
  private names: NameEntry[] = [];

  constructor(pages: Page[]) {
    for (const page of pages) {
      const seen = new Set<string>();
      for (const name of [page.title, ...page.aliases]) {
        const sq = squash(name);
        if (seen.has(sq)) continue;
        // Two-letter names are allowed only as written acronyms ("QM"), and
        // never the ones that are everyday speech ("AI", "OK").
        const acronym = /^[A-Z0-9]{2,4}$/.test(name.trim()) && !SPOKEN_ACRONYMS.has(sq);
        if (sq.length < 2 || (sq.length < 3 && !acronym)) continue;
        seen.add(sq);
        const tc = tokens(name).length;
        this.names.push({
          page,
          name,
          squashed: sq,
          tokenCount: tc,
          // Short names, ordinary words and domain-style aliases ("memorable.sh")
          // only match exactly. Fuzzy matching them lets plain words slip in.
          requiresExact: sq.length < 6 || name.includes(".") || (tc === 1 && COMMON.has(sq)),
        });
      }
    }
  }

  get size(): number {
    return this.names.length;
  }

  /** Proper nouns to bias the speech recognizer toward, longest first. */
  vocabulary(limit = 60): string[] {
    const uniq = new Map<string, string>();
    for (const n of this.names) if (!uniq.has(n.squashed)) uniq.set(n.squashed, n.name);
    return [...uniq.values()].sort((a, b) => b.length - a.length).slice(0, limit);
  }

  match(transcript: string): EntityHit[] {
    const toks = tokens(transcript);
    if (!toks.length) return [];
    const best = new Map<string, EntityHit>(); // by slug

    for (const entry of this.names) {
      // A spoken name may split or join differently than it is written
      // ("g brain" vs "gbrain"), so try windows of tokenCount-1 .. tokenCount+1.
      const minW = Math.max(1, entry.tokenCount - 1);
      const maxW = Math.min(toks.length, entry.tokenCount + 1);
      for (let w = minW; w <= maxW; w++) {
        for (let i = 0; i + w <= toks.length; i++) {
          const heardToks = toks.slice(i, i + w);
          const heardSq = heardToks.join("").replace(/\./g, "");
          let score = 0;
          let exact = false;
          if (heardSq === entry.squashed) {
            // An ordinary single word ("river") is only a name when it is the
            // whole written form, i.e. the window has the name's token count.
            if (entry.tokenCount === 1 && COMMON.has(entry.squashed) && w !== 1) continue;
            exact = true;
            score = 1;
          } else if (!entry.requiresExact && !COMMON.has(heardSq)) {
            const bound = entry.squashed.length >= 10 ? 2 : 1;
            const d = editDistance(heardSq, entry.squashed, bound);
            if (d <= bound) {
              // first letters must agree: "Garry"/"Larry" is a different person
              if (heardSq[0] !== entry.squashed[0]) continue;
              score = 1 - d / entry.squashed.length;
            }
          }
          if (score <= 0) continue;
          // specificity: longer names are stronger evidence than short ones
          const specificity = Math.min(1, 0.55 + entry.squashed.length / 24);
          let final = score * specificity;
          // A lone ordinary word that happens to be a name is weak evidence.
          if (exact && entry.tokenCount === 1 && COMMON.has(entry.squashed)) final *= 0.6;
          const prior = best.get(entry.page.slug);
          if (!prior || final > prior.score) {
            best.set(entry.page.slug, {
              page: entry.page,
              matchedName: entry.name,
              heard: heardToks.join(" "),
              score: final,
              exact,
            });
          }
        }
      }
    }
    return [...best.values()].sort((a, b) => b.score - a.score);
  }
}

/**
 * Looser than match(): people whose surname was heard exactly next to a first
 * name with the right initial ("Sachi Patel" for Satya Patel). Too weak to show a
 * card on, but right for a transcription hint, where a miss costs nothing.
 */
export function likelyPeople(transcript: string, pages: Page[]): Page[] {
  const toks = tokens(transcript);
  const out: Page[] = [];
  for (const page of pages) {
    if (page.type !== "person") continue;
    const name = tokens(page.title);
    if (name.length < 2) continue;
    const first = name[0], last = name[name.length - 1];
    if (last.length < 4) continue;
    for (let i = 1; i < toks.length; i++) {
      if (toks[i] === last && toks[i - 1][0] === first[0] && Math.abs(toks[i - 1].length - first.length) <= 2) { out.push(page); break; }
    }
  }
  return out;
}
