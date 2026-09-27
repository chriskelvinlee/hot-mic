// Dev-only stub for cos/app.html. Never referenced by the page.
// Test by concatenating: replace the cos-data line with this file inside a <script>.
// Everything here is synthetic and fictional.
window.COS_DATA = {
  day: {
    date: "2026-09-24",
    weekday: "Thursday",
    owner: { name: "Chris", role: "Runs a small seed fund, sits on one board, builds on the side." },
    capture: "Hot Mic iPhone recorder, voice-gated, transcribed on the Mac with local Whisper; no audio kept.",
    lanes: [
      { id: "fund", label: "Fund", blurb: "Deals, LPs and the partnership" },
      { id: "board", label: "Board", blurb: "Board seat at a portfolio company" },
      { id: "build", label: "Build", blurb: "Hot Mic and GBrain side projects" },
      { id: "personal", label: "Personal", blurb: "Family, health, home" }
    ],
    contexts: [
      { id: "c1", start: "07:40", end: "07:44", kind: "voice memo", title: "Morning walk memo", people: ["Chris (you)"], lane: "personal", consent: "Solo voice memo" },
      { id: "c2", start: "09:30", end: "10:05", kind: "1:1", title: "Pipeline 1:1 with Maya", people: ["Chris (you)", "Maya Chen (Associate)"], lane: "fund", consent: "All-party consent given at the start" },
      { id: "c3", start: "14:00", end: "14:40", kind: "group meeting", title: "Board prep with Tidewater Labs", people: ["Chris (you)", "Dev Okafor (CEO, Tidewater Labs)", "Priya Raman (CFO, Tidewater Labs)"], lane: "board", consent: "All-party consent given at the start" }
    ],
    utterances: [
      { id: "u001", t: "07:41", context: "c1", speaker: "Chris", text: "Note to self. Pick up the dry cleaning, and I want to finally write down how we think about bridge rounds." },
      { id: "u002", t: "07:42", context: "c1", speaker: "Chris", text: "Also, the recital is at six on Friday. I am not missing that one." },
      { id: "u003", t: "09:31", context: "c2", speaker: "Maya Chen", text: "Loom Robotics wants a first meeting Friday morning, the founder is only in town that day." },
      { id: "u004", t: "09:32", context: "c2", speaker: "Chris", text: "Hmm." },
      { id: "u005", t: "09:33", context: "c2", speaker: "Maya Chen", text: "And Harbor Health is raising a bridge. They want us to lead with seven fifty by Monday." },
      { id: "u006", t: "09:34", context: "c2", speaker: "Chris", text: "Ugh, the parking garage was full again, total zoo this morning." },
      { id: "u007", t: "14:02", context: "c3", speaker: "Dev Okafor", text: "Can you send me feedback on the deck before the board call next week?" },
      { id: "u008", t: "14:03", context: "c3", speaker: "Chris", text: "Yes, you will have written feedback from me by Tuesday." },
      { id: "u009", t: "14:05", context: "c3", speaker: "Priya Raman", text: "Maybe we should all switch to a new board portal someday." },
      { id: "u010", t: "14:06", context: "c3", speaker: "Dev Okafor", text: "And we still need to decide whether to extend Ana's offer before she takes the other one, which is a very long sentence that keeps going to test how the layout wraps when somebody talks for a while without stopping for breath." }
    ]
  },
  triage: {
    skill: "chief-of-staff",
    skill_version: "0.1.0",
    attention_budget: 3,
    items: [
      {
        id: "t01", utterances: ["u003"], context: "c2", lane: "fund",
        signal: "first meeting Friday morning", speaker: "Maya Chen", type: "ask", route: "precedent",
        title: "Offer Loom Robotics Tuesday or Thursday",
        why: "Your Friday rule already answers this, so you do not need to decide it again.",
        precedent: { page: "packs/cos-demo/concepts/meeting-rules.md", claim: "I never take first meetings on Fridays; offer Tuesday or Thursday", since: "2026-06-02", action: "Offered Loom Robotics Tuesday 10:00 or Thursday 15:00 through Maya.", real: false },
        dispatch: { agent: "Calendar", brief: "Hold Tuesday 10:00 and Thursday 15:00 next week for a first meeting with Loom Robotics. Send both options to Maya to pass on.", signal: ["Loom Robotics wants a first meeting Friday morning"], noise_excluded: ["The founder's travel details"], done_when: ["Two holds exist on your calendar", "Maya has both options"], context_pages: ["packs/cos-demo/concepts/meeting-rules.md"], approval_gate: "none", lane_scope: "fund" }
      },
      {
        id: "t02", utterances: ["u005"], context: "c2", lane: "fund",
        signal: "They want us to lead with seven fifty by Monday.", speaker: "Maya Chen", type: "decision", route: "you",
        title: "Decide on leading Harbor Health's bridge",
        why: "It commits fund reserves and no precedent covers leading a bridge.",
        decision: {
          question: "Do you lead Harbor Health's $750k bridge by Monday?",
          options: [
            { label: "Lead the full $750k", tradeoff: "Keeps your pro rata and board influence; concentrates reserves in one company." },
            { label: "Take $300k and ask existing investors to fill", tradeoff: "Shows support without leading; the round may not close by Monday." },
            { label: "Pass", tradeoff: "Frees reserves; the company may read it as a loss of confidence." }
          ],
          recommended: 1,
          why_only_you: "Reserves and signaling to a portfolio company are fund calls only you can make.",
          deadline: "2026-09-28", stakes: "high", reversible: false,
          cost_of_delay: "They go to another lead on Tuesday."
        }
      },
      {
        id: "t03", utterances: ["u007", "u008"], context: "c3", lane: "board",
        signal: "you will have written feedback from me by Tuesday", speaker: "Chris", type: "commitment-by-you", route: "agent",
        title: "Draft Tidewater deck feedback for Dev",
        why: "You already committed; an agent can draft it for your review.",
        dispatch: {
          agent: "Muse", brief: "Draft written feedback on the Tidewater Labs board deck for Dev Okafor. Focus on the three places the plan and the numbers disagree. Keep it under one page.",
          signal: ["Can you send me feedback on the deck before the board call next week?", "you will have written feedback from me by Tuesday"],
          noise_excluded: ["Board portal idea", "Ana's offer, which is Dev's call"],
          done_when: ["One-page draft in your review queue by Monday evening", "Each point cites a slide number"],
          context_pages: ["packs/cos-demo/companies/tidewater-labs.md"], approval_gate: "before sending", lane_scope: "board"
        }
      },
      { id: "t04", utterances: ["u006"], context: "c2", lane: "personal", signal: "the parking garage was full again", speaker: "Chris", type: "chatter", route: "drop", title: "Parking complaint", why: "Venting, nothing to do.", drop_reason: "venting" },
      { id: "t05", utterances: ["u009"], context: "c3", lane: "board", signal: "Maybe we should all switch to a new board portal someday.", speaker: "Priya Raman", type: "idea", route: "drop", title: "Board portal idea", why: "Speculative, no owner, no date.", drop_reason: "speculative" },
      { id: "t06", utterances: ["u010"], context: "c3", lane: "board", signal: "decide whether to extend Ana's offer", speaker: "Dev Okafor", type: "decision", route: "drop", title: "Ana's offer", why: "Hiring at Tidewater is Dev's decision, not yours.", drop_reason: "not yours" },
      {
        id: "t07", utterances: ["u002"], context: "c1", lane: "personal",
        signal: "the recital is at six on Friday", speaker: "Chris", type: "commitment-by-you", route: "agent",
        title: "Block Friday evening for the recital",
        why: "A clear calendar task with no decision in it.",
        dispatch: { agent: "Calendar", brief: "Block Friday 17:30 to 19:30 for the recital. Decline anything that overlaps.", signal: ["the recital is at six on Friday"], noise_excluded: ["Dry cleaning"], done_when: ["Block exists", "No overlaps remain"], context_pages: [], approval_gate: "none", lane_scope: "personal" }
      }
    ],
    memory_writes: [
      { page: "packs/cos-demo/concepts/bridge-rounds.md", row: "| 3 | For portfolio bridges, take part of the round and ask existing investors to fill the rest | take | self | 0.8 | 2026-09-24 | decided via chief of staff |", trigger: "t02, written only after you decide" }
    ],
    end_of_day_brief: "You had one real decision today: whether to lead Harbor Health's bridge. I recommend taking $300k and asking existing investors to fill; they need an answer by Monday. Loom Robotics is handled under your Friday rule, and a draft of Dev's deck feedback will be in your review queue before Tuesday. I left the board portal idea and Ana's offer alone; neither is yours to carry."
  },
  gold: {
    labeler: "Separate grader agent; saw the day and your precedents, never the skill or its output.",
    items: [
      { id: "g01", utterances: ["u003"], route: "precedent", summary: "Loom asks for a Friday first meeting", would_do: "Offer Tuesday or Thursday under the Friday rule", severity_if_missed: "medium" },
      { id: "g02", utterances: ["u005"], route: "you", summary: "Harbor Health bridge lead ask", would_do: "Put the decision in front of you with options", severity_if_missed: "high" },
      { id: "g03", utterances: ["u007", "u008"], route: "agent", summary: "You promised Dev deck feedback", would_do: "Have a draft ready for review", severity_if_missed: "medium" },
      { id: "g04", utterances: ["u006"], route: "drop", summary: "Parking rant", would_do: "Nothing", severity_if_missed: "low" },
      { id: "g05", utterances: ["u009"], route: "drop", summary: "Board portal someday", would_do: "Nothing", severity_if_missed: "low" },
      { id: "g06", utterances: ["u010"], route: "drop", summary: "Ana's offer at Tidewater", would_do: "Nothing, it is Dev's call", severity_if_missed: "low" },
      { id: "g07", utterances: ["u002"], route: "precedent", summary: "Friday recital", would_do: "Protect Friday evening under the family rule", severity_if_missed: "medium" },
      { id: "g08", utterances: ["u001"], route: "agent", summary: "Write down how you think about bridge rounds", would_do: "Start a draft page from past decisions", severity_if_missed: "medium" }
    ]
  },
  baseline: {
    tool: "Generic meeting-notes AI (Otter / Fireflies / Granola style)",
    how: "Summarizes each recording and lists every action item it hears.",
    meetings: [
      { context: "c1", summary: "Chris listed errands and a Friday recital." },
      { context: "c2", summary: "Maya raised Loom Robotics and a Harbor Health bridge." },
      { context: "c3", summary: "Board prep with Tidewater Labs." }
    ],
    action_items: [
      { id: "b01", text: "Pick up dry cleaning", owner: "Chris", context: "c1", utterances: ["u001"] },
      { id: "b02", text: "Write down bridge round thinking", owner: "Chris", context: "c1", utterances: ["u001"] },
      { id: "b03", text: "Attend recital Friday at 6", owner: "Chris", context: "c1", utterances: ["u002"] },
      { id: "b04", text: "Schedule first meeting with Loom Robotics on Friday", owner: "Chris", context: "c2", utterances: ["u003"] },
      { id: "b05", text: "Decide on leading Harbor Health bridge", owner: "Chris", context: "c2", utterances: ["u005"] },
      { id: "b06", text: "Look into parking garage capacity", owner: "unassigned", context: "c2", utterances: ["u006"] },
      { id: "b07", text: "Send deck feedback to Dev by Tuesday", owner: "Chris", context: "c3", utterances: ["u007", "u008"] },
      { id: "b08", text: "Evaluate new board portal", owner: "unassigned", context: "c3", utterances: ["u009"] },
      { id: "b09", text: "Decide on extending Ana's offer", owner: "Chris", context: "c3", utterances: ["u010"] }
    ]
  },
  precedents: [
    { page: "packs/cos-demo/concepts/meeting-rules.md", title: "Meeting rules", lane: "fund", rows: [
      { claim: "I never take first meetings on Fridays; offer Tuesday or Thursday", kind: "take", who: "self", weight: 0.9, since: "2026-06-02", source: "owner decision", real: false },
      { claim: "Family evenings after 17:30 on Fridays are protected", kind: "take", who: "self", weight: 0.95, since: "2026-03-10", source: "owner decision", real: false }
    ] },
    { page: "packs/cos-demo/concepts/bridge-rounds.md", title: "Bridge rounds", lane: "fund", rows: [
      { claim: "I follow on in bridges only when the company has 12 months of runway after the round", kind: "take", who: "self", weight: 0.8, since: "2025-11-04", source: "owner decision", real: false },
      { claim: "Existing investors fill a bridge before we consider leading it", kind: "take", who: "self", weight: 0.7, since: "2026-01-15", source: "owner decision", real: false }
    ] },
    { page: "packs/cos-demo/concepts/thin-harness.md", title: "Thin harness, fat skills", lane: "build", rows: [
      { claim: "Keep the harness thin and put judgment in skills you own", kind: "take", who: "self", weight: 0.85, since: "2026-05-20", source: "owner decision (real, from ~/brain)", real: true }
    ] }
  ],
  skill: {
    name: "chief-of-staff",
    version: "0.1.0",
    description: "Triage a heard day into what needs you, what your precedents decide, what agents do, and what to drop.",
    markdown: "---\nname: chief-of-staff\nversion: 0.1.0\ndescription: Triage a heard day into what needs you, what your precedents decide, what agents do, and what to drop.\n---\n\n# Chief of staff\n\n## Contract\n\n- Input: one day of utterances with contexts, plus the owner's precedent pages.\n- Output: triage.json with one route per signal.\n\n## Routes\n\n| route | when |\n|-------|------|\n| you | only the owner can decide and no precedent covers it |\n| precedent | an existing take decides it |\n| agent | work that needs no new decision |\n| drop | chatter, venting, speculation, not yours |\n"
  },
  eval: {
    grader: "Separate agent; saw the day and your precedents, never the skill or its output.",
    gold_items: 8,
    route_agreement: { agree: 6, total: 8, pct: 75 },
    confusion: {
      you: { you: 1, precedent: 0, agent: 0, drop: 0, missing: 0 },
      precedent: { you: 0, precedent: 1, agent: 1, drop: 0, missing: 0 },
      agent: { you: 0, precedent: 0, agent: 1, drop: 0, missing: 1 },
      drop: { you: 0, precedent: 0, agent: 0, drop: 3, missing: 0 }
    },
    needs_you: { recall_pct: 100, precision_pct: 100, caught: 1, gold_total: 1, cos_total: 1 },
    missed: [ { gold_id: "g08", summary: "Write down how you think about bridge rounds", severity: "medium", cos_route: "missing" } ],
    interruptions: [],
    noise: { gold_noise_total: 3, cos_amplified: 0, baseline_amplified: 3 },
    compression: { utterances: 10, contexts: 3, baseline_action_items: 9, you: 1, precedent: 1, agent: 2, drop: 3 },
    per_item: [
      { gold_id: "g01", triage_id: "t01", gold_route: "precedent", cos_route: "precedent", agree: true, summary: "Loom asks for a Friday first meeting" },
      { gold_id: "g02", triage_id: "t02", gold_route: "you", cos_route: "you", agree: true, summary: "Harbor Health bridge lead ask" },
      { gold_id: "g03", triage_id: "t03", gold_route: "agent", cos_route: "agent", agree: true, summary: "You promised Dev deck feedback" },
      { gold_id: "g04", triage_id: "t04", gold_route: "drop", cos_route: "drop", agree: true, summary: "Parking rant" },
      { gold_id: "g05", triage_id: "t05", gold_route: "drop", cos_route: "drop", agree: true, summary: "Board portal someday" },
      { gold_id: "g06", triage_id: "t06", gold_route: "drop", cos_route: "drop", agree: true, summary: "Ana's offer at Tidewater" },
      { gold_id: "g07", triage_id: "t07", gold_route: "precedent", cos_route: "agent", agree: false, summary: "Friday recital" },
      { gold_id: "g08", triage_id: null, gold_route: "agent", cos_route: null, agree: false, summary: "Write down how you think about bridge rounds" }
    ]
  },
  built_at: "2026-09-27T14:30:00-07:00"
};
