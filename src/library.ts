// Loads the pages Hot Mic is allowed to show. Read-only, always.
//
// Two inputs:
//   - the personal brain repo (markdown on disk, default ~/brain), which is
//     GBrain's source of truth
//   - pack directories inside this project (demo-safe public pages)
//
// Ownership boundary: only the directories named here are read. Other GBrain
// sources (business buckets, the retrieval pilot) live elsewhere and are never
// loaded, so they cannot appear on a screen someone else is looking at.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parsePage, type Page, type Take } from "./pages";

// Never descend into these, whatever the root.
const SKIP_DIRS = new Set([".git", ".obsidian", "node_modules", "sources", "archive", "inbox", "prompts", "personal"]);
// Page types that are documentation or plumbing, not things people talk about.
const SKIP_TYPES = new Set(["guide", "schema", "index", "log", "prompt", "resolver"]);
const SKIP_FILES = new Set(["index.md", "log.md", "schema.md", "resolver.md", "readme.md"]);

function walk(root: string, dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name.toLowerCase())) walk(root, full, out);
    } else if (name.toLowerCase().endsWith(".md") && !SKIP_FILES.has(name.toLowerCase())) {
      out.push(full);
    }
  }
}

export function loadDir(root: string, origin: "brain" | "pack"): Page[] {
  if (!root || !existsSync(root)) return [];
  const files: string[] = [];
  walk(root, root, files);
  const pages: Page[] = [];
  for (const file of files) {
    try {
      const slug = relative(root, file).split(sep).join("/").replace(/\.md$/i, "");
      const page = parsePage(slug, readFileSync(file, "utf8"), origin);
      if (SKIP_TYPES.has(page.type.toLowerCase())) continue;
      pages.push(page);
    } catch {
      // an unreadable page is skipped, never fatal
    }
  }
  return pages;
}

export interface Library {
  pages: Page[];
  takes: Take[];
  counts: { brain: number; pack: number; takes: number };
}

export function loadLibrary(brainDir: string | null, packDirs: string[]): Library {
  const bySlug = new Map<string, Page>();
  // packs first, so a real brain page with the same slug wins
  for (const dir of packDirs) for (const p of loadDir(dir, "pack")) bySlug.set(p.slug, p);
  if (brainDir) for (const p of loadDir(brainDir, "brain")) bySlug.set(p.slug, p);
  const pages = [...bySlug.values()];
  const takes = pages.flatMap((p) => p.takes);
  return {
    pages,
    takes,
    counts: {
      brain: pages.filter((p) => p.origin === "brain").length,
      pack: pages.filter((p) => p.origin === "pack").length,
      takes: takes.length,
    },
  };
}
