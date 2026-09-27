// Page model + parser. Reads GBrain-format markdown: YAML-ish frontmatter,
// a title, a lede, and an optional fenced takes table. The same parser serves
// pages exported from the brain and pages in a local pack directory, so a pack
// can be imported into GBrain later without changes.

export const TAKES_FENCE_BEGIN = "<!--- gbrain:takes:begin -->";
export const TAKES_FENCE_END = "<!--- gbrain:takes:end -->";

export interface Take {
  slug: string; // owning page
  row: number; // stable row number, referenced as slug#N
  claim: string;
  kind: string; // fact | take | bet | hunch
  who: string; // world | brain | people/<slug> | companies/<slug>
  weight?: number;
  since?: string;
  source?: string;
  superseded: boolean;
}

export interface Page {
  slug: string;
  type: string;
  title: string;
  aliases: string[];
  lede: string; // first paragraph, shown on the card
  takes: Take[];
  origin: "brain" | "pack";
  sourceUrl?: string;
}

function parseInlineList(raw: string): string[] {
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner.trim()) return [];
  const out: string[] = [];
  // split on commas that are not inside quotes
  let cur = "";
  let quote: string | null = null;
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === ",") {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

export function parseFrontmatter(md: string): { meta: Record<string, string>; body: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: md };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: md.slice(m[0].length) };
}

function stripMd(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, (_, t) => String(t).split("/").pop()!.replace(/-/g, " "))
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseTakes(slug: string, body: string): Take[] {
  const b = body.indexOf(TAKES_FENCE_BEGIN);
  if (b === -1) return [];
  const e = body.indexOf(TAKES_FENCE_END, b + TAKES_FENCE_BEGIN.length);
  if (e === -1) return [];
  const inner = body.slice(b + TAKES_FENCE_BEGIN.length, e);
  const takes: Take[] = [];
  for (const line of inner.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("|")) continue;
    const cells = t.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 7) continue;
    const row = Number(cells[0]);
    if (!Number.isInteger(row)) continue; // header and separator rows
    const rawClaim = cells[1];
    const superseded = /^~~.*~~$/.test(rawClaim);
    const weight = Number(cells[4]);
    takes.push({
      slug,
      row,
      claim: stripMd(rawClaim.replace(/~~/g, "")),
      kind: cells[2] || "take",
      who: cells[3] || "brain",
      weight: Number.isFinite(weight) ? weight : undefined,
      since: cells[5] || undefined,
      source: cells[6] || undefined,
      superseded,
    });
  }
  return takes;
}

export function parsePage(slug: string, md: string, origin: "brain" | "pack"): Page {
  const { meta, body } = parseFrontmatter(md);
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const fallbackTitle = slug.split("/").pop()!.replace(/-/g, " ");
  const title = stripMd(meta.title?.replace(/^["']|["']$/g, "") || titleMatch?.[1] || fallbackTitle);

  // lede: first non-heading, non-fence paragraph after the title
  let lede = "";
  const afterTitle = titleMatch ? body.slice(body.indexOf(titleMatch[0]) + titleMatch[0].length) : body;
  for (const para of afterTitle.split(/\r?\n\s*\r?\n/)) {
    const p = para.trim();
    if (!p || p.startsWith("#") || p.startsWith("<!--") || p.startsWith("|") || p.startsWith("---")) continue;
    lede = stripMd(p);
    break;
  }
  if (lede.length > 260) lede = lede.slice(0, 257).replace(/\s+\S*$/, "") + "...";

  return {
    slug,
    type: meta.type || slug.split("/")[0] || "page",
    title,
    aliases: parseInlineList(meta.aliases || ""),
    lede,
    takes: parseTakes(slug, body),
    origin,
    sourceUrl: meta.source_url?.replace(/^["']|["']$/g, "") || undefined,
  };
}
