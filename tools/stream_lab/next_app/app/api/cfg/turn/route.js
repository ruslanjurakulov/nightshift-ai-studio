// Lab-only (tools/stream_lab): next.config.mjs adds the two stream headers for this path. With ?cc=1 the route also sends its
// own `Cache-Control: no-store`, as every /api/brain answer does (lib/server/brain/session.ts NO_STORE), to see which one wins.
import { labStream } from "../../../../lib.mjs";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const s = labStream(request.url);
  const headers = { "Content-Type": s.type };
  if (new URL(request.url).searchParams.get("cc") === "1") headers["Cache-Control"] = "no-store";
  return new Response(s.body, { headers });
}
