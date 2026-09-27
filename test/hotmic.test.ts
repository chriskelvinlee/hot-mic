import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parsePage } from "../src/pages";
import { EntityMatcher, editDistance, likelyPeople, squash } from "../src/match";
import { ReceiptLane, isClaimLike, lexicalSimilarity, parseVerdict, type Judge, type Verdict } from "../src/receipts";
import { loadLibrary } from "../src/library";
import { Engine } from "../src/engine";
import { cleanTranscript } from "../src/stt";

const PACK = resolve(import.meta.dir, "..", "packs", "demo");
const lib = loadLibrary(null, [PACK]);
const matcher = new EntityMatcher(lib.pages);
const top = (s: string) => matcher.match(s)[0];
const shown = (s: string) => {
  const h = top(s);
  return h && h.score >= 0.6 ? h.page.slug : null;
};

describe("page parsing", () => {
  test("reads frontmatter, title, lede and the takes fence", () => {
    const p = parsePage("projects/qm", `---
type: project
aliases: ["Quartermaster", 'YC QM']
---

# QM

A harness for [[people/garry-tan|Garry]]'s *team*.

<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Open-sourced 2026-07-31 | fact | world | 0.95 | 2026-07-31 | repo |
| 2 | ~~Will hit 50k stars~~ | bet | brain | 0.6 | 2026-08 | superseded by #3 |
<!--- gbrain:takes:end -->
`, "pack");
    expect(p.type).toBe("project");
    expect(p.aliases).toEqual(["Quartermaster", "YC QM"]);
    expect(p.lede).toBe("A harness for Garry's team.");
    expect(p.takes).toHaveLength(2);
    expect(p.takes[0]).toMatchObject({ row: 1, kind: "fact", who: "world", weight: 0.95, superseded: false });
    expect(p.takes[1]).toMatchObject({ claim: "Will hit 50k stars", superseded: true });
  });

  test("a page with no fence has no takes", () => {
    expect(parsePage("x/y", "# Y\n\nBody.", "pack").takes).toEqual([]);
  });
});

describe("library", () => {
  test("loads the demo pack", () => {
    expect(lib.pages.length).toBeGreaterThanOrEqual(15);
    expect(lib.takes.length).toBeGreaterThanOrEqual(10);
  });
  test("never reads a sources/ folder or guide pages", () => {
    const all = loadLibrary(resolve(import.meta.dir, "fixtures", "brain"), []);
    expect(all.pages.map((p) => p.slug)).toEqual(["people/real-person"]);
  });
});

describe("entity matching", () => {
  test("exact names", () => {
    expect(shown("so I was talking to Garry Tan about this")).toBe("people/garry-tan");
    expect(shown("we deployed QM on Fly last night")).toBe("projects/qm");
  });
  test("speech-to-text manglings", () => {
    expect(shown("have you tried G brain for memory")).toBe("projects/gbrain");
    expect(shown("Igor Babushkin founded it")).toBe("people/igor-babuschkin");
    expect(shown("we train on river dot ai")).toBe("companies/river-ai");
    expect(shown("thin harness fat skills is the idea")).toBe("concepts/thin-harness-fat-skills");
  });
  test("ordinary words that happen to be names do not fire", () => {
    expect(shown("we walked down by the river yesterday")).toBeNull();
    expect(shown("that was a memorable dinner")).toBeNull();
    expect(shown("my memory of the model is hazy")).toBeNull();
  });
  test("a different person with a similar name does not fire", () => {
    expect(shown("Larry Tan from accounting called")).toBeNull();
  });
  test("small talk shows nothing", () => {
    expect(shown("hi, nice to meet you, how is your day going")).toBeNull();
  });
  test("hinting: a mangled first name next to an exact surname suggests the person, but never shows a card", () => {
    expect(likelyPeople("I was chatting with Sachi Patel from Superset", lib.pages).map((p) => p.slug)).toEqual(["people/satya-patel"]);
    expect(shown("I was chatting with Sachi Patel")).toBeNull();
    expect(likelyPeople("Raj Patel called, and so did Dev Patel", lib.pages)).toEqual([]);
  });
  test("helpers", () => {
    expect(squash("River.AI")).toBe("riverai");
    expect(editDistance("babushkin", "babuschkin", 2)).toBe(1);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBeGreaterThan(2);
  });
});

