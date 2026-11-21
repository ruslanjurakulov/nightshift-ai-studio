import { beforeEach, describe, expect, it, vi } from "vitest";

/** A GitHub call that times out or drops is "github_unavailable" (the code a 5xx maps to), not a raw abort error. */
vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/server/fetch-timeout", () => ({ fetchWithTimeout: (...a: unknown[]) => h.fetch(...a) }));

vi.stubEnv("GITHUB_SECRETS_TOKEN", "t");
vi.stubEnv("GITHUB_SECRETS_REPO", "o/r");
const secrets = await import("../lib/server/github-secrets");
const variables = await import("../lib/server/github-variables");

beforeEach(() => {
  h.fetch.mockReset();
});

describe("github timeouts", () => {
  it("secrets: a timeout is github_unavailable", async () => {
    h.fetch.mockRejectedValue(new DOMException("The operation timed out", "TimeoutError"));
    await expect(secrets.listConfiguredSecretNames()).rejects.toThrow("github_unavailable");
  });
  it("variables: a dropped connection is github_unavailable", async () => {
    h.fetch.mockRejectedValue(new TypeError("fetch failed"));
    await expect(variables.readVariables()).rejects.toThrow("github_unavailable");
  });
});
