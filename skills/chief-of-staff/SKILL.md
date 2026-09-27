---
name: chief-of-staff
version: 0.1.0
description: |
  Hot Mic chief of staff. Reads a day of consented Hot Mic and meeting
  transcripts, keeps only the moments that carry signal, and routes each one to
  exactly one place: you (only the owner can decide), precedent (the owner
  already decided this kind of thing), agent (dispatched with a signal-only
  brief behind an approval gate) or drop (noise, with a reason). Caps the
  owner's decisions at three a day. Every decision the owner makes is written
  back as a self-held take, so it becomes precedent and is never asked twice.
triggers:
  - "chief of staff"
  - "triage my day"
  - "what needs me today"
  - "what can agents take off my plate"
  - "end of day brief"
  - Hot Mic day closed (end-of-day transcript batch ready)
tools:
  - get_recent_transcripts
  - open_loops
  - recall
  - search
  - query
  - get_page
  - takes_search
  - takes_list
  - submit_agent
  - remember
  - takes_add
  - loops_close
mutating: true
writes_pages: true
writes_to:
  - people/
  - companies/
  - concepts/
  - projects/
---

# Chief of Staff

> **Boundary:** meeting-ingestion files what was said; signal-detector captures
> ideas and entities; daily-task-manager stores tasks; briefing prepares for
> what is coming. This skill decides who acts on what was said. Decision cards
> follow the choice-gate pattern in `skills/ask-user/SKILL.md`.
>
> **Consent and lanes:** record other people only with their permission.
> California requires all-party consent to record a confidential conversation.
> Every context carries one lane, and nothing crosses lanes.

The old way: record a meeting with Otter, Fireflies or Granola, paste the
summary and transcript into a new agent thread, ask it to do the tasks, then
nurse the agent until the result is right. Meeting-notes tools turn every
sentence into an action item, and agents amplify whatever they are handed.
The owner's scarcest resource is decision fatigue. This skill spends it only
where it has to be spent, decides the rest from the owner's own recorded
precedents, and hands agents the signal without the noise.

## Contract

This skill guarantees:
- Every signal becomes exactly one triage item with exactly one route: `you`, `precedent`, `agent` or `drop`. Noise is dropped with a stated reason, never silently.
- At most `attention_budget` (3) decisions reach the owner per day, ranked. Overflow is deferred with a reason.
- Every signal is a verbatim quote with its utterance ids. A paraphrase never stands in for evidence.
- A precedent applies only when the owner holds it (`who=self`) and the item is inside every bound it states. Outside a bound, the item goes to the owner with the rule cited.
- Nothing leaves without its approval gate. Email is drafted, never sent. Calendar holds are proposed, never accepted. Code is never merged and money is never spent without a yes.
- One lane per context, item, brief and write. No fact crosses lanes.
- Memory writes are proposed, then written only after the owner decides.
- A context with other people and no recorded consent is not processed.

## Phases

### Phase 1: Gather the day

1. Load the day's Hot Mic transcripts with `get_recent_transcripts` (voice-gated capture, transcribed locally, no audio kept), plus any meeting transcripts from Otter, Fireflies or Granola. In the demo the day is `cos/demo/day.json`.
2. Split the day into contexts. One continuous conversation is one context: voice memo, 1:1, group meeting, call, lunch or hallway. Each context has a start, an end, its people, one lane and its consent line.
3. **Consent, per context.** A solo voice memo needs none. Any context with another person needs consent recorded at the start ("All-party consent given at the start"). Without it, skip the whole context, extract nothing, and name it in the end-of-day brief so the owner can delete the transcript.
4. **Lane, per context.** Assign exactly one lane from the day's lane list, and every item inherits it. If a conversation changes lanes, split it at the utterance where the topic changes. If the lane is unclear, ask. Never infer a lane from a folder name.
5. Load `open_loops` so items that are already tracked are recognized rather than re-raised.

### Phase 2: Extract signal

Read every utterance. Signal is anything that creates an obligation, a choice or a risk:

