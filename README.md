# Hot Mic

Hold a key and speak. Within about a second, one card from your own brain appears for the person, company or idea you just named. If what you said contradicts a dated claim on file, a receipt appears a couple of seconds later.

Speech-to-text, matching and judging all run on this Mac. Audio is transcribed in memory and discarded. Transcripts live only in the running process.

## Run it

```bash
./bin/hotmic
```

That starts the server and opens http://127.0.0.1:4747. Allow the microphone once. Ctrl-C stops it.

| Key | Does |
|---|---|
| hold Space | talk; release to send |
| `/` | type instead of talking, Return to send |
| Esc | clear the card |
| Shift+R | start a fresh session (every card and receipt can fire again) |

Check the setup at any time:

```bash
bun run doctor
```

## What appears, and when

- **Card (blue).** You named something that has a page. No model call, so it lands in under a second. A page is shown once per 20 minutes; the footer says "already shown" if you name it again sooner. When it does reappear it says when it last came up and what was said.
- **Receipt (red).** You said the opposite of a dated claim held by you or by a named person.
- **Correction (amber).** You got a recorded fact wrong, such as a date.
- **Nothing.** Small talk, questions, agreement, and ordinary words that happen to be names ("a memorable dinner", "down by the river").

A receipt must pass two gates: the statement has to be close in meaning to a stored claim, and the local judge has to say, with at least 75% confidence, that both cannot be true. Each claim fires once per session.

## Where the pages come from

1. **Your brain**, read straight from the markdown in `~/brain`. Read-only.
2. **Packs**, folders of pages inside this project. `packs/demo` holds public, demo-safe pages about the hackathon hosts.

Pages use GBrain's own format, including the takes table, so a pack page can be imported into GBrain later without changes. A brain page wins over a pack page with the same slug.

Never read, whatever the folder: anything under `sources/`, `personal/`, `archive/`, `inbox/` or `prompts/`, and guide or index pages. Only `~/brain` is read, so pages from other GBrain sources (business buckets, the retrieval pilot) cannot appear on a screen someone else is looking at.

To give Hot Mic something to catch you on, add a takes table to any page:

```markdown
<!--- gbrain:takes:begin -->
| # | claim | kind | who | weight | since | source |
|---|-------|------|-----|--------|-------|--------|
| 1 | Seed rounds under $2M are not worth a partner meeting | take | brain | 0.7 | 2026-09-19 | partner offsite |
<!--- gbrain:takes:end -->
```

`who` is `self` (GBrain's holder for the owner) or `brain` for your own view, `people/<slug>` for someone else's, `world` for a plain fact. After editing pages, reload without restarting: Shift+R resets the session, and `POST /api/reload` re-reads the folders.

## Settings

Environment variables, or the same keys in `~/.hotmic/config.json`.

| Variable | Default | Meaning |
|---|---|---|
| `HOTMIC_BRAIN_DIR` | `~/brain` | brain repo to read; `off` to use packs only |
| `HOTMIC_PACKS` | `packs/demo` | comma-separated pack folders; `off` for none |
| `HOTMIC_OWNER` | unset | your `people/<slug>`, so takes filed under your name count as yours |
| `HOTMIC_JUDGE_MODEL` | `llama3` | Ollama model that judges contradictions; `off` disables receipts |
| `HOTMIC_EMBED_MODEL` | `bge-m3` | Ollama embedding model; without it receipts fall back to keyword matching |
| `HOTMIC_COOLDOWN_SEC` | `1200` | how long before the same page can show again |
| `HOTMIC_MIN_CONFIDENCE` | `0.75` | judge confidence needed for a receipt |
| `HOTMIC_MIN_SIMILARITY` | `0.55` | how close a statement must be to a claim before it is judged |
| `HOTMIC_PORT` | `4747` | web port (the speech server uses 4748) |

For daily use without the demo pages, set `HOTMIC_PACKS=off`.

## For the demo

- Press Shift+R between judges.
- Every claim in `packs/demo` has a source column. Two of Garry Tan's are marked as paraphrases from secondary summaries. Find the original posts and correct the wording and dates before you show a receipt that quotes him.
- Receipts should fire on what *you* say. Do not aim one at a judge.
- Ask before you hold the key near someone: California requires everyone's consent to record, and the honest description is "it transcribes while I hold this key and keeps no audio".
- Use a close, directional microphone. The numbers below were measured with clean synthetic speech, not a voice in a hall of 200 people.
- The typed box is the fallback if the room is too loud. It runs the same pipeline.

## Measured on this Mac (M5 Max, 48 GB)

| Step | Time |
|---|---|
| speech-to-text, 3 to 6 second clip | 0.35 to 0.8 s |
| card after you release the key | 0.35 to 0.8 s |
| receipt or correction | 1.8 to 2.4 s |
| first receipt after a cold start | up to 11 s while the judge model loads; Hot Mic warms it at startup |

## How it is built

`bun`, no dependencies. `src/pages.ts` parses pages, `src/library.ts` loads the allowed folders, `src/match.ts` finds names in mangled speech, `src/receipts.ts` does retrieval and judging, `src/engine.ts` applies the one-card and cooldown rules, `src/stt.ts` runs `whisper-server`, `src/server.ts` serves the page and the event stream on 127.0.0.1 only, behind a per-run token.

```bash
bun test
```

## Passive recording from the iPhone

A companion iPhone app records conversations all day, gated by voice, and sends them to this Mac for local transcription. It is separate from the push-to-talk screen above. See [ios/README.md](ios/README.md). The Mac side is:

```bash
./bin/hotmic-ingest
```

It listens on your local network over HTTPS (port 4750, token in `~/.hotmic/ingest-token`), runs only while you have it started, and writes to `~/HotMicArchive`, never to the brain.

## Not built yet

- The push feed inside GBrain itself (`serve --http` server-sent events). Hot Mic is the consumer that GBrain's TODO asks for, but today it reads the markdown directly rather than subscribing to GBrain. That is the pull request to write on the day, once GBrain is on 0.51.
- Writing anything back to the brain. Hot Mic never writes.
- Continuous listening. It is push-to-talk by design.
