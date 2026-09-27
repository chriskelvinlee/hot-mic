# Hot Mic / Chief of Staff

A proof of concept for the GBrain Side Quest: *solve tedious human problems with a new skill or memory improvement.*

**The problem.** Your scarcest resource is decisions, not time. The old loop: record a meeting with Otter, Fireflies or Granola, paste the summary into a fresh agent thread, ask it to do the tasks, then nurse the agent until the result is right. Meeting notes treat everything that sounds like a task as a task, and agents amplify that noise.

**The new loop.** Hot Mic hears your whole day (with consent). The `chief-of-staff` GBrain skill:

1. pulls the signal out of the day and drops the noise with a stated reason (venting, speculative, already handled, not yours, duplicate);
2. checks your own recorded rulings in GBrain (takes held by `self`) and handles anything a precedent already answers, citing the rule, and escalates anything outside its bounds;
3. puts at most 3 decisions a day in front of you, each with options, a recommended default and the cost of delay;
4. dispatches the rest to agents (Claude Code, Codex, Muse, email drafts, calendar holds) with briefs that carry the verbatim signal, list what was left out, and stop at an approval gate;
5. writes each decision you make back to GBrain as a precedent row, so you never make the same decision twice.

**The eval.** Is it a real chief of staff? A separate agent, playing a veteran human chief of staff, labelled the same day without ever seeing the skill or its output. The page scores the skill against that answer key: route agreement, dropped balls, unnecessary interruptions, and noise amplified compared with a meeting-notes baseline.

## Results on the demo day

One synthetic Thursday: 8 conversations, 89 lines, all with consent on record.

| | Old way (meeting-notes AI) | Chief of Staff |
|---|---|---|
| Put in front of you | 42 action items | 2 decisions |
| Settled from your own precedents | 0 | 12 |
| Dispatched to agents with a brief | 0 | 3 |
| Noise turned into work (of 16 noise moments the grader found) | 13 | 0 |

Against the blind grader (33 graded items): 88% route agreement (29/33), no dropped balls, no unnecessary interruptions, needs-you precision 100% (2/2), needs-you recall 50% (2/4).

**What the eval caught.** The two recall misses are the Kestrel deck read and the late Fernhill memo comments. The grader said "this work is yours, put it in front of you". The skill sent both to an agent that protects your time and tells Maya, with the work itself still yours. So the skill's "you" route covers decisions but not work only you can do. Fix for v0.2: split the route into *decide* and *do*, so your own commitments stay on your list, and cap only the decisions.

## Two-minute demo

1. **The problem (15 s).** "My scarcest resource is decisions. Today I record a meeting, paste the notes into an agent, then babysit it."
2. **The funnel (15 s).** "Hot Mic heard 89 lines of my Thursday. A meeting-notes AI would hand me 42 action items. My chief of staff hands me 2."
3. **The catch (20 s).** Click the Tidewater decision. "This was said once, under a CRM rant, and I missed it. It's a $400k exploding term sheet. The old way listed it as item 18 of 42, unassigned."
4. **Decide once (20 s).** On the Greg card, pick *Set a written plan with agreed numbers first*. The take row that would go to GBrain appears: "When a Kestrel leader has never agreed to a written plan, I advise Dev to set the plan first". Then type into *Try it*: "Dev wants to let his head of engineering go, and she never agreed to a written plan either". It routes to precedent and cites the rule you just made. "I never make the same decision twice." (Tested offline; on claude.ai, Claude does the routing instead of the keyword fallback.)
5. **Signal, not noise (15 s).** Open a dispatch card: verbatim signal, what was left out on purpose, done-when, and an approval gate.
6. **Is it real? (20 s).** The scorecard: a separate agent graded the day blind. 88% agreement, zero noise amplified against 13, and the one real gap it found (above).
7. **Close (10 s).** "It's one GBrain skill file. GBrain is a pre-harness for any brain-computer interface."

Press *Replay the day* for the animated version; *Skip to end* restores the full view.

## Try it on your own conversation

On the claude.ai page, go to *Run it on your own conversation*. Upload or paste a transcript from Otter, Fireflies, Granola, Zoom (.vtt or .srt), a JSON export, or plain `Name: text` lines. Then pick which speaker is you, confirm everyone agreed to be recorded, and press *Triage this conversation*. Claude runs the full SKILL.md on it with your rules, which usually takes 30 to 90 seconds, and the whole page redraws for your conversation. *Back to the demo day* returns. By default only your real rules, plus any you decided on the page, count as precedents; tick the box to add the demo day's example rules.

The transcript stays in the browser tab and goes to Claude once, on your account. The page does not save it. One request to Claude holds at most 64 KiB, so a long transcript is split into equal parts. Claude reads two parts at a time, and one short final call merges matters that span parts and writes one brief. An hour-long meeting takes two parts and a few minutes. If a part fails, the page still draws the others and names the lines it could not triage. Transcripts over 240,000 characters (about four hours) are cut, and the page says how many lines were left out.

`cos/samples/` has four synthetic transcripts, one per export format. Locally they are at http://127.0.0.1:4757/samples/otter-founder-1on1.txt and so on. Local triage needs Claude, so it only runs on the claude.ai page.

## Run it

```bash
bun cos/build.ts && bun cos/serve.ts
```

Then open http://127.0.0.1:4757. It works offline, so bring it up before you present in case the Wi-Fi fails. Live triage (type a line, get it routed by Claude) needs the claude.ai Artifact version of the page, https://claude.ai/artifact/ShevjvqyBXDsdZXDoJAtm1 (private until you share it). Offline it falls back to a keyword heuristic and labels it that way. The first live call asks the viewer to allow Claude usage.

## Files

| Path | What it is |
|---|---|
| `skills/chief-of-staff/SKILL.md` | the new GBrain skill, in GBrain's skill format |
| `packs/cos-demo/` | GBrain pages holding your standing rules as takes rows; the rows marked real are copied from `~/brain` |
| `cos/demo/day.json` | one synthetic day: contexts and utterances, no labels |
| `cos/demo/triage.json` | the skill's output for that day |
| `cos/demo/gold.json` | the blind grader's answer key |
| `cos/demo/baseline.json` | the old way: a meeting-notes AI emulation |
| `cos/build.ts` | scores triage against gold and inlines everything into `cos/dist/` |
| `cos/app.html` | the page (an Artifact fragment) |

Nothing in this demo sends, writes or spends anything. The day, its people and its companies are fictional.
