import { describe, expect, it } from "vitest";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";
import nextConfig from "../next.config";

/**
 * BR-S-007: every app page carries frame protection, nosniff, a Referrer-Policy
 * and a Permissions-Policy on Vercel too (deploy/Caddyfile adds them only on the
 * self-hosted box). Header resolution mirrors Next: every rule whose source
 * matches applies, in order, and a later rule's key overrides an earlier one.
 */
async function headersFor(pathname: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? [];
  const out: Record<string, string> = {};
  for (const rule of rules) {
    if (!getPathMatch(rule.source)(pathname)) continue;
    for (const h of rule.headers) out[h.key.toLowerCase()] = h.value;
  }
  return out;
}

const APP_PATHS = [
  "/",
  "/all-channels/videos",
  "/chronos/approvals",
  "/login",
  "/pricing",
  "/api/credits/estimate",
  "/api/v1/videos",
];

describe("security headers (BR-S-007)", () => {
  it.each(APP_PATHS)("frames, sniffs and leaks nothing on %s", async (path) => {
    const h = await headersFor(path);
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(h["permissions-policy"]).toMatch(/camera=\(\), microphone=\(\), geolocation=\(\)/);
    // Payment is delegated to Paddle's checkout frame only, never to `*`.
    expect(h["permissions-policy"]).toContain('payment=("https://buy.paddle.com" "https://sandbox-buy.paddle.com")');
    expect(h["permissions-policy"]).not.toContain("*");
  });

  it("keeps the stricter sign-in headers on /auth", async () => {
    const h = await headersFor("/auth/callback");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(h["referrer-policy"]).toBe("no-referrer");
    expect(h["cache-control"]).toBe("no-store");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  it("never sets a key the media file route sets more strictly itself", async () => {
    // The route answers with `default-src 'none'; sandbox` and no-referrer. A
    // config header for the same key could replace them, so none is sent.
    const h = await headersFor("/api/media/file/abc/original");
    expect(h["content-security-policy"]).toBeUndefined();
    expect(h["referrer-policy"]).toBeUndefined();
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
  });

  it("sets no content policy beyond frame-ancestors here (the per-request one is middleware's, tests/csp.test.ts)", async () => {
    const rules = (await nextConfig.headers?.()) ?? [];
    for (const rule of rules) {
      for (const h of rule.headers) {
        if (h.key.toLowerCase() === "content-security-policy") expect(h.value).toBe("frame-ancestors 'none'");
      }
    }
  });

  it("does not advertise the framework", () => {
    expect(nextConfig.poweredByHeader).toBe(false);
  });
});
