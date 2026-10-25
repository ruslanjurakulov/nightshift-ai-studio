import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_KEY_PROVIDERS, type ExpectShape, type ModelKeyProvider } from "../lib/model-keys";
import { redactKey, safeErrorText, verifyKeyWithVendor } from "../lib/server/model-keys";
import { json, startLoopback, type Loopback } from "./helpers/loopbackVendor";

vi.mock("server-only", () => ({}));

/**
 * verifyKeyWithVendor against a fake vendor on 127.0.0.1: no network, no real key, no paid call.
 *
 * What would break without these: a vendor that refused the key read as "verified" (or the reverse), a vendor that is down read as "the key is
 * wrong" (the owner would throw away a good key), a redirect followed with the key attached, a call to a host that is not the vendor's, a
 * vendor with no free check being called anyway, and the key (or what the vendor echoed of it) coming back out of the function.
 */

const KEY = "sk-test-AbCdEf0123456789-wxyz";
const HTTP = MODEL_KEY_PROVIDERS.filter((p): p is ModelKeyProvider & { strategy: { kind: "http" } } => p.strategy.kind === "http");
const HOSTS = HTTP.map((p) => new URL(p.strategy.origin).host);

function okBody(e: ExpectShape): unknown {
  switch (e.kind) {
    case "array":
      return [{ id: "m1" }];
    case "object":
      return { data: [] };
    case "field":
      return { [e.name]: e.type === "array" ? [{ id: "m1" }] : e.type === "number" ? 12.5 : { total: 1 } };
  }
}

let vendor: Loopback;
beforeAll(async () => {
  vendor = await startLoopback(HOSTS);
});
afterAll(async () => {
  await vendor.close();
});
beforeEach(() => {
  vendor.seen.length = 0;
  vendor.asked.length = 0;
});
const verify = (p: ModelKeyProvider, key = KEY, over: { timeoutMs?: number } = {}) => verifyKeyWithVendor(p, key, { fetchImpl: vendor.fetch, ...over });

describe.each(HTTP.map((p) => [p.id, p] as const))("%s", (_id, p) => {
  const s = p.strategy;

  it("asks its vendor's own fixed URL once, with a GET, the key in the documented header only, and nothing in the URL", async () => {
    vendor.answer(json(200, okBody(s.expect)));
    const out = await verify(p);
    expect(out).toEqual({ outcome: "verified" });
    expect(vendor.asked).toEqual([`${s.origin}${s.path}${s.query ? `?${s.query}` : ""}`]);
    expect(vendor.seen).toHaveLength(1);
    const req = vendor.seen[0];
    expect(req.method).toBe("GET");
    expect(req.body).toBe("");
    expect(req.url).toBe(`${s.path}${s.query ? `?${s.query}` : ""}`);
    expect(vendor.asked[0]).not.toContain(KEY);
    const sent = req.headers[s.auth.header.toLowerCase()];
    expect(sent).toBe(s.auth.scheme === "bearer" ? `Bearer ${KEY}` : KEY);
    for (const [k, v] of Object.entries(s.headers)) expect(req.headers[k.toLowerCase()]).toBe(v);
    // the key is in exactly one header and nowhere else in what was sent
    const elsewhere = Object.entries(req.headers).filter(([k, v]) => k !== s.auth.header.toLowerCase() && String(v).includes(KEY));
    expect(elsewhere).toEqual([]);
  });

  it.each(s.rejectStatuses)("the vendor answering %i is a rejected key, and nothing is judged from the body", async (status) => {
    vendor.answer(json(status, { error: { message: `Incorrect API key provided: ${KEY}` } }));
    const out = await verify(p);
    expect(out).toEqual({ outcome: "rejected" });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });

  it("a 200 that is not the documented shape is not verified", async () => {
    for (const body of ["<html>sign in</html>", "not json", "null", "[]", '"ok"', "{}", '{"unrelated": true}']) {
      vendor.answer(json(200, body));
      const out = await verify(p);
      // `[]` and `{}` are the documented shape for an array / bare-object vendor, which is a vendor with nothing listed: still a 200 answer.
      const shapeOk = (s.expect.kind === "array" && body === "[]") || (s.expect.kind === "object" && (body === "{}" || body === '{"unrelated": true}'));
      expect(out.outcome, `${p.id} ${body}`).toBe(shapeOk ? "verified" : "could_not_reach");
    }
  });

  it.each([
    [429, "rate_limited"],
    [500, "vendor_error"],
    [502, "vendor_error"],
    [503, "vendor_error"],
    [404, "unexpected_response"],
    [418, "unexpected_response"],
  ])("a %i is 'could not reach' (%s), never a verdict on the key", async (status, reason) => {
    if (s.rejectStatuses.includes(status)) return;
    vendor.answer(json(status, { error: "x" }));
    expect(await verify(p)).toEqual({ outcome: "could_not_reach", reason });
  });
});

