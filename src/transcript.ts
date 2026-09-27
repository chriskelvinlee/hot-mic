// Guards for whisper output. Whisper's known failure on ambient audio is to
// invent a sentence and repeat it; an archive of "what was said" must not keep
// that silently, and must not silently drop real speech either.

const NON_SPEECH = /^[\[(][^\])]{1,40}[\])]$/; // [BLANK_AUDIO], [clatter], (keyboard clicking)
export const LOOP_MARK = "_(whisper repeated";

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();
export const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** The lines that carry speech: trimmed, non-empty, not a non-speech tag. */
const kept = (raw: string) => raw.split("\n").map((l) => l.trim()).filter((l) => l && !NON_SPEECH.test(l));

/**
 * Finds a unit of one or two lines said three or more times back to back,
 * starting at line i. People do repeat themselves, but not three times in a row
 * word for word in full sentences; whisper does. Short back-channel lines
 * ("Yes." "Yes." "Yes.") are left alone.
 */
function loopAt(lines: string[], i: number): { period: number; reps: number } | null {
  for (const period of [1, 2]) {
    const unitWords = lines.slice(i, i + period).join(" ").split(/\s+/).length;
    if (unitWords < 3) continue;
    let reps = 1;
    while (
      i + (reps + 1) * period <= lines.length &&
      Array.from({ length: period }, (_, k) => norm(lines[i + k]) !== "" && norm(lines[i + k]) === norm(lines[i + reps * period + k])).every(Boolean)
    ) reps++;
    if (reps >= 3) return { period, reps };
  }
  return null;
}

/** True when the output shows a repetition loop. Only consecutive repeats count. */
export function looped(raw: string): boolean {
  const lines = kept(raw);
  for (let i = 0; i < lines.length; i++) if (loopAt(lines, i)) return true;
  return false;
}

/**
 * Drops non-speech tags. A loop (see loopAt) is reduced to one copy with a visible
 * marker, because whatever whisper looped on may be invented, and the reader should
 * know to check the audio. Any other repeat is kept as heard: a visible duplicate is
 * harmless, a silent drop is not.
 */
export function cleanLines(raw: string): string {
  const lines = kept(raw);
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    const loop = loopAt(lines, i);
    if (loop) {
      out.push(`${LOOP_MARK} the next ${loop.period === 1 ? "line" : "two lines"} ${loop.reps} times; it may be invented. Check the audio.)_`);
      out.push(...lines.slice(i, i + loop.period));
      i += loop.period * loop.reps;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

/** What a pass heard outside its loops: the part of a looped pass that can still be trusted. */
export function outsideLoops(raw: string): string {
  const lines = kept(raw), out: string[] = [];
  for (let i = 0; i < lines.length; ) { const loop = loopAt(lines, i); if (loop) i += loop.period * loop.reps; else out.push(lines[i++]); }
  return out.join("\n");
}

/** Words in `a` with no counterpart in `b`, and the reverse, comparing as multisets. */
export function wordDiff(a: string, b: string): { missing: number; added: number } {
  const bag = (t: string) => {
    const m = new Map<string, number>();
    for (const w of t.toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9' ]/g, " ").split(/\s+/).filter(Boolean)) m.set(w, (m.get(w) || 0) + 1);
    return m;
  };
  const A = bag(a), B = bag(b);
  let missing = 0, added = 0;
  for (const [w, n] of A) missing += Math.max(0, n - (B.get(w) || 0));
  for (const [w, n] of B) added += Math.max(0, n - (A.get(w) || 0));
  return { missing, added };
}

/**
 * Chooses between the plain pass and the name-hinted pass. The hint fixes names,
 * so the hinted pass is preferred, but only when it otherwise says the same
 * thing: a hint has made whisper drop a whole sentence, and can make it add one.
 * The passes are compared word by word. A corrected name costs two or three
 * words; a dropped sentence costs all of its words, however long the segment.
 * `hintNames` is the number of names the hint actually changed, never the number
 * offered: a name spelled the same in both passes costs no words, so slack per
 * offered name was free headroom for an invented or dropped sentence.
 */
export function choose(plainRaw: string, hintedRaw: string | null, hintNames = 1): { text: string; used: "plain" | "hinted"; note?: string } {
  const plain = cleanLines(plainRaw);
  const plainLooped = looped(plainRaw);
  if (hintedRaw === null) return { text: plain, used: "plain", note: plainLooped ? "whisper looped" : undefined };
  const hinted = cleanLines(hintedRaw);
  if (looped(hintedRaw) && !plainLooped) return { text: plain, used: "plain", note: "hinted pass looped" };
  const allowed = 3 + 2 * hintNames + Math.round(wordCount(plain) * 0.005);
  // A looped plain pass is no baseline for its loop (invented, or it displaced real speech), so added
  // words are not checked. What it heard outside the loop still is, and an empty hinted pass is
  // never better than a marked one.
  if (plainLooped && (!hinted || wordDiff(outsideLoops(plainRaw), hinted).missing > allowed))
    return { text: plain, used: "plain", note: "plain pass looped; hinted pass lost words" };
  if (!plainLooped) {
    const d = wordDiff(plain, hinted);
    if (d.missing > allowed) return { text: plain, used: "plain", note: "hinted pass lost words" };
    if (d.added > allowed) return { text: plain, used: "plain", note: "hinted pass added words" };
  }
  return { text: hinted, used: "hinted", note: plainLooped ? "plain pass looped" : undefined };
}

/**
 * Hinted names that appear in the chosen text but were not heard by the unhinted pass.
 * With `sameSounds`, a name the plain pass heard with different spacing or hyphens
 * ("G-Brain", "Super Set") does not count: that is a spelling, not a different name.
 */
export function introducedNames(chosen: string, plainClean: string, hintNames: string[], sameSounds = false): string[] {
  const flat = (s: string) => sameSounds ? s.toLowerCase().replace(/[^a-z0-9]/g, "") : s.toLowerCase().replace(/\s+/g, " ");
  return hintNames.filter((n) => flat(chosen).includes(flat(n)) && !flat(plainClean).includes(flat(n)));
}
