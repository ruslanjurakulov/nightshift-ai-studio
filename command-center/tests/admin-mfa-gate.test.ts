import { describe, expect, it } from "vitest";
import {
  ENROL_PATH,
  hasVerifiedTotpFactor,
  isEnrolOnlyPath,
  mfaDecision,
  mfaVerifyUrl,
  parseAdminMfaMode,
  type AdminMfaMode,
  type MfaAction,
} from "../lib/security/admin-mfa";
import { mfaMiddlewareAction, resetAdminCache, type MfaMiddlewareClient } from "../lib/security/mfa-middleware";
import { gateDecision } from "../lib/public-paths";

/**
 * The second-factor gate (docs/security/ADMIN_MFA.md). The decision is one pure
 * function that the middleware, the app layout, the operator guards and the
 * sign-in page all ask, so the whole table is pinned here.
 *
 * What would break without these: an admin locked out by a merge (no factor,
 * or `warn`), an aal1 session let through in `enforce`, a customer who never
 * enrolled being asked for a code, or an enrolled customer not being asked.
 */

const MODES: AdminMfaMode[] = ["off", "warn", "enforce"];

describe("the mode", () => {
  it("defaults to warn, and only the exact words off / enforce change it", () => {
    expect(parseAdminMfaMode(undefined)).toBe("warn");
    expect(parseAdminMfaMode("")).toBe("warn");
    expect(parseAdminMfaMode("warn")).toBe("warn");
    expect(parseAdminMfaMode("off")).toBe("off");
    expect(parseAdminMfaMode("enforce")).toBe("enforce");
    expect(parseAdminMfaMode("  ENFORCE ")).toBe("enforce");
    expect(parseAdminMfaMode(" Off")).toBe("off");
  });

  it("a typo is warn: it neither switches the gate off nor starts blocking", () => {
    for (const typo of ["enforced", "on", "true", "1", "of", "enforce!", "disabled"]) {
      expect(parseAdminMfaMode(typo)).toBe("warn");
    }
  });
});

type Row = { mode: AdminMfaMode; admin: boolean; aal: string | null; factor: boolean; want: MfaAction };

// Every row of the table in lib/security/admin-mfa.ts, spelled out.
const TABLE: Row[] = [
  // off: nothing, ever (break-glass)
  ...[true, false].flatMap((admin) =>
    ["aal1", "aal2", null].flatMap((aal) =>
      [true, false].map((factor): Row => ({ mode: "off", admin, aal, factor, want: "allow" })),
    ),
  ),
  // aal2 is finished in every mode
  ...(["warn", "enforce"] as const).flatMap((mode) =>
    [true, false].flatMap((admin) =>
      [true, false].map((factor): Row => ({ mode, admin, aal: "aal2", factor, want: "allow" })),
    ),
  ),
  // aal1 (or unreadable), NO factor: no customer is blocked; an admin is pushed to enrol, and in `enforce` may
  // open /security and nothing else (enrol_only)
  ...(["warn", "enforce"] as const).flatMap((mode) =>
    ["aal1", null].flatMap((aal): Row[] => [
      { mode, admin: true, aal, factor: false, want: mode === "enforce" ? "enrol_only" : "warn_enrol" },
      { mode, admin: false, aal, factor: false, want: "allow" },
    ]),
  ),
  // aal1 (or unreadable) WITH a factor
  ...["aal1", null].flatMap((aal): Row[] => [
    { mode: "warn", admin: true, aal, factor: true, want: "warn_complete" },
    { mode: "warn", admin: false, aal, factor: true, want: "challenge" },
    { mode: "enforce", admin: true, aal, factor: true, want: "challenge" },
    { mode: "enforce", admin: false, aal, factor: true, want: "challenge" },
  ]),
];

