// The pipeline: one utterance in, at most one card and one receipt out.

import { EntityMatcher, type EntityHit } from "./match";
import { ReceiptLane, type Receipt } from "./receipts";
import type { Library } from "./library";
import type { Page } from "./pages";

export type HudEvent =
  | { type: "heard"; id: number; text: string; source: "voice" | "typed"; sttMs?: number }
  | {
      type: "card"; id: number; slug: string; title: string; pageType: string; lede: string;
      origin: "brain" | "pack"; matched: string; heard: string; exact: boolean; ms: number;
      lastSeen?: { agoSec: number; text: string }; takes: { claim: string; since?: string; who: string }[];
    }
  | {
      type: "receipt"; id: number; kind: "receipt" | "correction"; holder: string; claim: string;
      since?: string; source?: string; slug: string; row: number; spoken: string; reason: string;
      confidence: number; similarity: number; ms: number;
    }
  | { type: "quiet"; id: number; ms: number; alreadyShown?: string[] }
  | { type: "reset" };

export interface EngineOptions {
  minCardScore: number;
  cooldownSec: number; // a page is not shown twice within this window
}

export const DEFAULT_ENGINE_OPTIONS: EngineOptions = { minCardScore: 0.6, cooldownSec: 20 * 60 };

interface Sighting {
  at: number;
  text: string;
}

export class Engine {
  private matcher: EntityMatcher;
  private shownAt = new Map<string, number>();
  private sightings = new Map<string, Sighting>(); // in memory only; gone when the process exits
  private receiptsShown = new Set<string>();
  private seq = 0;
  private listeners = new Set<(e: HudEvent) => void>();

  constructor(
    private library: Library,
    private receipts: ReceiptLane,
    private opts: EngineOptions = DEFAULT_ENGINE_OPTIONS,
    private now: () => number = () => Date.now(),
  ) {
    this.matcher = new EntityMatcher(library.pages);
  }

  vocabulary(): string[] {
    return this.matcher.vocabulary();
  }

  subscribe(fn: (e: HudEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: HudEvent): void {
    for (const fn of this.listeners) fn(e);
  }

  reset(): void {
    this.shownAt.clear();
    this.sightings.clear();
    this.receiptsShown.clear();
    this.emit({ type: "reset" });
  }

  private pickCard(hits: EntityHit[], t: number, suppressed: string[]): EntityHit | null {
    for (const h of hits) {
      if (h.score < this.opts.minCardScore) break;
      const last = this.shownAt.get(h.page.slug);
      if (last !== undefined && (t - last) / 1000 < this.opts.cooldownSec) {
        suppressed.push(h.page.title); // recognised, but shown recently
        continue;
      }
      return h;
    }
    return null;
  }

  private cardTakes(page: Page) {
    return page.takes
      .filter((t) => !t.superseded)
      .slice(-2)
      .map((t) => ({ claim: t.claim, since: t.since, who: t.who }));
  }

  /** Returns the events produced, in order. Also pushes each to subscribers as it happens. */
  async handle(text: string, source: "voice" | "typed", sttMs?: number): Promise<HudEvent[]> {
    const started = this.now();
    const id = ++this.seq;
    const out: HudEvent[] = [];
    const push = (e: HudEvent) => {
      out.push(e);
      this.emit(e);
    };
    const spoken = text.trim();
    if (!spoken) return out;
    push({ type: "heard", id, text: spoken, source, sttMs });

    // Lane 1: the entity card. No model call, so it lands first.
    const hits = this.matcher.match(spoken);
    const suppressed: string[] = [];
    const hit = this.pickCard(hits, started, suppressed);
    if (hit) {
      const prior = this.sightings.get(hit.page.slug);
      this.shownAt.set(hit.page.slug, started);
      push({
        type: "card", id, slug: hit.page.slug, title: hit.page.title, pageType: hit.page.type,
        lede: hit.page.lede, origin: hit.page.origin, matched: hit.matchedName, heard: hit.heard,
        exact: hit.exact, ms: this.now() - started + (sttMs || 0),
        lastSeen: prior ? { agoSec: Math.round((started - prior.at) / 1000), text: prior.text } : undefined,
        takes: this.cardTakes(hit.page),
      });
    }
    // remember every confident mention, shown or not, for the next "last came up"
    for (const h of hits) if (h.score >= this.opts.minCardScore) this.sightings.set(h.page.slug, { at: started, text: spoken });

    // Lane 2: the receipt. Slower, and gated twice.
    let receipt: Receipt | null = null;
    try {
      receipt = await this.receipts.check(spoken);
    } catch {
      receipt = null;
    }
    if (receipt) {
      const key = `${receipt.take.slug}#${receipt.take.row}`;
      if (!this.receiptsShown.has(key)) {
        this.receiptsShown.add(key);
        // "people/garry-tan" reads better as the page's title
        const holderPage = this.library.pages.find((p) => p.slug === receipt!.holder);
        push({
          type: "receipt", id, kind: receipt.kind, holder: holderPage?.title || receipt.holder, claim: receipt.take.claim,
          since: receipt.take.since, source: receipt.take.source, slug: receipt.take.slug, row: receipt.take.row,
          spoken, reason: receipt.verdict.reason, confidence: receipt.verdict.confidence,
          similarity: receipt.similarity, ms: this.now() - started + (sttMs || 0),
        });
      }
    }
    if (out.length === 1) {
      push({ type: "quiet", id, ms: this.now() - started + (sttMs || 0), alreadyShown: suppressed.length ? suppressed : undefined });
    }
    return out;
  }
}
