import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const store = await import("../lib/server/connect-pending");

const grant = {
  platform: "tiktok" as const,
  accessToken: "act.secret",
  refreshToken: "rft.secret",
  accessExpiresIn: 86400,
  refreshExpiresIn: 31536000,
  scopes: ["user.info.basic"],
  profile: { externalId: "oid", username: null, displayName: "Brand", avatarUrl: null },
};
const ORG = "3f2b8c1e-8d4a-4b7e-9a51-0c2d6e7f8a90";
const OTHER_ORG = "11111111-2222-4333-8444-555555555555";
const T0 = 1_000_000;

beforeEach(() => {
  for (const u of ["u1", "u2", "u3"]) store.dropUserPending(u);
});

describe("the held authorisation", () => {
  it("is read back for the same user in the same organization", () => {
    const h = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    expect(store.readPending(h, { userId: "u1", orgId: ORG }, T0 + 1)?.grant).toBe(grant);
  });
  it("is invisible to another user holding the handle, and to the same user in another organization", () => {
    const h = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    expect(store.readPending(h, { userId: "u2", orgId: ORG }, T0 + 1)).toBeNull();
    expect(store.readPending(h, { userId: "u1", orgId: OTHER_ORG }, T0 + 1)).toBeNull();
    expect(store.readPending(h, { userId: "u1", orgId: null }, T0 + 1)).toBeNull();
  });
  it("expires after ten minutes and is gone, not merely hidden", () => {
    const h = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    expect(store.readPending(h, { userId: "u1", orgId: ORG }, T0 + store.PENDING_TTL_MS - 1)).not.toBeNull();
    expect(store.readPending(h, { userId: "u1", orgId: ORG }, T0 + store.PENDING_TTL_MS)).toBeNull();
    expect(store.pendingCount()).toBe(0);
  });
  it("is single use: a finished confirm consumes it", () => {
    const h = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    expect(store.claimPending(h, { userId: "u1", orgId: ORG }, T0 + 1)).not.toBeNull();
    store.finishPending(h);
    expect(store.claimPending(h, { userId: "u1", orgId: ORG }, T0 + 2)).toBeNull();
  });
  it("cannot be confirmed twice at once, and a released failure can be tried again", () => {
    const h = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    expect(store.claimPending(h, { userId: "u1", orgId: ORG }, T0 + 1)).not.toBeNull();
    expect(store.claimPending(h, { userId: "u1", orgId: ORG }, T0 + 2)).toBeNull();
    store.releasePending(h);
    expect(store.claimPending(h, { userId: "u1", orgId: ORG }, T0 + 3)).not.toBeNull();
  });
  it("keeps one per user: a fresh connect drops the earlier token", () => {
    const first = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    const second = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 + 1 });
    expect(store.readPending(first, { userId: "u1", orgId: ORG }, T0 + 2)).toBeNull();
    expect(store.readPending(second, { userId: "u1", orgId: ORG }, T0 + 2)).not.toBeNull();
  });
  it("refuses a handle that is not one it issued, without a lookup", () => {
    for (const bad of ["", "short", "x".repeat(43), "../../etc", undefined, null])
      expect(store.readPending(bad as string, { userId: "u1", orgId: ORG })).toBeNull();
  });
  it("is bounded: it never holds more than its cap, oldest first", () => {
    const handles = Array.from({ length: 230 }, (_, i) =>
      store.createPending({ userId: `bulk-${i}`, orgId: ORG, grant, now: T0 + i }),
    );
    expect(store.pendingCount()).toBeLessThanOrEqual(200);
    expect(store.readPending(handles[0], { userId: "bulk-0", orgId: ORG }, T0 + 300)).toBeNull();
    expect(store.readPending(handles[229], { userId: "bulk-229", orgId: ORG }, T0 + 300)).not.toBeNull();
    for (let i = 0; i < 230; i++) store.dropUserPending(`bulk-${i}`);
  });
  it("hands out a handle that carries nothing of the grant", () => {
    const h = store.createPending({ userId: "u1", orgId: ORG, grant, now: T0 });
    expect(h).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h).not.toMatch(/act\.secret|rft\.secret/);
  });
  it("reads the handle from the Cookie header by exact name", () => {
    const req = new Request("https://x.test/", { headers: { cookie: `a=1; ${store.PENDING_COOKIE}=HANDLE; ${store.PENDING_COOKIE}2=bad` } });
    expect(store.pendingHandleFrom(req)).toBe("HANDLE");
    expect(store.pendingCookieOptions).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", maxAge: 600 });
  });
});
