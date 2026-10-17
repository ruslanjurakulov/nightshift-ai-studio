// @vitest-environment jsdom
/**
 * The sign-in second step, with fakes (no network, no SDK).
 *
 * What would break without these: a password sign-in that goes straight into
 * the app for an account with an authenticator; a wrong, expired or
 * rate-limited code with no words; a person with no code and no way out; a
 * success that is believed without the session actually being aal2.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { dictionaries, type Locale } from "../lib/i18n";
import { publicDictionary } from "../lib/i18n/public";
import {
  classifyChallengeError,
  cleanCode,
  completeTotpChallenge,
  listTotpFactors,
  signInNextStep,
  type MfaClient,
} from "../lib/security/challenge";

// ── a fake Supabase MFA client ───────────────────────────────────────────────

type Err = { code?: string; status?: number; message?: string } | null;

function fake(
  opts: {
    current?: string | null;
    next?: string | null;
    levelError?: boolean;
    levelThrows?: boolean;
    factors?: Array<{ id: string; friendly_name?: string | null; status?: string }>;
    listError?: boolean;
    challengeError?: Err;
    verifyError?: Err;
    levelAfterVerify?: string;
  } = {},
) {
  const log: string[] = [];
  let verified = false;
  const signOut = vi.fn(async () => undefined);
  const client = {
    auth: {
      signOut,
      mfa: {
        getAuthenticatorAssuranceLevel: async () => {
          log.push("level");
          if (opts.levelThrows) throw new Error("network");
          if (opts.levelError) return { data: null, error: { message: "x" } };
          return {
            data: {
              currentLevel: verified ? (opts.levelAfterVerify ?? "aal2") : (opts.current ?? "aal1"),
              nextLevel: opts.next ?? "aal2",
            },
            error: null,
          };
        },
        listFactors: async () => {
          log.push("list");
          if (opts.listError) return { data: null, error: { message: "x" } };
          return { data: { totp: opts.factors ?? [{ id: "f1", friendly_name: "Phone", status: "verified" }] }, error: null };
        },
        challenge: async ({ factorId }: { factorId: string }) => {
          log.push(`challenge:${factorId}`);
          return opts.challengeError ? { data: null, error: opts.challengeError } : { data: { id: "ch1" }, error: null };
        },
        verify: async ({ factorId, challengeId, code }: { factorId: string; challengeId: string; code: string }) => {
          log.push(`verify:${factorId}:${challengeId}:${code}`);
          if (opts.verifyError) return { data: null, error: opts.verifyError };
          verified = true;
          return { data: {}, error: null };
        },
      },
    },
  };
  return { client: client as unknown as MfaClient, log, signOut };
}

describe("signInNextStep", () => {
  it("password-only session on an account with a factor: challenge", async () => {
    expect(await signInNextStep(fake({ current: "aal1", next: "aal2" }).client)).toBe("challenge");
  });
  it("no factor (next level stays aal1) or already aal2: done", async () => {
    expect(await signInNextStep(fake({ current: "aal1", next: "aal1" }).client)).toBe("done");
    expect(await signInNextStep(fake({ current: "aal2", next: "aal2" }).client)).toBe("done");
  });
  it("an unreadable level asks the server (challenge), never skips the step", async () => {
    expect(await signInNextStep(fake({ levelError: true }).client)).toBe("challenge");
    expect(await signInNextStep(fake({ levelThrows: true }).client)).toBe("challenge");
    expect(await signInNextStep({ auth: {} } as unknown as MfaClient)).toBe("challenge");
  });
});

describe("cleanCode / classifyChallengeError", () => {
  it("six digits, spaces forgiven, nothing else", () => {
    expect(cleanCode("123456")).toBe("123456");
    expect(cleanCode(" 123 456 ")).toBe("123456");
    expect(cleanCode("12345")).toBeNull();
    expect(cleanCode("1234567")).toBeNull();
    expect(cleanCode("12345a")).toBeNull();
    expect(cleanCode("")).toBeNull();
  });
  it("maps the SDK's codes and statuses to the fixed vocabulary", () => {
    expect(classifyChallengeError({ code: "mfa_verification_failed" })).toBe("wrong_code");
    expect(classifyChallengeError({ code: "mfa_challenge_expired" })).toBe("expired");
    expect(classifyChallengeError({ code: "over_request_rate_limit", status: 429 })).toBe("rate_limited");
    expect(classifyChallengeError({ status: 429 })).toBe("rate_limited");
    expect(classifyChallengeError({ code: "mfa_factor_not_found" })).toBe("no_factor");
    expect(classifyChallengeError({ message: "Invalid TOTP code entered" })).toBe("wrong_code");
    expect(classifyChallengeError({ message: "boom" })).toBe("failed");
    expect(classifyChallengeError(null)).toBe("failed");
  });
});

describe("listTotpFactors", () => {
  it("lists the verified authenticators with their names", async () => {
    const f = await listTotpFactors(fake({ factors: [{ id: "a", friendly_name: "Phone", status: "verified" }, { id: "b", status: "verified" }] }).client);
    expect(f).toEqual([{ id: "a", friendlyName: "Phone" }, { id: "b", friendlyName: null }]);
  });
  it("null when it cannot be read", async () => {
    expect(await listTotpFactors(fake({ listError: true }).client)).toBeNull();
  });
});

describe("completeTotpChallenge", () => {
  it("makes a fresh challenge, verifies, then confirms the session is aal2", async () => {
    const { client, log } = fake();
    expect(await completeTotpChallenge(client, "f1", "123 456")).toEqual({ ok: true });
    expect(log).toEqual(["challenge:f1", "verify:f1:ch1:123456", "level"]);
  });
  it("a malformed code never reaches the server", async () => {
    const { client, log } = fake();
    expect(await completeTotpChallenge(client, "f1", "12")).toEqual({ ok: false, reason: "wrong_code" });
    expect(log).toEqual([]);
  });
  it("wrong code", async () => {
    const { client } = fake({ verifyError: { code: "mfa_verification_failed" } });
    expect(await completeTotpChallenge(client, "f1", "000000")).toEqual({ ok: false, reason: "wrong_code" });
  });
  it("expired challenge", async () => {
    const { client } = fake({ verifyError: { code: "mfa_challenge_expired" } });
    expect(await completeTotpChallenge(client, "f1", "000000")).toEqual({ ok: false, reason: "expired" });
  });
  it("rate limited (on the challenge or on the verify)", async () => {
    expect(await completeTotpChallenge(fake({ challengeError: { status: 429 } }).client, "f1", "000000")).toEqual({ ok: false, reason: "rate_limited" });
    expect(await completeTotpChallenge(fake({ verifyError: { code: "over_request_rate_limit" } }).client, "f1", "000000")).toEqual({ ok: false, reason: "rate_limited" });
  });
  it("factor removed elsewhere", async () => {
    const { client } = fake({ challengeError: { code: "mfa_factor_not_found" } });
    expect(await completeTotpChallenge(client, "f1", "000000")).toEqual({ ok: false, reason: "no_factor" });
  });
  it("a verify that 'succeeds' but leaves the session below aal2 is NOT success", async () => {
    const { client } = fake({ levelAfterVerify: "aal1" });
    expect(await completeTotpChallenge(client, "f1", "123456")).toEqual({ ok: false, reason: "failed" });
  });
  it("the network failing is a failure, not an exception", async () => {
    const { client } = fake({ levelThrows: true });
    expect(await completeTotpChallenge(client, "f1", "123456")).toEqual({ ok: false, reason: "failed" });
  });
});

// ── the pages, with fakes ────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  locale: "en" as "en" | "ru" | "uz",
  push: vi.fn(),
  refresh: vi.fn(),
  client: null as unknown,
  signIn: vi.fn(),
}));

vi.mock("@/lib/i18n/public-context", async () => {
  const { dictionaries } = await import("../lib/i18n");
  const { publicDictionary } = await import("../lib/i18n/public");
  return {
    usePublicI18n: () => ({ t: publicDictionary(dictionaries[h.locale]), locale: h.locale, fmt: (s: string) => s, setLocale: () => {} }),
  };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => h.client }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: h.refresh, replace: vi.fn() }) }));
vi.mock("@/components/auth/AuthShell", async () => {
  const actual = await vi.importActual<typeof import("../components/auth/AuthShell")>("../components/auth/AuthShell");
  return {
    ...actual,
    AuthShell: ({ title, children }: { title: string; children: React.ReactNode }) => (
      <main>
        <h1>{title}</h1>
        {children}
      </main>
    ),
  };
});
vi.mock("@/components/auth/GoogleButton", () => ({ GoogleButton: () => null }));
vi.mock("@/lib/handles", () => ({ applyPendingHandle: async () => undefined }));

const { default: LoginPage } = await import("../app/login/page");
const { MfaChallenge } = await import("../components/auth/MfaChallenge");

beforeEach(() => {
  h.locale = "en";
  h.push.mockReset();
  h.refresh.mockReset();
  h.signIn.mockReset().mockResolvedValue({ error: null });
  window.history.replaceState({}, "", "/login");
});
afterEach(cleanup);

async function signInAs(client: ReturnType<typeof fake>["client"]) {
  h.client = { auth: { ...(client as unknown as { auth: object }).auth, signInWithPassword: h.signIn } };
  render(<LoginPage />);
  fireEvent.change(screen.getByLabelText(dictionaries.en.auth.email), { target: { value: "me@example.test" } });
  fireEvent.change(screen.getByLabelText(dictionaries.en.auth.password), { target: { value: "correct horse" } });
  await act(async () => {
    fireEvent.submit(screen.getByRole("button", { name: dictionaries.en.auth.signIn }).closest("form")!);
  });
}

describe("the sign-in page", () => {
  it("an account with an authenticator is sent to the code page, never into the app", async () => {
    window.history.replaceState({}, "", "/login?next=%2Fchronos%2Fbilling");
    await signInAs(fake({ current: "aal1", next: "aal2" }).client);
    await waitFor(() => expect(h.push).toHaveBeenCalledTimes(1));
    expect(h.push).toHaveBeenCalledWith("/login/verify?next=%2Fchronos%2Fbilling");
    expect(h.push).not.toHaveBeenCalledWith("/command-center");
  });

  it("an account without one goes straight on, as before", async () => {
    await signInAs(fake({ current: "aal1", next: "aal1" }).client);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/command-center"));
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("a wrong password pushes nothing and asks for no code", async () => {
    h.signIn.mockResolvedValue({ error: { code: "invalid_credentials", message: "x", status: 400 } });
    const f = fake();
    await signInAs(f.client);
    expect(h.push).not.toHaveBeenCalled();
    expect(f.log).toEqual([]);
  });
});

async function openChallenge(client: ReturnType<typeof fake>["client"], next = "/chronos/billing") {
  h.client = client;
  render(<MfaChallenge next={next} />);
  await act(async () => {});
}

describe("the code page", () => {
  it("shows the code form with a one-time-code field and a sign-out", async () => {
    await openChallenge(fake().client);
    const field = screen.getByLabelText(dictionaries.en.mfa.codeLabel) as HTMLInputElement;
    expect(field.getAttribute("autocomplete")).toBe("one-time-code");
    expect(field.getAttribute("inputmode")).toBe("numeric");
    expect(screen.getByRole("button", { name: dictionaries.en.mfa.signOut })).toBeTruthy();
  });

  it("a right code completes the session and moves on to where the person was going", async () => {
    await openChallenge(fake().client);
    fireEvent.change(screen.getByLabelText(dictionaries.en.mfa.codeLabel), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: dictionaries.en.mfa.submit }));
    });
    await waitFor(() => expect(h.push).toHaveBeenCalledWith("/chronos/billing"));
    expect(h.refresh).toHaveBeenCalled();
  });

  it.each([
    ["wrong code", { verifyError: { code: "mfa_verification_failed" } }, "wrongCode"],
    ["expired challenge", { verifyError: { code: "mfa_challenge_expired" } }, "expired"],
    ["rate limited", { challengeError: { status: 429 } }, "rateLimited"],
    ["factor gone", { challengeError: { code: "mfa_factor_not_found" } }, "noFactor"],
    ["network", { levelThrows: true }, "failed"],
  ] as const)("%s: says so in words and stays on the page", async (_n, opts, key) => {
    await openChallenge(fake(opts as Parameters<typeof fake>[0]).client);
    fireEvent.change(screen.getByLabelText(dictionaries.en.mfa.codeLabel), { target: { value: "123456" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: dictionaries.en.mfa.submit }));
    });
    expect((await screen.findByRole("alert")).textContent).toContain(dictionaries.en.mfa[key]);
    expect(h.push).not.toHaveBeenCalled();
  });

  it("two authenticators: the person picks one, and the code goes to that one", async () => {
    const { client, log } = fake({
      factors: [
        { id: "a", friendly_name: "Phone", status: "verified" },
        { id: "b", friendly_name: "Tablet", status: "verified" },
      ],
    });
    await openChallenge(client);
    fireEvent.change(screen.getByLabelText(dictionaries.en.mfa.factorLabel), { target: { value: "b" } });
    fireEvent.change(screen.getByLabelText(dictionaries.en.mfa.codeLabel), { target: { value: "654321" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: dictionaries.en.mfa.submit }));
    });
    expect(log).toContain("challenge:b");
    expect(log).toContain("verify:b:ch1:654321");
  });

  it("no factor can be listed: says so, offers a retry and a sign-out", async () => {
    await openChallenge(fake({ listError: true }).client);
    expect(screen.getByRole("alert").textContent).toContain(dictionaries.en.mfa.unavailable);
    expect(screen.getByRole("button", { name: dictionaries.en.mfa.retry })).toBeTruthy();
    expect(screen.getByRole("button", { name: dictionaries.en.mfa.signOut })).toBeTruthy();
  });

  it("sign out ends the local session and goes to /login", async () => {
    const { client, signOut } = fake();
    await openChallenge(client);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: dictionaries.en.mfa.signOut }));
    });
    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(h.push).toHaveBeenCalledWith("/login");
  });
});

describe("the words exist in all three languages", () => {
  const KEYS = Object.keys(dictionaries.en.mfa) as Array<keyof typeof dictionaries.en.mfa>;
  it.each(["ru", "uz"] as Locale[])("%s has every key, translated (not the English)", (loc) => {
    for (const k of KEYS) {
      const v = dictionaries[loc].mfa[k];
      expect(typeof v, k).toBe("string");
      expect(v.length, k).toBeGreaterThan(0);
      if (!["codePh"].includes(k)) expect(v, `${loc}.${k}`).not.toBe(dictionaries.en.mfa[k]);
    }
  });
  it("the public slice carries the sign-in step's words", () => {
    const slice = publicDictionary(dictionaries.uz).mfa;
    expect(slice.title).toBe(dictionaries.uz.mfa.title);
    expect(slice.signOut).toBe(dictionaries.uz.mfa.signOut);
  });
  it("Uzbek writes oʻ / gʻ with U+02BB and has no ASCII apostrophe inside a word", () => {
    for (const k of KEYS) expect(dictionaries.uz.mfa[k], k).not.toMatch(/[A-Za-z]'/);
  });
});
