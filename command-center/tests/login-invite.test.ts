import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { INVITE_JOIN_TIMEOUT_MS, retryInviteJoin } from "@/lib/friend-invites";

/**
 * A friend's invite cookie that the confirmation callback could not use (its join failed and was kept, since 0165) is tried
 * again after a password sign-in. What would break without these: a friend who signs in with a password after a failed join
 * never counting; the sign-in waiting on (or failing with) the join; the retry going anywhere but our own join route.
 */
describe("retrying a kept invite cookie after a password sign-in", () => {
  it("POSTs our own join route with a bounded signal", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    await retryInviteJoin(fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/invite/join");
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(INVITE_JOIN_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });

  it("never throws, whatever the network does", async () => {
    await expect(retryInviteJoin(vi.fn().mockRejectedValue(new Error("offline")) as unknown as typeof fetch)).resolves.toBeUndefined();
    await expect(retryInviteJoin((() => { throw new Error("no fetch"); }) as unknown as typeof fetch)).resolves.toBeUndefined();
  });

  it("the login page starts it only after a successful sign-in, and does not wait for it", () => {
    const src = readFileSync(path.join(process.cwd(), "app/login/page.tsx"), "utf8");
    const signIn = src.indexOf("signInWithPassword(");
    const failed = src.indexOf("if (error) {", signIn);
    const retry = src.indexOf("void retryInviteJoin();");
    expect(signIn).toBeGreaterThan(0);
    expect(retry).toBeGreaterThan(failed);
    expect(src).not.toMatch(/await retryInviteJoin/);
  });
});