describe("mfaDecision, every state", () => {
  it.each(TABLE.map((r) => [`${r.mode} / admin=${r.admin} / ${r.aal ?? "unreadable"} / factor=${r.factor}`, r] as const))(
    "%s",
    (_name, r) => {
      expect(mfaDecision({ mode: r.mode, admin: r.admin, aal: r.aal, hasVerifiedFactor: r.factor })).toBe(r.want);
    },
  );

  it("the table is complete: 3 modes x admin/customer x aal1/aal2/unreadable x factor/none", () => {
    const seen = new Set<string>();
    for (const mode of MODES)
      for (const admin of [true, false])
        for (const aal of ["aal1", "aal2", null])
          for (const factor of [true, false]) {
            const rows = TABLE.filter((r) => r.mode === mode && r.admin === admin && r.aal === aal && r.factor === factor);
            expect(rows.length, `${mode}/${admin}/${aal}/${factor}`).toBeGreaterThanOrEqual(1);
            seen.add(`${mode}/${admin}/${aal}/${factor}`);
          }
    expect(seen.size).toBe(36);
  });

  it("LOCKOUT SAFETY: nothing is ever blocked unless the account has a verified factor", () => {
    for (const mode of MODES)
      for (const admin of [true, false])
        for (const aal of ["aal1", "aal2", null, "garbage"])
          expect(mfaDecision({ mode, admin, aal, hasVerifiedFactor: false })).not.toBe("challenge");
  });

  it("STRICT ENFORCE: enrol_only happens in `enforce`, for an admin, with no verified factor, and nowhere else", () => {
    for (const mode of MODES)
      for (const admin of [true, false])
        for (const aal of ["aal1", "aal2", null, "garbage"])
          for (const factor of [true, false]) {
            const got = mfaDecision({ mode, admin, aal, hasVerifiedFactor: factor });
            const expected = mode === "enforce" && admin && !factor && aal !== "aal2";
            expect(got === "enrol_only", `${mode}/${admin}/${aal}/${factor}`).toBe(expected);
          }
  });

  it("DEFAULT SAFETY: in the default mode no admin is ever sent to the challenge", () => {
    for (const aal of ["aal1", "aal2", null])
      for (const factor of [true, false])
        expect(mfaDecision({ mode: parseAdminMfaMode(undefined), admin: true, aal, hasVerifiedFactor: factor })).not.toBe("challenge");
  });

  it("ENFORCE SAFETY: an admin with a factor passes only at aal2", () => {
    for (const aal of ["aal1", null, "", "AAL2", "aal3", "aal2 "]) {
      expect(mfaDecision({ mode: "enforce", admin: true, aal, hasVerifiedFactor: true })).toBe("challenge");
    }
    expect(mfaDecision({ mode: "enforce", admin: true, aal: "aal2", hasVerifiedFactor: true })).toBe("allow");
  });
});

describe("isEnrolOnlyPath: the only pages a factor-less admin keeps in strict enforce", () => {
  it("is /security, with or without a channel, with or without a trailing slash", () => {
    for (const p of ["/security", "/security/", "/chronos/security", "/all-channels/security", "/some-channel/security/"]) {
      expect(isEnrolOnlyPath(p), p).toBe(true);
    }
    expect(ENROL_PATH).toBe("/security");
  });
  it("is nothing else: no deeper path, no api, no other section, no look-alike", () => {
    for (const p of ["/", "/command-center", "/chronos/billing", "/security/x", "/a/b/security", "/api/security", "/chronos/security/x", "/securityx", "/chronos/security.json", "//security", "/chronos//security"]) {
      expect(isEnrolOnlyPath(p), p).toBe(false);
    }
  });
});

describe("hasVerifiedTotpFactor", () => {
  it("counts only a verified authenticator", () => {
    expect(hasVerifiedTotpFactor({ factors: [{ status: "verified", factor_type: "totp" }] })).toBe(true);
    expect(hasVerifiedTotpFactor({ factors: [{ status: "unverified", factor_type: "totp" }] })).toBe(false);
    expect(hasVerifiedTotpFactor({ factors: [{ status: "verified", factor_type: "phone" }] })).toBe(false);
    expect(hasVerifiedTotpFactor({ factors: [] })).toBe(false);
    expect(hasVerifiedTotpFactor({ factors: null })).toBe(false);
    expect(hasVerifiedTotpFactor({})).toBe(false);
    expect(hasVerifiedTotpFactor(null)).toBe(false);
    expect(hasVerifiedTotpFactor(undefined)).toBe(false);
  });

  it("an unconfirmed enrolment next to a verified one does not matter; the verified one counts", () => {
    expect(
      hasVerifiedTotpFactor({
        factors: [
          { status: "unverified", factor_type: "totp" },
          { status: "verified", factor_type: "totp" },
        ],
      }),
    ).toBe(true);
  });
});

describe("mfaVerifyUrl", () => {
  it("carries where the person was going, encoded", () => {
    expect(mfaVerifyUrl("/chronos/billing?x=1&y=2")).toBe("/login/verify?next=%2Fchronos%2Fbilling%3Fx%3D1%26y%3D2");
    expect(mfaVerifyUrl()).toBe("/login/verify");
    expect(mfaVerifyUrl(null)).toBe("/login/verify");
  });

  it("/login/verify is reachable signed in and sends a signed-out visitor to /login (no loop with the gate)", () => {
    expect(gateDecision("/login/verify", true)).toBe("pass");
    expect(gateDecision("/login/verify", false)).toBe("to-login");
    expect(gateDecision("/login", true)).toBe("to-home");
  });
});

// ── the middleware's half ────────────────────────────────────────────────────

function fakeClient(opts: { aal?: string | null; throwAal?: boolean; admin?: boolean | "error" | "throw" }) {
  const calls = { aal: 0, rpc: 0 };
  const client: MfaMiddlewareClient = {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          calls.aal += 1;
          if (opts.throwAal) throw new Error("boom");
          return { data: { currentLevel: opts.aal ?? null } };
        },
      },
    },
    rpc: async () => {
      calls.rpc += 1;
      if (opts.admin === "throw") throw new Error("boom");
      if (opts.admin === "error") return { data: null, error: { code: "x" } };
      return { data: opts.admin === true, error: null };
    },
  };
  return { client, calls };
}

