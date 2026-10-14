/**
 * A request's JSON body, read with a hard byte cap.
 *
 * `request.json()` buffers the whole body before anyone looks at its size, and
 * a chunked upload sends no Content-Length to check, so a header-only guard is
 * no guard. This reads the stream in pieces, gives up (and cancels the
 * upload) the moment the running total passes `maxBytes`, and parses only
 * what fit. A declared length over the cap is refused before a byte is read.
 */

export type CappedBody =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too_large" | "bad" };

/** The cap for routes whose body is a few ids and a title. */
export const SMALL_BODY_BYTES = 16_384;

export async function readJsonBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<CappedBody> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, reason: "too_large" };
  const stream = request.body;
  if (!stream) return { ok: false, reason: "bad" };
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: "too_large" };
      }
      parts.push(value);
    }
  } catch {
    // The client went away or the stream broke: not a document.
    return { ok: false, reason: "bad" };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { ok: false, reason: "bad" };
  }
}
