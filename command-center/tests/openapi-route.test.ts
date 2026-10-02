import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/docs/api/openapi.json/route";
import { gateDecision } from "@/lib/public-paths";

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

  it("names no price figure (the only prices are the live list on /docs/api)", async () => {
    const text = JSON.stringify(await GET().json());
    expect(text).not.toMatch(/\$\d+\.\d\d per minute|default prices/i);
  });

  it("is public, signed in or out", () => {
    expect(gateDecision("/docs/api/openapi.json", false)).toBe("pass");
  });
});
