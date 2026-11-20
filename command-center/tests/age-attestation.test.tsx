// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries } from "@/lib/i18n";

/**
 * The 18+ confirmation (0199). What would break without these: a Google sign-up (which never sees the form's checkbox)
 * reaching Create without being asked; the method being chosen by the browser; an unknown state blocking anyone; a
 * "under 18" answer pretending the models do not exist; a failed save reading as saved.
 */
vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  user: { id: "u1", app_metadata: { provider: "google" } } as { id: string; app_metadata: Record<string, unknown> } | null,
  rpc: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({ getUser: async () => h.user, createClient: async () => ({ rpc: h.rpc }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }), usePathname: () => "/chronos/create" }));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

const { POST, GET } = await import("../app/api/account/age/route");
const { AgeGate } = await import("@/components/age/AgeGate");
const { coerceAgeState, mustAsk } = await import("@/lib/age");
const en = dictionaries.en;
const post = (body: unknown, origin = "http://localhost") =>
  new Request("http://localhost/api/account/age", { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) });

beforeEach(() => {
  h.user = { id: "u1", app_metadata: { provider: "google" } };
  h.rpc.mockReset();
  h.refresh.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("POST /api/account/age", () => {
  it("records a Google account as 'google', whatever the page says, with the current terms version", async () => {
    h.rpc.mockResolvedValue({ data: { state: "adult", recorded: true }, error: null });
    const res = await POST(post({ adult: true, from: "create" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "adult", recorded: true });
    expect(h.rpc).toHaveBeenCalledWith("record_adult_attestation", expect.objectContaining({ p_adult: true, p_method: "google" }));
  });

  it("records an email account by the page that asked", async () => {
    h.user = { id: "u2", app_metadata: { provider: "email" } };
    h.rpc.mockResolvedValue({ data: { state: "minor", recorded: true }, error: null });
    await POST(post({ adult: false, from: "welcome" }));
    expect(h.rpc).toHaveBeenCalledWith("record_adult_attestation", expect.objectContaining({ p_adult: false, p_method: "welcome" }));
  });

  it("refuses a signed-out caller, another site, a body that is not a boolean or a method it does not know", async () => {
    h.user = null;
    expect((await POST(post({ adult: true, from: "create" }))).status).toBe(401);
    h.user = { id: "u1", app_metadata: {} };
    expect((await POST(post({ adult: true, from: "create" }, "https://evil.example"))).status).toBe(403);
    expect((await POST(post({ adult: "yes", from: "create" }))).status).toBe(400);
    expect((await POST(post({ adult: true, from: "google" }))).status).toBe(400);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("says it could not record when the database cannot, never that it saved", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "function does not exist" } });
    const res = await POST(post({ adult: true, from: "create" }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "age_unavailable" });
  });

  it("GET answers unknown, not none, when the state cannot be read", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await (await GET()).json()).toEqual({ state: "unknown" });
  });
});

describe("the states", () => {
  it("asks only on a known 'none'; unknown never stops anyone", () => {
    expect(coerceAgeState({ state: "none" })).toBe("none");
    expect(coerceAgeState({ state: "x" })).toBe("unknown");
    expect(coerceAgeState(null)).toBe("unknown");
    expect(mustAsk("none")).toBe(true);
    expect(mustAsk("unknown")).toBe(false);
  });

  it("locks an adult-only model 'for adults only' until the person confirmed, and never on an unknown state", async () => {
    const { adultLock } = await import("@/lib/age");
    expect(adultLock({ adultOnly: true }, "none")).toBe("adult_only");
    expect(adultLock({ adultOnly: true }, "minor")).toBe("adult_only");
    expect(adultLock({ adultOnly: true }, "adult")).toBeNull();
    expect(adultLock({ adultOnly: true }, "unknown")).toBeNull();
    expect(adultLock({}, "none")).toBeNull();
    const { withTiers } = await import("@/lib/creative/studio");
    const [m] = withTiers([{ id: "gemini-x", displayName: "G", capabilities: ["t2i"], beta: false }], [{ id: "gemini-x", spec: { requires_adult: true } }]);
    expect(m.adultOnly).toBe(true);
    expect(dictionaries.en.gen.lockWhy.adult_only).toBeTruthy();
  });
});

describe("AgeGate", () => {
  const wrap = (ui: React.ReactNode) => <I18nProvider locale="en">{ui}</I18nProvider>;

  it("asks an account with no record (the Google sign-up path lands here) and saves the answer", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ state: "adult", recorded: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(wrap(<AgeGate state="none" from="welcome" />));
    // What each answer means is said before it is given.
    expect(screen.getByText(en.age.consequence)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: en.age.confirm }));
    // The outcome is said where focus lands, from a region mounted before the answer.
    await waitFor(() => expect(screen.getByTestId("age-saved").textContent).toBe(en.age.done));
    expect(document.activeElement).toBe(screen.getByTestId("age-saved"));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ adult: true, from: "welcome" });
    expect(h.refresh).toHaveBeenCalled();
  });

  it("answers 'under 18' with the honest notice: the models exist, for adults only", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ state: "minor", recorded: true }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(wrap(<AgeGate state="none" from="create" contactEmail="help@example.com" />));
    fireEvent.click(screen.getByRole("button", { name: en.age.under }));
    // A permanent answer asks once more, and nothing is sent until it is confirmed; "Go back" returns to the choice.
    expect(screen.getByText(en.age.underSure)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: en.age.goBack }));
    fireEvent.click(screen.getByRole("button", { name: en.age.under }));
    fireEvent.click(screen.getByRole("button", { name: en.age.underConfirm }));
    expect(await screen.findByTestId("age-minor")).toBeTruthy();
    expect(screen.getByRole("link", { name: en.age.contact }).getAttribute("href")).toBe("mailto:help@example.com");
    expect(screen.getByText(en.age.minorBody)).toBeTruthy();
  });

  it("keeps asking, and says so, when the save failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({ error: "age_unavailable" }) })));
    render(wrap(<AgeGate state="none" from="create" />));
    fireEvent.click(screen.getByRole("button", { name: en.age.confirm }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.age.unavailable));
    expect(screen.getByTestId("age-gate")).toBeTruthy();
  });

  it("draws nothing for an adult or an unknown state", () => {
    render(wrap(<><AgeGate state="adult" from="create" /><AgeGate state="unknown" from="create" /></>));
    expect(screen.queryByTestId("age-gate")).toBeNull();
  });
});

describe("routing around a country block keeps the age refusal", () => {
  it("names the age, not the country, when every candidate was refused for it", async () => {
    const { quoteAround } = await import("@/lib/creative/route-around");
    const rows = [{ id: "a", spec: {} }, { id: "b", spec: {} }];
    const db = (word: string) =>
      ({
        rpc: vi.fn(async (fn: string) =>
          fn === "sellable_models" ? { data: rows, error: null } : { data: null, error: { code: "NS400", message: word } },
        ),
      }) as never;
    const input = { orgId: "o", capability: "t2i", model: "", params: {}, mode: "auto", idempotencyKey: null, maxCredits: null } as never;
    expect((await quoteAround(db("adult_only_service"), input, () => false)).body).toMatchObject({ error: "adult_only_service" });
    expect((await quoteAround(db("adult_attestation_required"), input, () => false)).body).toMatchObject({ error: "adult_attestation_required" });
    expect((await quoteAround(db("unpriced"), input, () => false)).status).toBe(451);
  });
});
