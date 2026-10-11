import { describe, expect, it, vi } from "vitest";
import {
  RECOVERY_MAX_AGE_SECONDS,
  RESEND_COOLDOWN_SECONDS,
  cooldownLeft,
  decodeRecovery,
  encodeRecovery,
  isRecoveryNotice,
  recoveryCookieOptions,
  recoveryMatches,
  recoveryRedirectTo,
  requestPasswordReset,
  type RecoveryClient,
} from "@/lib/recovery";
import { gateDecision, isPublicPath, RESERVED_ROOT_SEGMENTS } from "@/lib/public-paths";

const UID = "6f1c7a4e-2b3d-4e5f-8a9b-0c1d2e3f4a5b";

describe("requestPasswordReset: one answer, whatever the provider says", () => {
  const origin = "https://nightshift.test";
  const make = (impl: () => Promise<{ error: unknown }>) => {
    const resetPasswordForEmail = vi.fn(impl);
    return { client: { auth: { resetPasswordForEmail } } as RecoveryClient, resetPasswordForEmail };
  };

  it("asks for a link that lands on /auth/callback and then /reset-password", async () => {
    const { client, resetPasswordForEmail } = make(async () => ({ error: null }));
    expect(await requestPasswordReset(client, "  ana@example.com ", origin)).toBe("sent");
    expect(resetPasswordForEmail).toHaveBeenCalledWith("ana@example.com", {
      redirectTo: "https://nightshift.test/auth/callback?next=%2Freset-password",
    });
    expect(recoveryRedirectTo(origin)).toBe("https://nightshift.test/auth/callback?next=%2Freset-password");
  });

  it("is 'sent' for a known address, an unknown one, a rate limit, a provider error and a thrown error", async () => {
    const answers: Array<() => Promise<{ error: unknown }>> = [
      async () => ({ error: null }),
      async () => ({ error: { code: "user_not_found", status: 400, message: "User not found" } }),
      async () => ({ error: { code: "over_email_send_rate_limit", status: 429, message: "email rate limit exceeded" } }),
      async () => ({ error: { status: 500, message: "boom" } }),
      async () => {
        throw new Error("network down");
      },
    ];
    const outcomes = [];
    for (const answer of answers) outcomes.push(await requestPasswordReset(make(answer).client, "ana@example.com", origin));
    expect(outcomes).toEqual(["sent", "sent", "sent", "sent", "sent"]);
  });

  it("only a malformed address is told apart, and nothing is sent for it", async () => {
    const { client, resetPasswordForEmail } = make(async () => ({ error: null }));
    for (const bad of ["", "ana", "ana@", "a b@c.de", "@x.io"]) expect(await requestPasswordReset(client, bad, origin)).toBe("invalid_email");
    expect(resetPasswordForEmail).not.toHaveBeenCalled();
  });

  it("without a backend nothing is sent", async () => {
    expect(await requestPasswordReset(null, "ana@example.com", origin)).toBe("unavailable");
  });
});

describe("the recovery marker", () => {
  const now = 1_800_000_000;
  it("round-trips and is bound to the account", () => {
    const m = decodeRecovery(encodeRecovery({ uid: UID, iat: now }), now + 10);
    expect(m).toEqual({ uid: UID, iat: now });
    expect(recoveryMatches(m, UID)).toBe(true);
    expect(recoveryMatches(m, "00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(recoveryMatches(null, UID)).toBe(false);
    expect(recoveryMatches(m, null)).toBe(false);
  });
  it("expires, and is not accepted from the future or when malformed", () => {
    const v = encodeRecovery({ uid: UID, iat: now });
    expect(decodeRecovery(v, now + RECOVERY_MAX_AGE_SECONDS + 1)).toBeNull();
    expect(decodeRecovery(v, now - 120)).toBeNull();
    for (const bad of [undefined, null, "", "x", `${UID}.abc`, `${UID}`, `not-a-uid.${now}`, "a".repeat(200)]) expect(decodeRecovery(bad, now)).toBeNull();
  });
  it("lives on /reset-password only, never in script's reach", () => {
    expect(recoveryCookieOptions()).toMatchObject({ path: "/reset-password", httpOnly: true, sameSite: "lax", maxAge: RECOVERY_MAX_AGE_SECONDS });
    expect(recoveryCookieOptions(0).maxAge).toBe(0);
  });
});

describe("notices and the resend cooldown", () => {
  it("accepts a closed set of notice codes", () => {
    expect(isRecoveryNotice("expired")).toBe(true);
    expect(isRecoveryNotice("needs_link")).toBe(true);
    for (const v of ["", null, undefined, "<script>", "link_invalid"]) expect(isRecoveryNotice(v)).toBe(false);
  });
  it("counts the 60 seconds down in whole seconds", () => {
    expect(RESEND_COOLDOWN_SECONDS).toBe(60);
    expect(cooldownLeft(null, 5000)).toBe(0);
    expect(cooldownLeft(1000, 1000)).toBe(60);
    expect(cooldownLeft(1000, 1000 + 59_500)).toBe(1);
    expect(cooldownLeft(1000, 1000 + 60_000)).toBe(0);
    expect(cooldownLeft(1000, 1000 + 90_000)).toBe(0);
  });
});

describe("the gate for the new pages", () => {
  it("/forgot-password is for someone signed out, like /login", () => {
    expect(gateDecision("/forgot-password", false)).toBe("pass");
    expect(gateDecision("/forgot-password", true)).toBe("to-home");
    expect(gateDecision("/forgot-password/", false)).toBe("pass");
  });
  it("/reset-password passes either way: the page itself checks the recovery session", () => {
    expect(gateDecision("/reset-password", false)).toBe("pass");
    expect(gateDecision("/reset-password", true)).toBe("pass");
    expect(isPublicPath("/reset-password")).toBe(true);
  });
  it("the username check is public by exact path only", () => {
    expect(gateDecision("/api/handle-available", false)).toBe("pass");
    expect(gateDecision("/api/handle-available/x", false)).toBe("to-login");
    expect(gateDecision("/api/handle-availablex", false)).toBe("to-login");
  });
  it("no channel can take either page's name", () => {
    expect(RESERVED_ROOT_SEGMENTS).toContain("forgot-password");
    expect(RESERVED_ROOT_SEGMENTS).toContain("reset-password");
    expect(gateDecision("/reset-password/videos", false)).toBe("to-login");
  });
});
