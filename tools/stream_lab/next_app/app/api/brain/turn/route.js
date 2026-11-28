// Lab-only (tools/stream_lab), never part of command-center: the route sets the two stream
// headers itself when ?h=1, so their effect on `next start` is measured on its own.
import { labStream } from "../../../../lib.mjs";

export const dynamic = "force-dynamic";

export async function POST(request) {
  const s = labStream(request.url);
  const headers = { "Content-Type": s.type };
  if (s.routeHeaders) {
    headers["Cache-Control"] = "no-transform";
    headers["X-Accel-Buffering"] = "no";
  }
  return new Response(s.body, { headers });
}
