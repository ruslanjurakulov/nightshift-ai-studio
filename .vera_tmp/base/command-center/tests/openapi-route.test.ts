import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/docs/api/openapi.json/route";
import { gateDecision } from "@/lib/public-paths";
import { IMAGE_PROVIDERS, VIDEO_PROVIDERS } from "@/lib/runBackend";

/**
 * PIXEL-5 N1: /docs/api linked "OpenAPI 3.1 spec" at /docs/api/openapi.json,
 * which was public in the gate but had no route — a 404.
 */
afterEach(() => vi.unstubAllEnvs());

describe("GET /docs/api/openapi.json", () => {
  it("serves the OpenAPI 3.1 document, against this deployment's origin", async () => {
    vi.stubEnv("APP_ORIGIN", "https://app.example.test");
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const spec = (await res.json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, unknown> };
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("https://app.example.test/api/v1");
    expect(Object.keys(spec.paths).length).toBeGreaterThan(5);
  });

  it("names no money amount at all (the only prices are the live list on /docs/api)", async () => {
    const text = JSON.stringify(await GET().json());
    // BR-L-133: a summary still carried the seed "x $0.015"; no "$" followed by a figure, anywhere.
    expect(text).not.toMatch(/\$\s?\d/);
    expect(text).not.toMatch(/default prices|\d+(?:\.\d+)?\s?¢/i);
  });

  it("names no provider: the public pages name no vendor, and the server validates the id itself", async () => {
    const values: string[] = [];
    const walk = (v: unknown): void => {
      if (typeof v === "string") values.push(v.toLowerCase());
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") Object.values(v).forEach(walk);
    };
    walk(await GET().json());
    for (const id of [...VIDEO_PROVIDERS, ...IMAGE_PROVIDERS]) expect(values, id).not.toContain(id.toLowerCase());
  });

  it("is public, signed in or out", () => {
    expect(gateDecision("/docs/api/openapi.json", false)).toBe("pass");
  });
});
