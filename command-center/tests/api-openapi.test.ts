import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openApiSpec } from "@/lib/api/openapi";

vi.mock("server-only", () => ({}));

describe("OpenAPI spec", () => {
  const spec = openApiSpec("https://nightshift.test") as {
    openapi: string;
    servers: { url: string }[];
    paths: Record<string, Record<string, unknown>>;
  };

  it("is 3.1 and points at /api/v1", () => {
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.servers[0].url).toBe("https://nightshift.test/api/v1");
  });

  it("documents only endpoints that exist, with the methods they export", async () => {
    for (const [path, ops] of Object.entries(spec.paths)) {
      const dir = join(__dirname, "..", "app", "api", "v1", ...path.split("/").filter(Boolean).map((s) => s.replace(/^\{(\w+)\}$/, "[$1]")));
      const file = join(dir, "route.ts");
      expect(existsSync(file), file).toBe(true);
      const mod = (await import(file)) as Record<string, unknown>;
      for (const method of Object.keys(ops)) expect(typeof mod[method.toUpperCase()], `${method} ${path}`).toBe("function");
    }
  });
});
