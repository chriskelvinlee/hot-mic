// Serves the built Chief of Staff demo offline: bun cos/serve.ts, then http://127.0.0.1:4757
// Sample transcripts to try the upload with are at /samples/<file name>.
import { join, basename } from "node:path";

const page = join(import.meta.dir, "dist", "index.html");
const samples = join(import.meta.dir, "samples");
const port = Number(process.env.COS_PORT ?? 4757);
Bun.serve({
  hostname: "127.0.0.1",
  port,
  // open the file per request: a Bun.file made once keeps its first size and truncates a rebuilt page
  fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (path.startsWith("/samples/")) {
      const file = Bun.file(join(samples, basename(decodeURIComponent(path))));
      return (await file.exists())
        ? new Response(await file.arrayBuffer(), { headers: { "content-type": "text/plain; charset=utf-8" } })
        : new Response("No such sample", { status: 404 });
    }
    const file = Bun.file(page);
    return (await file.exists())
      ? new Response(await file.arrayBuffer(), { headers: { "content-type": "text/html; charset=utf-8" } })
      : new Response("Not built yet: run bun cos/build.ts", { status: 404 });
  },
});
console.log(`Chief of Staff demo on http://127.0.0.1:${port}`);