const WITH_FACTOR = { factors: [{ status: "verified", factor_type: "totp" }] };
const NO_FACTOR = { factors: [] };

describe("mfaMiddlewareAction", () => {
  it("off: nothing is read at all", async () => {
    const { client, calls } = fakeClient({ aal: "aal1", admin: true });
    expect(await mfaMiddlewareAction(client, WITH_FACTOR, "off")).toBe("allow");
    expect(calls).toEqual({ aal: 0, rpc: 0 });
  });

  it("warn: an account with no factor is never touched: no level read, no admin lookup (the common customer costs nothing)", async () => {
    const { client, calls } = fakeClient({ aal: "aal1", admin: true });
    expect(await mfaMiddlewareAction(client, NO_FACTOR, "warn")).toBe("allow");
    expect(calls).toEqual({ aal: 0, rpc: 0 });
  });

  it("enforce (strict): an account with no factor costs one admin lookup, no level read; an admin is enrol_only, a customer allowed", async () => {
    resetAdminCache();
    const asAdmin = fakeClient({ aal: "aal1", admin: true });
    expect(await mfaMiddlewareAction(asAdmin.client, { id: "u-a", factors: [] }, "enforce")).toBe("enrol_only");
    expect(asAdmin.calls).toEqual({ aal: 0, rpc: 1 });
    const asCustomer = fakeClient({ aal: "aal1", admin: false });
    expect(await mfaMiddlewareAction(asCustomer.client, { id: "u-c", factors: [] }, "enforce")).toBe("allow");
    // remembered for a minute per user, then asked again
    expect(await mfaMiddlewareAction(asCustomer.client, { id: "u-c", factors: [] }, "enforce", Date.now() + 1000)).toBe("allow");
    expect(asCustomer.calls.rpc).toBe(1);
    expect(await mfaMiddlewareAction(asCustomer.client, { id: "u-c", factors: [] }, "enforce", Date.now() + 61_000)).toBe("allow");
    expect(asCustomer.calls.rpc).toBe(2);
  });

  it("enforce (strict): a failing or throwing admin lookup is 'not an admin' and is not remembered", async () => {
    resetAdminCache();
    const failing = fakeClient({ aal: "aal1", admin: "error" });
    expect(await mfaMiddlewareAction(failing.client, { id: "u-e", factors: [] }, "enforce")).toBe("allow");
    expect(await mfaMiddlewareAction(failing.client, { id: "u-e", factors: [] }, "enforce")).toBe("allow");
    expect(failing.calls.rpc).toBe(2);
    const throwing = fakeClient({ aal: "aal1", admin: "throw" });
    expect(await mfaMiddlewareAction(throwing.client, { id: "u-t", factors: [] }, "enforce")).toBe("allow");
    expect(await mfaMiddlewareAction(failing.client, null, "enforce")).toBe("allow");
  });

  it("aal2 passes without asking who the admin is", async () => {
    const { client, calls } = fakeClient({ aal: "aal2", admin: true });
    expect(await mfaMiddlewareAction(client, WITH_FACTOR, "enforce")).toBe("allow");
    expect(calls.rpc).toBe(0);
  });

  it("aal1 + factor: customer is challenged in warn and enforce; admin only in enforce", async () => {
    expect(await mfaMiddlewareAction(fakeClient({ aal: "aal1", admin: false }).client, WITH_FACTOR, "warn")).toBe("challenge");
    expect(await mfaMiddlewareAction(fakeClient({ aal: "aal1", admin: false }).client, WITH_FACTOR, "enforce")).toBe("challenge");
    expect(await mfaMiddlewareAction(fakeClient({ aal: "aal1", admin: true }).client, WITH_FACTOR, "warn")).toBe("warn_complete");
    expect(await mfaMiddlewareAction(fakeClient({ aal: "aal1", admin: true }).client, WITH_FACTOR, "enforce")).toBe("challenge");
  });

  it("every error leans toward asking for the code, never toward skipping it", async () => {
    // level unreadable -> password-only
    expect(await mfaMiddlewareAction(fakeClient({ throwAal: true, admin: true }).client, WITH_FACTOR, "enforce")).toBe("challenge");
    // admin lookup failed -> not an admin -> a plain challenge
    expect(await mfaMiddlewareAction(fakeClient({ aal: "aal1", admin: "error" }).client, WITH_FACTOR, "warn")).toBe("challenge");
    expect(await mfaMiddlewareAction(fakeClient({ aal: "aal1", admin: "throw" }).client, WITH_FACTOR, "warn")).toBe("challenge");
  });
});