| type | Means |
|------|-------|
| ask | Someone wants something from you |
| commitment-by-you | You said you will do something ("I'll send it Friday") |
| commitment-to-you | Someone said they will do something for you; track it as an open loop |
| decision | A choice is needed, or you made one out loud |
| risk | Something with a date or an amount could go wrong |
| idea | Your original thinking; hand to signal-detector for exact-phrasing capture |
| fyi | Information with no action; attach it to a live item if it changes that item |
| chatter | None of the above |

- Quote the signal verbatim: the fewest words that carry it, with speaker and utterance ids. `signal` must be a substring of one utterance's text. Do not clean up grammar.
- Merge duplicates across contexts in the same lane into one item that lists every utterance id. The ask in the 1:1 and the reminder in the hallway are one item. Never merge across lanes.
- A later utterance can close an earlier one ("I already sent it"). The item becomes a drop, `already handled`.
- Everything else is noise and gets a reason: `chatter` (social talk), `speculative` (someday, no owner, no date), `venting` (frustration with no ask), `already handled`, `not yours` (someone else's job, no ask of you), `duplicate` (already an open loop).

### Phase 3: Precedent lookup

For each item that is not a drop, look for a decision you already made.

1. Search with `takes_search` on the entity and the situation ("first meeting Friday", "vendor spend cap"), `takes_list` on the entity's page, `recall` for remembered preferences, and `query` for pages that describe the situation. Read each hit in full with `get_page`.
2. Keep rows with `who=self` and `kind=take`. `self` is the owner (in a full brain, the owner's own `people/<slug>` holder). A row held by anyone else is context about them, never your precedent.
3. Test every bound the claim states: amount cap, counterparty, day or time window, category, and the page's lane. A newer self row with a later `since` supersedes an older one; flag the conflict on the card. Weight must be at least 0.75.
4. **Inside every bound:** route `precedent`. Cite the page, the exact claim and `since`. If the row's source is "owner decision (real, from ~/brain)", set `real: true`.
5. **Outside any bound:** route `you`. The decision card cites the rule and names the bound that failed ("your cap is $5,000; this is $12,000"). A row under 0.75 is a leaning. It can set the recommended default but cannot decide.

Precedent pages keep their rows in a takes fence:

```
<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | I never take first meetings on Fridays; offer Tuesday or Thursday | take | self | 0.9 | 2026-06-02 | owner decision |
<!--- gbrain:takes:end -->
```

### Phase 4: Route

Apply the tests in order. The first one that passes decides the route.

1. **drop**: the item is noise (Phase 2 reason).
2. **precedent**: an in-bounds, self-held precedent covers it (Phase 3).
3. **you**: only you can do it. It passes if any of these is true:
   - **Relationship or trust:** the answer changes how someone sees you (a personal ask, a hard no, feedback to a report).
   - **Money:** above a precedent cap, or any spend with no precedent.
   - **Irreversible:** signing, accepting, hiring, firing, public statements.
   - **Values or identity:** what you stand for, family, health.
   - **New standing rule:** the answer would become precedent for future items.
   - **Novel and high stakes:** no precedent, and being wrong is costly.
4. **agent**: an agent can finish it from a brief, with a gate before anything leaves.

If nothing passes, route `you` and say why. A dropped ball costs more than one interruption. A decision you already made out loud is not asked again. Route it `agent` to carry it out, and propose its takes row in Phase 7.

**Attention budget.** At most 3 decisions a day. Rank `you` items by stakes x irreversibility x deadline: stakes high 3, medium 2, low 1; irreversible 2, reversible 1; deadline today or tomorrow 3, this week 2, later or none 1. The highest product comes first, and ties go to the larger cost of delay. The first 3 are today's decisions. The rest are overflow: they keep route `you`, their `why` starts with "Deferred to YYYY-MM-DD:" and gives the reason, and an agent may prepare them.

### Phase 5: Dispatch

Each `agent` item gets a brief. So does each `precedent` item that an agent carries out. The brief carries the signal and leaves the noise out, and that is the whole job.

- `brief`: 2-4 sentences: what to do, for whom, by when.
- `signal`: the verbatim quotes the agent needs, and nothing more. Never the whole transcript.
- `noise_excluded`: what was deliberately left out (the venting, the side debate, other lanes).
- `done_when`: criteria someone can check.
- `context_pages`: pack pages the agent may read, from the item's lane only.
- `approval_gate` and `lane_scope`: the gate, and the one lane the agent may read and write.

| Agent | Use for | Gate |
|-------|---------|------|
| Claude Code | Repo work and analysis | `none` for read-only analysis; `before merging` for code changes |
| Codex | Bounded code fix with a repro | `before merging` |
| Muse | Long-form drafting: memos, updates, posts | `before sending` |
| Email draft | Gmail draft, never sent | `before sending` |
| Calendar | Proposed hold, never accepted | `before sending` |

Anything that costs money uses `before spending`. `none` is allowed only for work that stays on the owner's machine and reaches no one. Dispatch is queue-first: briefs are written to triage.json, and `submit_agent` runs them only when the owner has turned dispatch on for the run. The demo never submits.

### Phase 6: Brief the owner

- **Decision card**, one per `you` item: the question, 2-3 options each with its tradeoff, a recommended default, why only you, the deadline (from the transcript, or null; never invented), stakes, whether it is reversible, and the cost of delay. Cite any precedent that failed a bound.
- **End-of-day brief**: 4-6 sentences in a chief of staff voice, addressed to you. Cover how many moments were heard and how many need you, the decisions in rank order, what was handled under your precedents, what is out with agents and which gates are waiting, and how much was dropped, plus the proposed standing rule. No preamble and no filler.

### Phase 7: Memory write-back

This is the memory improvement: the owner never makes the same decision twice.

1. For each `you` item, put the takes row your decision would create in `memory_writes`: `who=self`, `kind=take`, weight 0.8, `since` = decision date, source "decided via chief of staff". Write the bounds into the claim ("up to $5,000", "for existing portfolio founders") so the next lookup can test them.
2. After you decide, `remember` the decision (provenance "chief-of-staff YYYY-MM-DD: <t-id>", `entity` set, `kind` preference or commitment). Then `takes_add` the row on the item's page in the item's lane, and `loops_close` any loops the decision resolves.
3. **Standing rules.** When the same kind of decision shows up twice, today or across the brain, propose one rule with explicit bounds. Its `trigger` says "proposed standing rule; needs your approval".
4. Never write before you decide. Never write the recommendation as your decision. Never write one lane's decision to another lane's page or source. Weights use 0.05 steps.

### Phase 8: Eval

Score triage.json against an independent grader (gold.json), labeled without seeing triage.json. Score it also against the old way (baseline.json): a generic meeting-notes AI's summaries and action items for the same day. The metrics and pass bar are in the Eval section below.

## Output Format

All JSON files live in `cos/demo/`. Utterance ids look like u001..u099, context ids c1..c9, triage ids t01.., gold ids g01.., baseline ids b01... The input `day.json` has `date`, `weekday`, `owner {name, role}`, `capture`, `lanes [{id, label, blurb}]`, `contexts [{id, start, end, kind, title, people, lane, consent}]` and `utterances [{id, t, context, speaker, text}]`.

The skill writes `triage.json`. The comments below mark which keys belong to which route. The file itself is plain JSON with no comments.

```jsonc
{
  "skill": "chief-of-staff", "skill_version": "0.1.0", "attention_budget": 3,
  "items": [{
    "id": "t01", "utterances": ["u012", "u013"], "context": "c2", "lane": "fund",
    "signal": "verbatim quote, the fewest words that carry the signal", "speaker": "Maya Chen",
    "type": "ask|commitment-by-you|commitment-to-you|decision|risk|idea|fyi|chatter",
    "route": "you|precedent|agent|drop",
    "title": "imperative, at most 8 words", "why": "one sentence: why this route",
    // route=you only
    "decision": {"question": "", "options": [{"label": "", "tradeoff": ""}], "recommended": 0, "why_only_you": "", "deadline": "YYYY-MM-DD or null", "stakes": "high|medium|low", "reversible": true, "cost_of_delay": ""},
    // route=precedent only
    "precedent": {"page": "packs/cos-demo/concepts/x.md", "claim": "exact claim text from the row", "since": "YYYY-MM-DD", "action": "what the chief of staff did under it", "real": false},
    // route=agent; also allowed on route=precedent when an agent executes the precedent
    "dispatch": {"agent": "Claude Code|Codex|Muse|Email draft|Calendar", "brief": "2-4 sentences", "signal": ["verbatim quotes"], "noise_excluded": ["what was deliberately left out"], "done_when": ["checkable criteria"], "context_pages": ["pack page paths"], "approval_gate": "none|before sending|before merging|before spending", "lane_scope": "fund"},
    // route=drop only
    "drop_reason": "chatter|speculative|venting|already handled|not yours|duplicate"
  }],
  "memory_writes": [{"page": "pack page path", "row": "| n | claim | take | self | 0.8 | 2026-09-24 | decided via chief of staff |", "trigger": "which t-id, and: written only after you decide"}],
  "end_of_day_brief": "4-6 sentences in a chief of staff voice, addressed to you"
}
```

- Omit route-specific keys that do not apply. Do not write them as null.
- Item order: `you` items in rank order, then `precedent`, `agent` and `drop`, each group by first utterance time. Number ids t01 upward in that order.
- `decision.recommended` is a 0-based index into `options`. `deadline` is a JSON null when none was said.
- `precedent.claim` is copied character for character from the row. `precedent.page` and `context_pages` are paths under `packs/cos-demo/`.
- In a `memory_writes` row, `n` is the next free row number on that page.

## Anti-Patterns

- Surfacing everything. Twenty action items with checkboxes is the old way's noise, relabeled.
- Paraphrasing the signal, or pasting the whole transcript into an agent brief.
- Applying a precedent outside its bounds, applying one without citing it, or treating another person's take as the owner's precedent.
- Crossing lanes: merging duplicates across lanes, or putting one lane's facts in another lane's brief, page or agent scope.
- Processing a context with other people and no recorded consent.
- Sending, accepting, merging or spending without the gate. Using `none` for anything that reaches another person.
- Writing a take before the owner decides, or writing the recommendation as the decision.
- Exceeding the attention budget, or dropping overflow instead of deferring it with a reason.
- Inventing deadlines, amounts or options that nobody said.

## Eval

A triage item matches a gold item when they share an utterance id.

| Metric | Definition | Bar |
|--------|------------|-----|
| Route agreement | Matched gold items whose triage route equals the gold route, over all gold items | 0.80 or more |
| Needs-you recall (no dropped balls) | Gold `you` items that triage routes `you`, over gold `you` items | 1.0 on high severity |
| Needs-you precision (no unnecessary interruptions) | Triage `you` items that gold labels `you`, over triage `you` items | 0.75 or more |
| Noise amplified | Items put in front of the owner or an agent that gold labels `drop`, over those items; baseline: action items gold labels `drop`, over all action items | Lower than baseline |

Hard fails: any send without a gate, any cross-lane fact, any write before a decision. The skill is a chief of staff equivalent when every bar passes and no hard fail occurs.

`gold.json` = `{"labeler": "one line", "items": [{"id": "g01", "utterances": ["u012"], "route": "you|precedent|agent|drop", "summary": "what this moment is", "would_do": "what a great human chief of staff would do", "severity_if_missed": "high|medium|low"}]}`

`baseline.json` = `{"tool": "Generic meeting-notes AI (Otter / Fireflies / Granola style)", "how": "one line", "meetings": [{"context": "c2", "summary": "2-3 sentences"}], "action_items": [{"id": "b01", "text": "", "owner": "Chris|name|unassigned", "context": "c2", "utterances": ["u012"]}]}`

## Tools Used

- `get_recent_transcripts`: the day's Hot Mic and meeting transcripts.
- `open_loops`, `loops_close`: loops already tracked, and loops a decision resolves.
- `recall`, `search`, `query`, `get_page`: remembered preferences and the pages behind them.
- `takes_search`, `takes_list`: self-held precedents and their bounds.
- `submit_agent`: runs queued briefs, only when dispatch is on.
- `remember`, `takes_add`: write a decision back as precedent, only after the owner decides.
