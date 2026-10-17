import { describe, expect, it } from "vitest";
import { DEFAULT_JSON_BODY_BYTES, JsonBodyError, parseJsonCapped } from "../lib/server/json-body";

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