describe("receipt gates", () => {
  const take = lib.takes.find((t) => t.claim.startsWith("QM was open-sourced"))!;
  const says = (v: Partial<Verdict>): Judge => ({
    judge: async () => ({ relation: "contradicts", confidence: 0.9, reason: "different dates", ...v }),
  });
  const lane = (j: Judge | null) => new ReceiptLane(lib.takes, null, j, { minSimilarity: 0.5, minConfidence: 0.75, maxJudged: 2 });

  test("a contradicted world fact is a correction", async () => {
    const r = await lane(says({})).check("QM was open-sourced in June under the MIT licence, right?");
    expect(r?.kind).toBe("correction");
    expect(r?.take.slug).toBe(take.slug);
  });
  test("a contradicted own take is a receipt held by you", async () => {
    const r = await lane(says({})).check("Embeddings should run in the cloud so query text leaves the Mac");
    expect(r).toMatchObject({ kind: "receipt", holder: "you" });
  });
  test("a take held by self (GBrain's owner holder) is also yours", async () => {
    const mine = { slug: "projects/qm", row: 1, claim: "QM is hosted on Fly.io in the San Jose region", kind: "take", who: "self", superseded: false };
    const r = await new ReceiptLane([mine], null, says({}), { minSimilarity: 0.5, minConfidence: 0.75, maxJudged: 2 })
      .check("QM is hosted on Vercel in the Virginia region");
    expect(r).toMatchObject({ kind: "receipt", holder: "you" });
  });
  test("low judge confidence shows nothing", async () => {
    expect(await lane(says({ confidence: 0.6 })).check("QM was open-sourced in June under the MIT licence")).toBeNull();
  });
  test("agreement shows nothing", async () => {
    expect(await lane(says({ relation: "agrees" })).check("QM was open-sourced on 2026-07-31 under the MIT licence")).toBeNull();
  });
  test("unrelated speech never reaches the judge", async () => {
    let called = 0;
    const j: Judge = { judge: async () => (called++, { relation: "contradicts", confidence: 1, reason: "" }) };
    expect(await lane(j).check("I had a great sandwich for lunch today")).toBeNull();
    expect(called).toBe(0);
  });
  test("questions and fragments are not claims", () => {
    expect(isClaimLike("when was QM open sourced?")).toBe(false);
    expect(isClaimLike("QM was open-sourced in June, right?")).toBe(true);
    expect(isClaimLike("yeah totally")).toBe(false);
  });
  test("a judge failure is silent", async () => {
    const j: Judge = { judge: async () => { throw new Error("ollama down"); } };
    expect(await lane(j).check("QM was open-sourced in June under the MIT licence")).toBeNull();
  });
  test("verdict parsing tolerates noise and clamps", () => {
    expect(parseVerdict('sure: {"relation":"contradicts","confidence":1.7,"reason":"x"}')).toMatchObject({ relation: "contradicts", confidence: 1 });
    expect(parseVerdict('{"relation":"maybe","confidence":"high"}')).toMatchObject({ relation: "unrelated", confidence: 0 });
  });
  test("lexical similarity", () => {
    expect(lexicalSimilarity("QM was open-sourced in June", take.claim)).toBeGreaterThan(0.5);
    expect(lexicalSimilarity("lunch was great", take.claim)).toBe(0);
  });
});

describe("engine", () => {
  const fixedJudge: Judge = { judge: async () => ({ relation: "contradicts", confidence: 0.9, reason: "different dates" }) };
  const make = (clock: { t: number }) =>
    new Engine(lib, new ReceiptLane(lib.takes, null, fixedJudge, { minSimilarity: 0.5, minConfidence: 0.75, maxJudged: 2 }),
      { minCardScore: 0.6, cooldownSec: 600 }, () => clock.t);

  test("one card, then silence during the cooldown, then a 'last came up' card", async () => {
    const clock = { t: 1_000_000 };
    const e = make(clock);
    const first = await e.handle("I spoke with Garry Tan this morning", "typed");
    expect(first.map((x) => x.type)).toEqual(["heard", "card"]);
    clock.t += 60_000;
    expect((await e.handle("Garry Tan again", "typed")).map((x) => x.type)).toEqual(["heard", "quiet"]);
    clock.t += 700_000;
    const third = await e.handle("and Garry Tan once more", "typed");
    const card = third.find((x) => x.type === "card") as any;
    expect(card.lastSeen.text).toBe("Garry Tan again");
    expect(card.lastSeen.agoSec).toBe(700);
  });

  test("a receipt is shown once per claim, and reset clears that", async () => {
    const e = make({ t: 5 });
    const say = "QM was open-sourced in June under the MIT licence";
    expect((await e.handle(say, "typed")).some((x) => x.type === "receipt")).toBe(true);
    expect((await e.handle(say, "typed")).some((x) => x.type === "receipt")).toBe(false);
    e.reset();
    expect((await e.handle(say, "typed")).some((x) => x.type === "receipt")).toBe(true);
  });

  test("holder slugs are shown as names", async () => {
    const e = make({ t: 5 });
    const ev = await e.handle("You do not need to own your own intelligence, your own agent, models or memory", "typed");
    const r = ev.find((x) => x.type === "receipt") as any;
    expect(r.holder).toBe("Garry Tan");
  });
});

describe("transcript cleanup", () => {
  test("drops whisper's non-speech markers", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] ")).toBe("");
    expect(cleanTranscript("(silence)")).toBe("");
    expect(cleanTranscript("  hello   there [MUSIC] friend ")).toBe("hello there friend");
  });
});
