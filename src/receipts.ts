// Receipt lane: does what was just said contradict a dated claim in the brain?
//
// Two gates, both must pass, because one wrong receipt is worse than none:
//   1. retrieval: the statement must be semantically close to a stored claim
//   2. judgment: a local LLM must say the two cannot both be true, confidently
//
// Claims held by the speaker (who = brain, or the configured owner) produce a
// red RECEIPT. Claims held by someone else produce a red receipt attributed to
// them. World facts produce an amber CORRECTION.

import type { Take } from "./pages";

export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface Verdict {
  relation: "contradicts" | "agrees" | "unrelated";
  confidence: number;
  reason: string;
}

export interface Judge {
  judge(spoken: string, take: Take): Promise<Verdict>;
}

export interface Receipt {
  kind: "receipt" | "correction";
  take: Take;
  holder: "you" | "world" | string; // display name of whoever holds the claim
  similarity: number;
  verdict: Verdict;
}

export interface ReceiptOptions {
  owner?: string; // e.g. "people/chris-lee"; their takes count as "you"
  minSimilarity: number;
  minConfidence: number;
  maxJudged: number;
}

export const DEFAULT_RECEIPT_OPTIONS: ReceiptOptions = {
  minSimilarity: 0.55,
  minConfidence: 0.75,
  maxJudged: 2,
};

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const STOP = new Set(
  "a an and are as at be but by for from has have i in is it its of on or that the this to was were will with we you they he she not no so if than then there their our my your about into over more most very just also can could would should".split(" "),
);

function contentTokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !STOP.has(t)),
  );
}

/** Keyword fallback for when no embedder is available. Returns 0..1. */
export function lexicalSimilarity(a: string, b: string): number {
  const A = contentTokens(a), B = contentTokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / Math.min(A.size, B.size);
}

/** Statements too short or too vague to be a claim are never judged. */
export function isClaimLike(spoken: string): boolean {
  const toks = spoken.trim().split(/\s+/);
  if (toks.length < 4) return false;
  if (/\?\s*$/.test(spoken.trim()) && !/\b(right|correct|isn'?t it|wasn'?t it|didn'?t (it|they))\s*\?\s*$/i.test(spoken.trim())) {
    return false; // a genuine question asserts nothing; a tag question does
  }
  return true;
}

export class ReceiptLane {
  private vectors: number[][] | null = null;
  private takes: Take[];

  constructor(
    takes: Take[],
    private embedder: Embedder | null,
    private judge: Judge | null,
    private opts: ReceiptOptions = DEFAULT_RECEIPT_OPTIONS,
  ) {
    this.takes = takes.filter((t) => !t.superseded && t.claim.length > 8);
  }

  get takeCount(): number {
    return this.takes.length;
  }

  get mode(): "semantic" | "keyword" | "off" {
    if (!this.judge || !this.takes.length) return "off";
    return this.vectors ? "semantic" : "keyword";
  }

  /** Embed every stored claim once, at startup. */
  async warm(): Promise<void> {
    if (!this.embedder || !this.takes.length) return;
    try {
      this.vectors = await this.embedder.embed(this.takes.map((t) => t.claim));
    } catch {
      this.vectors = null; // fall back to keyword retrieval
    }
  }

  async candidates(spoken: string): Promise<{ take: Take; similarity: number }[]> {
    let scored: { take: Take; similarity: number }[];
    if (this.vectors && this.embedder) {
      try {
        const [q] = await this.embedder.embed([spoken]);
        scored = this.takes.map((take, i) => ({ take, similarity: cosine(q, this.vectors![i]) }));
      } catch {
        scored = this.takes.map((take) => ({ take, similarity: lexicalSimilarity(spoken, take.claim) }));
      }
    } else {
      scored = this.takes.map((take) => ({ take, similarity: lexicalSimilarity(spoken, take.claim) }));
    }
    return scored
      .filter((s) => s.similarity >= this.opts.minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.opts.maxJudged);
  }

  async check(spoken: string): Promise<Receipt | null> {
    if (!this.judge || !isClaimLike(spoken)) return null;
    for (const c of await this.candidates(spoken)) {
      let verdict: Verdict;
      try {
        verdict = await this.judge.judge(spoken, c.take);
      } catch {
        continue;
      }
      if (verdict.relation !== "contradicts" || verdict.confidence < this.opts.minConfidence) continue;
      const who = c.take.who;
      const isWorld = who === "world" || c.take.kind === "fact";
      // GBrain's default holder for the owner's own takes is "self"
      const isYou = who === "brain" || who === "self" || (!!this.opts.owner && who === this.opts.owner);
      return {
        kind: isWorld ? "correction" : "receipt",
        take: c.take,
        holder: isWorld ? "world" : isYou ? "you" : who,
        similarity: c.similarity,
        verdict,
      };
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local Ollama implementations. Nothing leaves the machine.

export class OllamaEmbedder implements Embedder {
  constructor(private base: string, private model: string) {}
  async embed(texts: string[]): Promise<number[][]> {
    const r = await fetch(`${this.base}/api/embed`, {
      method: "POST",
      body: JSON.stringify({ model: this.model, input: texts, keep_alive: "60m" }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`embed ${r.status}`);
    const j = (await r.json()) as { embeddings: number[][] };
    return j.embeddings;
  }
}

const JUDGE_SYSTEM =
  'You compare a SPOKEN statement with a STORED claim. Reply with JSON only: ' +
  '{"relation":"contradicts"|"agrees"|"unrelated","confidence":0..1,"reason":"under 14 words"}. ' +
  'Use "contradicts" ONLY if both cannot be true at once (opposite claims, or different dates, numbers or names for the same fact). ' +
  'A different topic, a loosely related remark, or a more specific version of the same claim is "unrelated" or "agrees". ' +
  "When unsure, answer unrelated.";

export function parseVerdict(raw: string): Verdict {
  const m = raw.match(/\{[\s\S]*\}/);
  const j = JSON.parse(m ? m[0] : raw);
  const relation = ["contradicts", "agrees", "unrelated"].includes(j.relation) ? j.relation : "unrelated";
  const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
  return { relation, confidence, reason: String(j.reason || "").slice(0, 140) };
}

export class OllamaJudge implements Judge {
  constructor(private base: string, private model: string) {}
  async judge(spoken: string, take: Take): Promise<Verdict> {
    const stored = `STORED${take.since ? ` (${take.since})` : ""}: ${take.claim}`;
    const r = await fetch(`${this.base}/api/chat`, {
      method: "POST",
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        keep_alive: "60m",
        options: { temperature: 0, num_predict: 120 },
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: `SPOKEN: ${spoken}\n${stored}` },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`judge ${r.status}`);
    const j = (await r.json()) as { message: { content: string } };
    return parseVerdict(j.message.content);
  }
  /** Load the model into memory so the first real utterance is not slow. */
  async warm(): Promise<void> {
    await this.judge("The sky is green today.", {
      slug: "warm", row: 0, claim: "The sky is blue.", kind: "fact", who: "world", superseded: false,
    }).catch(() => {});
  }
}
