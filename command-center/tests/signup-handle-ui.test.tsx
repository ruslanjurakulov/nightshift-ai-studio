// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { en } from "../lib/i18n/en";

const h = vi.hoisted(() => ({
  signUp: vi.fn(),
  push: vi.fn(),
  rpc: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/i18n/public-context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { usePublicI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("@/lib/config", () => ({ SUPABASE_URL: "https://p.supabase.test", SUPABASE_ANON_KEY: "anon", isSupabaseConfigured: true }));
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: { signUp: h.signUp, getUser: async () => ({ data: { user: { user_metadata: { signup_handle: "ana.k" } } } }) },
    rpc: h.rpc,
    from: () => ({ select: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }),
  }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: h.push, refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/components/auth/AuthShell", async () => {
  const actual = await vi.importActual<typeof import("../components/auth/AuthShell")>("../components/auth/AuthShell");
  return {
    ...actual,
    AuthShell: ({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) => (
      <main>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
        {children}
      </main>
    ),
  };
});

const { default: SignupPage } = await import("../app/signup/page");

const answer = (available: boolean | null, ok = true) => ({ ok, json: async () => ({ available }) });
const field = () => screen.getByLabelText(new RegExp(`^${en.signup.handleLabel}`)) as HTMLInputElement;
const status = () => document.querySelector("[data-status]") as HTMLElement;
const type = (value: string) => fireEvent.change(field(), { target: { value } });
const settle = async (ms = 450) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  h.signUp.mockReset().mockResolvedValue({ data: { user: { identities: [{}] }, session: null }, error: null });
  h.push.mockReset();
  h.rpc.mockReset().mockResolvedValue({ data: { code: "ok", handle: "ana.k" }, error: null });
  h.fetch.mockReset().mockResolvedValue(answer(true));
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the sign-up username field", () => {
  it("starts neutral and says the rule", () => {
    render(<SignupPage />);
    expect(status().dataset.status).toBe("idle");
    expect(status().textContent).toContain(en.signup.handleHint);
    expect(status().getAttribute("aria-live")).toBe("polite");
    expect(field().getAttribute("aria-describedby")).toBe(status().id);
  });

  it("a wrong shape is neutral, states the rule, and asks nothing", async () => {
    render(<SignupPage />);
    for (const [value, rule] of [
      ["ab", en.signup.handleRuleShort],
      ["a..b", en.signup.handleRuleDots],
      ["ana k", en.signup.handleRuleChars],
      ["___", en.signup.handleRuleLetter],
    ] as const) {
      type(value);
      await settle();
      expect(status().dataset.status).toBe("rule");
      expect(status().dataset.tone).toBe("neutral");
      expect(status().textContent).toContain(rule);
      expect(field().getAttribute("aria-invalid")).toBe("true");
    }
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("waits ~400 ms after the last keystroke, then asks once", async () => {
    render(<SignupPage />);
    type("ana");
    await settle(200);
    type("ana.");
    await settle(200);
    type("ana.k");
    expect(status().dataset.status).toBe("checking");
    await settle(300);
    expect(h.fetch).not.toHaveBeenCalled();
    await settle(150);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = h.fetch.mock.calls[0];
    expect(url).toBe("/api/handle-available");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ handle: "ana.k" });
  });

  it("available: a check mark and the words '@name is available' (not colour alone)", async () => {
    render(<SignupPage />);
    type("@Ana.K");
    await settle();
    expect(status().dataset.status).toBe("available");
    expect(status().dataset.tone).toBe("ok");
    expect(status().textContent).toBe("@ana.k is available");
    expect(status().querySelector("svg")).toBeTruthy();
  });

  it("taken: 'already taken', in red, and it never says by whom", async () => {
    h.fetch.mockResolvedValue(answer(false));
    render(<SignupPage />);
    type("ana.k");
    await settle();
    expect(status().dataset.status).toBe("taken");
    expect(status().dataset.tone).toBe("fail");
    expect(status().textContent).toBe("@ana.k is already taken");
    expect(field().getAttribute("aria-invalid")).toBe("true");
  });

  it("a reserved word reads 'already taken' without asking anyone", async () => {
    render(<SignupPage />);
    type("admin");
    await settle();
    expect(status().textContent).toBe("@admin is already taken");
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("only the newest answer counts: a slow answer for an old name is never shown", async () => {
    let release: (v: unknown) => void = () => {};
    h.fetch.mockImplementationOnce(() => new Promise((r) => (release = r)));
    h.fetch.mockResolvedValueOnce(answer(false));
    render(<SignupPage />);
    type("first.name");
    await settle();
    type("second.name");
    await settle();
    await act(async () => release(answer(true)));
    expect(status().textContent).toBe("@second.name is already taken");
  });

  it("when the check cannot answer (limit, outage) it says so and lets the person go on", async () => {
    h.fetch.mockResolvedValue({ ok: false, json: async () => ({ error: "rate_limited" }) });
    render(<SignupPage />);
    type("ana.k");
    await settle();
    expect(status().dataset.status).toBe("unknown");
    expect(status().textContent).toContain(en.signup.handleUnknown);
    h.fetch.mockRejectedValue(new Error("offline"));
    type("ana.kk");
    await settle();
    expect(status().dataset.status).toBe("unknown");
  });

  async function fillRest() {
    fireEvent.change(screen.getByLabelText(en.signup.email), { target: { value: "ana@example.com" } });
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en.signup.password}`)), { target: { value: "longenough1" } });
    fireEvent.change(screen.getByLabelText(new RegExp(`^${en.signup.confirm}`)), { target: { value: "longenough1" } });
    fireEvent.click(screen.getByRole("checkbox"));
  }
  const send = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.signup.submit }));
    });
  };

  it("submit is blocked while the name is empty, malformed, being checked or taken", async () => {
    h.fetch.mockResolvedValue(answer(false));
    render(<SignupPage />);
    await fillRest();
    await send();
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errHandle);
    type("a..b");
    await send();
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errHandle);
    type("ana.k");
    // still being checked: the button waits (disabled), nothing is sent and no error is shown yet
    expect((screen.getByRole("button", { name: en.signup.submit }) as HTMLButtonElement).disabled).toBe(true);
    await send();
    expect(h.signUp).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    await settle(); // taken
    expect((screen.getByRole("button", { name: en.signup.submit }) as HTMLButtonElement).disabled).toBe(false);
    await send();
    expect(screen.getByRole("alert").textContent).toContain(en.signup.errHandle);
    expect(h.signUp).not.toHaveBeenCalled();
  });

  it("with an available name the account is created and the name rides in the sign-up metadata", async () => {
    render(<SignupPage />);
    await fillRest();
    type("Ana.K");
    await settle();
    await send();
    expect(h.signUp).toHaveBeenCalledTimes(1);
    const arg = h.signUp.mock.calls[0][0];
    expect(arg.options.data).toEqual({ signup_handle: "ana.k" });
    expect(arg.email).toBe("ana@example.com");
    expect(document.body.textContent).toContain(en.signup.checkTitle);
  });

  it("when the account is live at once (no e-mail confirmation) the name is set right after sign-up", async () => {
    h.signUp.mockResolvedValue({ data: { user: { identities: [{}] }, session: { access_token: "t" } }, error: null });
    render(<SignupPage />);
    await fillRest();
    type("ana.k");
    await settle();
    await send();
    expect(h.rpc).toHaveBeenCalledWith("set_handle", { p_handle: "ana.k" });
    expect(h.push).toHaveBeenCalledWith("/welcome");
  });

  it("a name taken in the meantime does not block the new account", async () => {
    h.signUp.mockResolvedValue({ data: { user: { identities: [{}] }, session: { access_token: "t" } }, error: null });
    h.rpc.mockResolvedValue({ data: { code: "taken" }, error: null });
    render(<SignupPage />);
    await fillRest();
    type("ana.k");
    await settle();
    await send();
    expect(h.push).toHaveBeenCalledWith("/welcome");
  });
});

describe("sign-up does not confirm which addresses are registered (BR-S-022)", () => {
  async function submitWith(result: unknown) {
    h.signUp.mockResolvedValue(result);
    render(<SignupPage />);
    fireEvent.change(screen.getByLabelText(/email/i, { selector: "input[type=email]" }), { target: { value: "owner@example.com" } });
    type("ana.k");
    await settle();
    const pw = document.querySelectorAll("input[type=password]");
    fireEvent.change(pw[0], { target: { value: "correct horse battery" } });
    fireEvent.change(pw[1], { target: { value: "correct horse battery" } });
    fireEvent.click(document.querySelector("input[type=checkbox]") as HTMLInputElement);
    await act(async () => {
      fireEvent.submit(document.querySelector("form") as HTMLFormElement);
      await vi.advanceTimersByTimeAsync(10);
    });
    return document.body.textContent ?? "";
  }

  it("an address that already has an account gets the same screen as a new one", async () => {
    const text = await submitWith({ data: { user: { identities: [] }, session: null }, error: null });
    expect(text).toContain(en.signup.checkTitle);
    expect(text).toContain("owner@example.com");
    expect(text).not.toMatch(/already (exists|registered)/i);
    cleanup();
    const fresh = await submitWith({ data: { user: { identities: [{}] }, session: null }, error: null });
    expect(fresh).toContain(en.signup.checkTitle);
  });

  it("the same when the project answers with an 'already registered' error", async () => {
    const text = await submitWith({ data: { user: null, session: null }, error: { status: 422, code: "user_already_exists", message: "User already registered" } });
    expect(text).toContain(en.signup.checkTitle);
    expect(text).not.toMatch(/already (exists|registered)/i);
  });
});
