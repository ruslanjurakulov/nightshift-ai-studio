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

type Capped = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "bad" };

async function readCapped(request: Request, maxBytes: number): Promise<Capped> {
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
  return { ok: true, bytes };
}

/**
 * The body's bytes under the same hard cap, or null when it is over `maxBytes` (a declared length over it is refused
 * before a byte is read), absent, or the stream broke. For a body that is not JSON, such as a small form.
 */
export async function readBytesCapped(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const read = await readCapped(request, maxBytes);
  return read.ok ? read.bytes : null;
}

export async function readJsonBodyCapped(
  request: Request,
  maxBytes: number,
): Promise<CappedBody> {
  const read = await readCapped(request, maxBytes);
  if (!read.ok) return read;
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(read.bytes)) };
  } catch {
    return { ok: false, reason: "bad" };
  }
}

/** The cap for a route that does not name its own: a form, a few ids, a title, a short prompt. */
export const DEFAULT_JSON_BODY_BYTES = 65_536;
/** A saved workflow graph (steps and their settings) is the largest document a customer posts. */
export const LARGE_JSON_BODY_BYTES = 262_144;

/** A body that was too large, or was not JSON. Routes catch it exactly where they caught `request.json()`. */
export class JsonBodyError extends Error {
  constructor(readonly reason: "too_large" | "bad") {
    super(reason === "too_large" ? "payload_too_large" : "bad_json");
    this.name = "JsonBodyError";
  }
}

/**
 * A drop-in for `await request.json()` with a hard byte cap (BR-S-019): it
 * throws instead of returning, so a route keeps the try/catch it already has
 * (a malformed body is its 400), and nothing past `maxBytes` is ever buffered.
 */
// `any`, like `request.json()` itself: the routes narrow the document themselves, field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function parseJsonCapped(request: Request, maxBytes: number = DEFAULT_JSON_BODY_BYTES): Promise<any> {
  const read = await readJsonBodyCapped(request, maxBytes);
  if (!read.ok) throw new JsonBodyError(read.reason);
  return read.value;
}
