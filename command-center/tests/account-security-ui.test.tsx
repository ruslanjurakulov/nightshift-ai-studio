// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";

const h = vi.hoisted(() => ({
  update: vi.fn(),
  signOutOthers: vi.fn(),
  rpc: vi.fn(),
  signIn: vi.fn(),
  reauthSignOut: vi.fn(),
  refresh: vi.fn(),
  toast: vi.fn(),
  meta: {} as Record<string, unknown>,
}));

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      updateUser: h.update,
      signOut: h.signOutOthers,
      getUser: async () => ({ data: { user: { user_metadata: h.meta } } }),
    },
    rpc: h.rpc,
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
  }),
}));
vi.mock("@/lib/supabase/reauth", () => ({ createReauthClient: () => ({ auth: { signInWithPassword: h.signIn, signOut: h.reauthSignOut } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

const { AccountSecurity } = await import("../components/account/AccountSecurity");

const NOW = new Date("2026-10-11T12:00:00Z");
const row = (changedDaysAgo: number | null) => {
  const created = new Date(NOW.getTime() - 90 * 86_400_000).toISOString();
  return { handle: "ana.k", created_at: created, changed_at: changedDaysAgo === null ? created : new Date(NOW.getTime() - changedDaysAgo * 86_400_000).toISOString() };
};

function show(props: Partial<React.ComponentProps<typeof AccountSecurity>> = {}) {
  return render(
    <AccountSecurity email="ana@a.test" pendingEmail={null} handle={null} signupHandle={null} handlesSupported {...props} />,
  );
}
const click = async (name: string) => {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
};
const type = (label: string | RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], now: NOW });
  vi.setSystemTime(NOW);
  h.update.mockReset().mockResolvedValue({ data: {}, error: null });
  h.signOutOthers.mockReset().mockResolvedValue({ error: null });
  h.signIn.mockReset().mockResolvedValue({ error: null });
  h.reauthSignOut.mockReset().mockResolvedValue({});
  h.rpc.mockReset().mockResolvedValue({ data: true, error: null });
  h.refresh.mockReset();
  h.toast.mockReset();
  h.meta = {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Account and security: the page's shape", () => {
  it("shows the current email and the three parts", () => {
    show();
    expect(screen.getByRole("heading", { name: en.accountSecurity.title })).toBeTruthy();
    expect(document.body.textContent).toContain("ana@a.test");
    for (const name of [en.accountSecurity.passwordTitle, en.accountSecurity.emailTitle, en.accountSecurity.handlePickTitle])
      expect(screen.getByRole("heading", { name })).toBeTruthy();
  });

  it("before migration 0096 the username part is simply not there", () => {
    show({ handlesSupported: false });
    expect(screen.queryByTestId("handle-section")).toBeNull();
    expect(screen.getByRole("heading", { name: en.accountSecurity.passwordTitle })).toBeTruthy();
  });
});

describe("Change password", () => {
  const fillAll = (current: string, next: string, confirm = next) => {
    type(new RegExp(`^${en.accountSecurity.currentPassword}`), current);
    type(new RegExp(`^${en.accountSecurity.newPassword}`), next);
    type(new RegExp(`^${en.accountSecurity.confirmPassword}`), confirm);
  };
  const alertText = () => screen.getByRole("alert").textContent;
  const submit = () => click(en.accountSecurity.passwordSubmit);

  it("needs the current password", async () => {
    show();
    fillAll("", "longenough1");
    await submit();
    expect(alertText()).toContain(en.accountSecurity.errPasswordRequired);
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it("applies the sign-up policy to the new one: too short, not the same twice, unchanged", async () => {
    show();
    fillAll("old-password", "short");
    await submit();
    expect(alertText()).toContain(en.signup.errPasswordShort.replace("{n}", "8"));
    fillAll("old-password", "longenough1", "longenough2");
    await submit();
    expect(alertText()).toContain(en.signup.errMismatch);
    fillAll("longenough1", "longenough1");
    await submit();
    expect(alertText()).toContain(en.accountSecurity.errUnchanged);
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("a wrong current password is one generic sentence, changes nothing and is throttled", async () => {
    h.signIn.mockResolvedValue({ error: { code: "invalid_credentials", message: "Invalid login credentials" } });
    show();
    for (let i = 0; i < 5; i++) {
      fillAll("wrong-password", "longenough1");
      await submit();
      expect(alertText()).toBe(en.accountSecurity.errPasswordWrong);
    }
    fillAll("wrong-password", "longenough1");
    await submit();
    expect(alertText()).toBe(en.accountSecurity.errThrottle);
    expect(h.signIn).toHaveBeenCalledTimes(5);
    expect(h.update).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("Invalid login credentials");
  });

  it("re-authenticates first, then updates, then signs the OTHER sessions out", async () => {
    show();
    fillAll("old-password", "longenough1");
    await submit();
    expect(h.signIn).toHaveBeenCalledWith({ email: "ana@a.test", password: "old-password" });
    expect(h.update).toHaveBeenCalledWith({ password: "longenough1" });
    expect(h.signOutOthers).toHaveBeenCalledWith({ scope: "others" });
    expect(h.signIn.mock.invocationCallOrder[0]).toBeLessThan(h.update.mock.invocationCallOrder[0]);
    expect(h.update.mock.invocationCallOrder[0]).toBeLessThan(h.signOutOthers.mock.invocationCallOrder[0]);
    // the throwaway sign-in is revoked locally, not for every device
    expect(h.reauthSignOut).toHaveBeenCalledWith({ scope: "local" });
    expect(h.toast).toHaveBeenCalledWith(en.accountSecurity.passwordChanged);
    expect(screen.getByRole("status").textContent).toBe(en.accountSecurity.passwordChanged);
    expect((screen.getByLabelText(new RegExp(`^${en.accountSecurity.currentPassword}`)) as HTMLInputElement).value).toBe("");
  });

  it("a refused update shows our sentence, never the provider's, and signs nobody out", async () => {
    h.update.mockResolvedValue({ data: null, error: { code: "weak_password", message: "Password should contain at least one character of each" } });
    show();
    fillAll("old-password", "longenough1");
    await submit();
    expect(alertText()).toBe(en.signup.errWeakPassword);
    expect(h.signOutOthers).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain("at least one character of each");
  });

  it("never logs a password", async () => {
    const spies = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn")];
    show();
    fillAll("old-password", "longenough1");
    await submit();
    for (const s of spies) for (const call of s.mock.calls) expect(JSON.stringify(call)).not.toMatch(/old-password|longenough1/);
  });
});

describe("Change email", () => {
  const open = () => click(en.accountSecurity.emailChange);
  const fillEmail = (next: string, password = "old-password") => {
    type(en.accountSecurity.newEmail, next);
    // the page also carries the password form's "Current password": the e-mail form comes first
    fireEvent.change(screen.getAllByLabelText(new RegExp(`^${en.accountSecurity.currentPassword}`))[0], { target: { value: password } });
  };
  const submit = () => click(en.accountSecurity.emailSubmit);

  it("is closed until asked for, and refuses a bad, same or passwordless request without asking Supabase", async () => {
    show();
    expect(screen.queryByLabelText(en.accountSecurity.newEmail)).toBeNull();
    await open();
    fillEmail("nope");
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(en.accountSecurity.emailInvalid);
    fillEmail("ANA@a.test");
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(en.accountSecurity.emailSame);
    fillEmail("new@a.test", "");
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(en.accountSecurity.errPasswordRequired);
    expect(h.signIn).not.toHaveBeenCalled();
    expect(h.update).not.toHaveBeenCalled();
  });

  it("a wrong current password changes nothing and says only that it isn't right", async () => {
    h.signIn.mockResolvedValue({ error: { code: "invalid_credentials" } });
    show();
    await open();
    fillEmail("new@a.test", "wrong");
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(en.accountSecurity.errPasswordWrong);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("re-authenticates, then asks for the change with a link back to the callback, and shows the pending state", async () => {
    show();
    await open();
    fillEmail("new@a.test");
    await submit();
    expect(h.signIn).toHaveBeenCalledWith({ email: "ana@a.test", password: "old-password" });
    expect(h.update).toHaveBeenCalledWith({ email: "new@a.test" }, { emailRedirectTo: `${window.location.origin}/auth/callback?next=%2F` });
    const pending = screen.getByTestId("email-pending").textContent!;
    expect(pending).toBe(en.accountSecurity.emailSent.replace("{email}", "new@a.test").replace("{current}", "ana@a.test"));
    expect(h.toast).toHaveBeenCalled();
  });

  it("an address that is already in use gets exactly the same answer as a free one", async () => {
    const texts: string[] = [];
    for (const error of [null, { code: "email_exists", status: 422, message: "A user with this email address has already been registered" }]) {
      cleanup();
      h.update.mockReset().mockResolvedValue({ data: {}, error });
      show();
      await open();
      fillEmail("taken@a.test");
      await submit();
      texts.push(document.body.textContent ?? "");
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[1]).not.toMatch(/already been registered|email_exists/);
  });

  it("shows a change that is still waiting for its confirmation links", () => {
    show({ pendingEmail: "later@a.test" });
    expect(screen.getByTestId("email-pending").textContent).toBe(en.accountSecurity.emailPending.replace("{email}", "later@a.test"));
  });
});

describe("The @username in Settings", () => {
  it("gently asks someone with none to pick one (a prompt in the page, no modal)", () => {
    show();
    expect(screen.getByRole("heading", { name: en.accountSecurity.handlePickTitle })).toBeTruthy();
    expect(document.body.textContent).toContain(en.accountSecurity.handlePickBody);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the handle and lets the first change happen at once; a typed name is checked live", async () => {
    show({ handle: row(null) });
    expect(document.body.textContent).toContain("@ana.k");
    expect(document.body.textContent).toContain(en.accountSecurity.handleOnce);
    type(new RegExp(`^${en.accountSecurity.handleChange}`), "new.name");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(h.rpc).toHaveBeenCalledWith("handle_available", { p_handle: "new.name" });
    expect(document.querySelector("[data-status]")!.textContent).toBe("@new.name is available");
  });

  it("typing your own handle is 'already yours' and cannot be saved", async () => {
    show({ handle: row(null) });
    type(new RegExp(`^${en.accountSecurity.handleChange}`), "@ana.k");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    expect(document.querySelector("[data-status]")!.textContent).toBe("@ana.k is already your username");
    expect((screen.getByRole("button", { name: en.accountSecurity.handleSave }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("within 30 days of the last change it shows the next allowed date and offers no field", () => {
    show({ handle: row(10) });
    expect(document.body.textContent).toContain(en.accountSecurity.handleCooldown.replace("{date}", "Oct 31, 2026"));
    expect(screen.queryByRole("button", { name: en.accountSecurity.handleSave })).toBeNull();
  });

  it("after 30 days the field is back", () => {
    show({ handle: row(31) });
    expect(screen.getByRole("button", { name: en.accountSecurity.handleSave })).toBeTruthy();
  });

  async function saveHandle(name: string) {
    type(new RegExp(`^${en.signup.handleLabel}`), name);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    await click(en.accountSecurity.handleSave);
  }

  it("saves through set_handle and refreshes the page", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "set_handle" ? { data: { code: "ok", handle: "ana.k" }, error: null } : { data: true, error: null }));
    show();
    await saveHandle("Ana.K");
    expect(h.rpc).toHaveBeenCalledWith("set_handle", { p_handle: "ana.k" });
    expect(h.toast).toHaveBeenCalledWith("Username saved: @ana.k");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a name that was taken a moment ago is reported as taken, not as an error", async () => {
    h.rpc.mockImplementation(async (fn: string) => (fn === "set_handle" ? { data: { code: "taken" }, error: null } : { data: true, error: null }));
    show();
    await saveHandle("ana.k");
    expect(screen.getByRole("alert").textContent).toBe("@ana.k is already taken");
  });

  it("a refused change inside the cooldown shows the date the database gave", async () => {
    h.rpc.mockImplementation(async (fn: string) =>
      fn === "set_handle" ? { data: { code: "cooldown", next_change_at: "2026-11-05T09:00:00Z" }, error: null } : { data: true, error: null },
    );
    show({ handle: row(31) });
    type(new RegExp(`^${en.accountSecurity.handleChange}`), "other.name");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    await click(en.accountSecurity.handleSave);
    expect(screen.getByRole("alert").textContent).toBe(en.accountSecurity.handleCooldown.replace("{date}", "Nov 5, 2026"));
  });

  it("a database error is one plain sentence, never SQL text", async () => {
    h.rpc.mockImplementation(async (fn: string) =>
      fn === "set_handle" ? { data: null, error: { code: "42501", message: 'permission denied for table "user_handles"' } } : { data: true, error: null },
    );
    show();
    await saveHandle("ana.k");
    expect(screen.getByRole("alert").textContent).toBe(en.accountSecurity.handleFailed);
    expect(document.body.textContent).not.toContain("permission denied");
  });

  it("a name chosen at sign-up that is applied now refreshes; one that was lost is explained", async () => {
    h.meta = { signup_handle: "ana.k" };
    h.rpc.mockResolvedValue({ data: { code: "ok", handle: "ana.k" }, error: null });
    show({ signupHandle: "ana.k" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    // the page asked to set the handle chosen at sign-up, once, and refreshed to show it
    expect(h.rpc.mock.calls.filter((c) => c[0] === "set_handle")).toEqual([["set_handle", { p_handle: "ana.k" }]]);
    expect(h.refresh).toHaveBeenCalled();
    cleanup();
    h.rpc.mockReset().mockResolvedValue({ data: { code: "taken" }, error: null });
    h.refresh.mockReset();
    show({ signupHandle: "ana.k" });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain(en.accountSecurity.handleLostAtSignup);
    expect(h.refresh).not.toHaveBeenCalled();
  });
});
