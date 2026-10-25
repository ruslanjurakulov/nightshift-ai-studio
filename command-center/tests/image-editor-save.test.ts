/**
 * Saving goes through the EXISTING upload ticket and nothing else.
 * What would break without these: a save that overwrites the original, a name that carries a path, an upload sent to
 * some URL the ticket route did not hand out, a refusal worded as success, an exception escaping into the page, two
 * requests for one press.
 */
import { describe, expect, it, vi } from "vitest";
import { JPEG_QUALITY, SAVE_ERRORS, editedName, saveErrorCode, uploadEdited } from "../lib/imageEditor/save";

const TICKET = "55555555-5555-4555-8555-555555555555";
const ORG = "11111111-1111-4111-8111-111111111111";
const blob = (n = 10) => new Blob([new Uint8Array(n)], { type: "image/png" });
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

describe("editedName", () => {
  it("is always a NEW name: the original's stem plus -edited and the saved type's extension", () => {
    expect(editedName("holiday.photo.JPG", "png")).toBe("holiday.photo-edited.png");
    expect(editedName("cat.png", "jpeg")).toBe("cat-edited.jpg");
    expect(editedName("cat-edited.png", "png")).toBe("cat-edited.png");
  });

  it("uses only the last path segment, drops controls and never returns an empty stem", () => {
    expect(editedName("../../etc/passwd.png", "png")).toBe("passwd-edited.png");
    expect(editedName("a\\b\\c.webp", "png")).toBe("c-edited.png");
    expect(editedName("x\u0000y\n.png", "png")).toBe("xy-edited.png");
    expect(editedName("", "png")).toBe("upload-edited.png");
    expect(editedName(undefined, "jpeg")).toBe("upload-edited.jpg");
    expect(editedName("n".repeat(500) + ".png", "png").length).toBeLessThanOrEqual(140);
  });

  it("keeps the jpeg quality below lossless but high", () => {
    expect(JPEG_QUALITY).toBeGreaterThan(0.8);
    expect(JPEG_QUALITY).toBeLessThan(1);
  });
});

describe("saveErrorCode", () => {
  it("passes the words the upload routes answer and turns the rest into failed", () => {
    for (const code of SAVE_ERRORS) expect(saveErrorCode(code)).toBe(code);
    for (const w of ["quota_exceeded", "too_large", "unauthorized", "ticket_expired", "media_unavailable"]) expect(saveErrorCode(w)).toBe(w);
    for (const junk of ["bad_request", "<script>", "", 5, null, undefined]) expect(saveErrorCode(junk)).toBe("failed");
  });
});

describe("uploadEdited", () => {
  it("asks for a ticket for exactly this file, then PUTs the bytes to the URL the route returned", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === "/api/media/uploads") return json(200, { ok: true, ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}`, name: "cat-edited.png" });
      return json(200, { ok: true });
    });
    const b = blob(1234);
    const res = await uploadEdited({ orgId: ORG, blob: b, filename: "cat-edited.png", mime: "image/png", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ ok: true, ticket: TICKET, name: "cat-edited.png" });
    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ org_id: ORG, filename: "cat-edited.png", mime: "image/png", bytes: 1234 });
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[1].url).toBe(`/api/media/uploads/${TICKET}`);
    expect(calls[1].init?.method).toBe("PUT");
    expect(calls[1].init?.body).toBe(b);
  });

  it("never sends the body when the ticket is refused, and says why (with the limit when there is one)", async () => {
    const fetchImpl = vi.fn(async () => json(413, { error: "too_large", max_bytes: 1000 }));
    const res = await uploadEdited({ orgId: ORG, blob: blob(5000), filename: "a.png", mime: "image/png", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ ok: false, error: "too_large", maxBytes: 1000 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses an upload URL that is not the ticket route's, and an answer without a ticket", async () => {
    for (const body of [
      { ticket: TICKET, upload_url: "https://evil.example/put" },
      { ticket: TICKET, upload_url: "//evil.example/put" },
      { ticket: "not-a-uuid", upload_url: `/api/media/uploads/${TICKET}` },
      {},
    ]) {
      const fetchImpl = vi.fn(async () => json(200, body));
      const res = await uploadEdited({ orgId: ORG, blob: blob(), filename: "a.png", mime: "image/png", fetchImpl: fetchImpl as unknown as typeof fetch });
      expect(res.ok).toBe(false);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("reports a refused PUT with the route's own word", async () => {
    const fetchImpl = vi.fn(async (url: string) =>
      url === "/api/media/uploads" ? json(200, { ticket: TICKET, upload_url: `/api/media/uploads/${TICKET}` }) : json(507, { error: "quota_exceeded" }),
    );
    const res = await uploadEdited({ orgId: ORG, blob: blob(), filename: "a.png", mime: "image/png", fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ ok: false, error: "quota_exceeded", maxBytes: null });
  });

  it("turns a dropped connection into 'network' and an empty file into 'empty' without calling the server", async () => {
    const boom = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await uploadEdited({ orgId: ORG, blob: blob(), filename: "a.png", mime: "image/png", fetchImpl: boom as unknown as typeof fetch })).toEqual({ ok: false, error: "network" });
    const never = vi.fn();
    expect(await uploadEdited({ orgId: ORG, blob: blob(0), filename: "a.png", mime: "image/png", fetchImpl: never as unknown as typeof fetch })).toEqual({ ok: false, error: "empty" });
    expect(never).not.toHaveBeenCalled();
  });
});