describe("the other ways a check can end", () => {
  const openai = HTTP.find((p) => p.id === "openai") as (typeof HTTP)[number];

  it("a vendor that does not answer in time is 'could not reach' (timeout), after the short timeout", async () => {
    vendor.answer(() => {
      /* never answers */
    });
    const t0 = Date.now();
    const out = await verify(openai, KEY, { timeoutMs: 150 });
    expect(out).toEqual({ outcome: "could_not_reach", reason: "timeout" });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("a vendor that drops the connection is 'could not reach' (network)", async () => {
    vendor.answer((_req, res) => res.socket?.destroy());
    expect(await verify(openai)).toEqual({ outcome: "could_not_reach", reason: "network" });
  });

  it("a vendor that cannot be connected to is 'could not reach' (network), not a rejection", async () => {
    const dead = (() => Promise.reject(new TypeError("fetch failed"))) as unknown as typeof fetch;
    expect(await verifyKeyWithVendor(openai, KEY, { fetchImpl: dead })).toEqual({ outcome: "could_not_reach", reason: "network" });
  });

  it("a redirect is never followed: the target is not contacted and the key does not go there", async () => {
    vendor.answer((_req, res) => {
      res.writeHead(302, { location: "https://evil.example/steal" });
      res.end();
    });
    const out = await verify(openai);
    expect(out).toEqual({ outcome: "could_not_reach", reason: "redirect" });
    expect(vendor.asked).toEqual(["https://api.openai.com/v1/models"]);
    expect(vendor.seen).toHaveLength(1);
  });

  it("an answer longer than the cap is not read to the end and is not verified", async () => {
    vendor.answer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write('{"data":[');
      const chunk = '{"id":"' + "x".repeat(60_000) + '"},';
      for (let i = 0; i < 40; i += 1) res.write(chunk);
      res.end("{}]}");
    });
    expect(await verify(openai)).toEqual({ outcome: "could_not_reach", reason: "unexpected_response" });
  });

  it("an answer that breaks half way is 'could not reach'", async () => {
    vendor.answer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json", "content-length": "500" });
      res.write('{"data":[');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    const out = await verify(openai);
    expect(out.outcome).toBe("could_not_reach");
  });

  it("whatever the vendor echoes of the key never comes back out", async () => {
    vendor.answer(json(401, { error: `bad key ${KEY}`, key: KEY }, { "x-echo": KEY }));
    const out = await verify(openai);
    expect(JSON.stringify(out)).not.toContain(KEY);
    expect(JSON.stringify(out)).not.toContain("wxyz");
  });
});

describe("a vendor with no free check", () => {
  for (const id of ["kling", "bytedance", "lightricks", "vidu"]) {
    it(`${id}: the key is never sent anywhere`, async () => {
      const p = MODEL_KEY_PROVIDERS.find((x) => x.id === id) as ModelKeyProvider;
      const boom = vi.fn(() => {
        throw new Error("a request was made");
      }) as unknown as typeof fetch;
      expect(await verifyKeyWithVendor(p, "AKaaaaaaaaaaaa:SKbbbbbbbbbbbbbb", { fetchImpl: boom })).toEqual({ outcome: "format_only" });
      expect(boom).not.toHaveBeenCalled();
      // not through the global fetch either
      const spy = vi.spyOn(globalThis, "fetch");
      await verifyKeyWithVendor(p, "AKaaaaaaaaaaaa:SKbbbbbbbbbbbbbb");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  }
});

describe("the host is the registry's", () => {
  it("a registry path that tries to change the host is refused before any call", async () => {
    const evil = {
      ...HTTP[0],
      strategy: { ...HTTP[0].strategy, path: "//evil.example/v1/models" },
    } as ModelKeyProvider;
    const spy = vi.fn() as unknown as typeof fetch;
    const out = await verifyKeyWithVendor(evil, KEY, { fetchImpl: spy });
    expect(out.outcome).toBe("could_not_reach");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("redaction", () => {
  it("takes the whole key, and each part of a paired key, out of a text", () => {
    expect(redactKey(`failed with ${KEY} in the header`, KEY)).toBe("failed with [redacted] in the header");
    const pair = "AKaaaaaaaaaaaa:SKbbbbbbbbbbbbbb";
    const out = redactKey(`a=AKaaaaaaaaaaaa b=SKbbbbbbbbbbbbbb c=${pair}`, pair);
    expect(out).not.toContain("AKaaaaaaaaaaaa");
    expect(out).not.toContain("SKbbbbbbbbbbbbbb");
  });

  it("makes an error's text safe to log", () => {
    const err = new Error(`request failed: Authorization: Bearer ${KEY}`);
    const text = safeErrorText(err, KEY);
    expect(text).not.toContain(KEY);
    expect(text).toContain("Error");
    expect(safeErrorText("not an error", KEY)).toBe("error: ");
  });
});
