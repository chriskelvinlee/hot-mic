import { describe, expect, test } from "bun:test";
import { LOOP_MARK, choose, cleanLines, introducedNames, looped, outsideLoops } from "../src/transcript";
import { keepRegions, speechRegions } from "../src/voicegate";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LOOP = ["I was chatting with Sachi Patel.", ...Array(6).fill("Software factories are the most powerful pattern in AI, right?"), "[BLANK_AUDIO]"].join("\n");
const GOOD = "I was chatting with Satya Patel.\nSoftware factories are the most powerful pattern in AI, right?";

describe("whisper output guards", () => {
  test("removes non-speech tags and keeps repeats that are not a loop", () => {
    expect(cleanLines("[BLANK_AUDIO]\nHello there.\n[clatter]\nhello there\n(keyboard clicking)\nBye.")).toBe("Hello there.\nhello there\nBye.");
    expect(cleanLines("Yes.\nYes.\nYes.")).toBe("Yes.\nYes.\nYes.");
  });
  test("detects a repetition loop", () => {
    expect(looped(LOOP)).toBe(true);
    expect(looped(GOOD)).toBe(false);
    expect(looped("Yes.\nYes.\nYes.")).toBe(false); // short back-channel words really do repeat
  });
  test("prefers the hinted pass when the plain pass looped, even though it has fewer words", () =>
    expect(choose(LOOP, GOOD)).toMatchObject({ used: "hinted", text: GOOD }));
  test("rejects a hinted pass that dropped a sentence", () =>
    expect(choose(GOOD, "I was chatting with Satya Patel.")).toMatchObject({ used: "plain", note: "hinted pass lost words" }));
  test("rejects a hinted pass that looped", () => expect(choose(GOOD, LOOP).used).toBe("plain"));
  test("with no hinted pass, a loop is collapsed to one copy and marked", () => {
    const t = choose(LOOP, null).text;
    expect(t).toContain(LOOP_MARK);
    expect(t.split("\n").filter((l) => l.startsWith("Software factories"))).toHaveLength(1);
  });
  test("a two-line unit repeated back to back is a loop too", () =>
    expect(looped(["Intro.", ...Array(3).fill("I will try to find the best way.\nTo do it properly."), ].join("\n"))).toBe(true));
  test("a phrase said three times across a long conversation is not a loop", () => {
    const talk = ["I don't know about that.", "We should ask the lawyers first.", "I don't know about that.", "Maybe next quarter then.", "I don't know about that."].join("\n");
    expect(looped(talk)).toBe(false);
    expect(cleanLines(talk).split("\n")).toHaveLength(5);
  });
  test("one dropped sentence in a long segment is caught (the bound is words, not a percentage)", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the long meeting we had today.`);
    const dropped = lines.filter((_, i) => i !== 17);
    expect(choose(lines.join("\n"), dropped.join("\n"))).toMatchObject({ used: "plain", note: "hinted pass lost words" });
  });
  test("a hinted pass that adds a stock sentence is rejected", () =>
    expect(choose(GOOD, GOOD + "\nThanks for watching and do not forget to subscribe!")).toMatchObject({ used: "plain", note: "hinted pass added words" }));
  test("a corrected name and a hyphen do not count as lost words", () =>
    expect(choose("I met Sachi Patel from Super Set. It was open sourced in June.", "I met Satya Patel from Superset. It was open-sourced in June.").used).toBe("hinted"));
  test("slack is per changed name: many offered names do not let a stock or dropped sentence through", () => {
    const names = ["Satya Patel", "Superset", "Acme", "Jane Doe", "Initech"];
    const plain = "I met Sachi Patel from Superset with Jane Doe of Acme and Initech.\nSoftware factories are the most powerful pattern in AI, right?";
    const hinted = plain.replace("Sachi", "Satya");
    const n = (h: string) => introducedNames(cleanLines(h), cleanLines(plain), names).length;
    expect(choose(plain, hinted, n(hinted)).used).toBe("hinted");
    const stock = hinted + "\nThanks for watching and do not forget to subscribe!";
    expect(choose(plain, stock, n(stock))).toMatchObject({ used: "plain", note: "hinted pass added words" });
  });
  test("when the plain pass looped, an empty or gutted hinted pass does not win", () => {
    expect(choose(LOOP, "[BLANK_AUDIO]", 1).used).toBe("plain");
    expect(outsideLoops(LOOP)).toBe("I was chatting with Sachi Patel.");
    expect(choose("We agreed the price on Tuesday with the whole team present.\n" + LOOP, "Software factories are the most powerful pattern in AI, right?", 0).used).toBe("plain");
  });
  test("names the hint introduced are reported, names heard independently are not", () => {
    expect(introducedNames("I met Satya Patel at Superset.", "I met Sasha Patel at Superset.", ["Satya Patel", "Superset"])).toEqual(["Satya Patel"]);
    expect(introducedNames("I met Satya\nPatel.", "I met Satya Patel.", ["Satya Patel"])).toEqual([]);
    // a respelling of what was heard is not a substitution; a different first name is
    expect(introducedNames("Try GBrain with Superset.", "Try G-Brain with Super Set.", ["GBrain", "Superset"], true)).toEqual([]);
    expect(introducedNames("I met Satya Patel.", "I met Sachi Patel.", ["Satya Patel"], true)).toEqual(["Satya Patel"]);
  });
});

describe("speech regions on the real room recording", () => {
  const d = readFileSync(join(import.meta.dir, "fixtures", "room-say.wav"));
  const pcm = new Float32Array((d.length - 44) >> 1);
  for (let i = 0; i < pcm.length; i++) pcm[i] = d.readInt16LE(44 + i * 2) / 32768;
  test("keeps the 10 s of speech and drops the 20 s of room noise after it", () => {
    const r = speechRegions(pcm);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r[0][0] / 16000).toBeLessThan(2.5);
    expect(r.at(-1)![1] / 16000).toBeLessThan(11);
    const kept = keepRegions(pcm, r).length / 16000;
    expect(kept).toBeGreaterThan(7);
    expect(kept).toBeLessThan(11);
  });
  test("silence yields no regions", () => expect(speechRegions(new Float32Array(16000 * 5))).toEqual([]));
});
