import { afterEach, describe, expect, it, vi } from "vitest";

// google-oauth is server-only; the guard is meaningless in the test runner.
vi.mock("server-only", () => ({}));

import { publicOrigin } from "../lib/server/public-origin";
import { redirectUri } from "../lib/server/google-oauth";

// What the standalone server hands a route handler behind Caddy: the bind
// address, not the host the browser used (measured on the deploy/ container).
const BEHIND_PROXY = new Request("https://0.0.0.0:3000/api/oauth/youtube/start?ref=finance");

afterEach(() => {
  delete process.env.APP_ORIGIN;
});

describe("publicOrigin", () => {
  it("uses APP_ORIGIN when set, so Google is never sent a 0.0.0.0 redirect_uri", () => {
    process.env.APP_ORIGIN = "https://app.example.com";
    expect(publicOrigin(BEHIND_PROXY)).toBe("https://app.example.com");
    expect(redirectUri(publicOrigin(BEHIND_PROXY))).toBe(
      "https://app.example.com/api/oauth/youtube/callback",
    );
  });

  it("reduces APP_ORIGIN to an origin (a trailing slash or path would break the exact-match redirect_uri)", () => {
    process.env.APP_ORIGIN = "https://app.example.com/some/path/";
    expect(publicOrigin(BEHIND_PROXY)).toBe("https://app.example.com");
  });

  it("falls back to the request's own origin when unset — Vercel behaves as before", () => {
    const onVercel = new Request("https://monitor.example.com/api/oauth/youtube/start");
    expect(publicOrigin(onVercel)).toBe("https://monitor.example.com");
  });

  it("ignores a malformed or non-http APP_ORIGIN rather than redirecting to it", () => {
    const req = new Request("https://monitor.example.com/x");
    for (const bad of ["app.example.com", "javascript:alert(1)", "   "]) {
      process.env.APP_ORIGIN = bad;
      expect(publicOrigin(req)).toBe("https://monitor.example.com");
    }
  });
});
