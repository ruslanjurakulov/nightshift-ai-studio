import { describe, expect, it } from "vitest";
import { DEFAULT_JSON_BODY_BYTES, JsonBodyError, parseJsonCapped, readBytesCapped, readJsonBodyCapped } from "../lib/server/json-body";

/** A drop-in for request.json() with a byte cap (BR-S-019). */
const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://x/api", { method: "POST", headers, body, duplex: "half" } as RequestInit);

describe("parseJsonCapped", () => {
  it("parses an ordinary body exactly like request.json()", async () => {
    expect(await parseJsonCapped(post(JSON.stringify({ a: 1, b: ["x"] })))).toEqual({ a: 1, b: ["x"] });
  });
  it("throws JsonBodyError('too_large') over the cap, by declared length and by stream, and never parses it", async () => {
    const big = JSON.stringify({ pad: "x".repeat(DEFAULT_JSON_BODY_BYTES) });
    await expect(parseJsonCapped(post(big))).rejects.toMatchObject({ name: "JsonBodyError", reason: "too_large" });
    const lying = new Request("http://x/api", { method: "POST", headers: { "content-length": "5" }, body: big });
    await expect(parseJsonCapped(lying)).rejects.toBeInstanceOf(JsonBodyError);
  });
  it("honours a per-route cap", async () => {
    const body = JSON.stringify({ pad: "x".repeat(100_000) });
    await expect(parseJsonCapped(post(body))).rejects.toMatchObject({ reason: "too_large" });
    expect(((await parseJsonCapped(post(body), 200_000)) as { pad: string }).pad.length).toBe(100_000);
  });
  it("not JSON and no body throw 'bad', like request.json() threw", async () => {
    await expect(parseJsonCapped(post("{nope"))).rejects.toMatchObject({ reason: "bad" });
    await expect(parseJsonCapped(new Request("http://x/api", { method: "POST" }))).rejects.toMatchObject({ reason: "bad" });
  });
});

describe("the early refusal by declared length", () => {
  it("a Content-Length over the cap is refused before the body is touched (no reader taken, bodyUsed false)", async () => {
    const req = new Request("http://x/api", { method: "POST", headers: { "content-length": "5000" }, body: "{}" });
    expect(await readJsonBodyCapped(req, 1000)).toEqual({ ok: false, reason: "too_large" });
    expect(req.bodyUsed).toBe(false);
    expect(req.body?.locked).toBe(false);
    const again = new Request("http://x/api", { method: "POST", headers: { "content-length": "5000" }, body: "{}" });
    expect(await readBytesCapped(again, 1000)).toBeNull();
    expect(again.body?.locked).toBe(false);
  });
  it("a Content-Length at the cap is read", async () => {
    const req = new Request("http://x/api", { method: "POST", headers: { "content-length": "1000" }, body: '{"a":1}' });
    expect(await readJsonBodyCapped(req, 1000)).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe("readBytesCapped", () => {
  it("returns the bytes of a body under the cap, exactly", async () => {
    const bytes = await readBytesCapped(post("a=1&b=%D0%AF "), 100);
    expect(new TextDecoder().decode(bytes!)).toBe("a=1&b=%D0%AF ");
  });
  it("is null over the cap by stream, for no body, and for a broken stream", async () => {
    expect(await readBytesCapped(post("x".repeat(500)), 100)).toBeNull();
    expect(await readBytesCapped(new Request("http://x/api", { method: "POST" }), 100)).toBeNull();
  });
});
