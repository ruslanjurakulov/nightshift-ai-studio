// @vitest-environment jsdom
/**
 * Owner safety, part 3: pipeline routing (the screen follows the saved state,
 * not the tap), the two-factor board (honest states, a stronger confirm on the
 * last factor, the same-phone enrolment link, cancel) and the 2FA banner.
 */
import { jsonRes } from "./helpers/response";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { en } from "../lib/i18n/en";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  mfa: {
    listFactors: vi.fn(),
    getAuthenticatorAssuranceLevel: vi.fn(),
    enroll: vi.fn(),
    challenge: vi.fn(),
    verify: vi.fn(),
    unenroll: vi.fn(),
  },
}));

vi.mock("@/lib/i18n/context", async () => {
  const { en } = await import("../lib/i18n/en");
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: en, locale: "en", fmt, setLocale: () => {} }) };
});
vi.mock("next/link", () => ({ default: ({ href, children, ...r }: { href: string; children: React.ReactNode }) => <a href={href} {...r}>{children}</a> }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: h.toastError, info: h.toastInfo, show: vi.fn(), dismiss: vi.fn() }),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ auth: { mfa: h.mfa } }) }));

import { PipelineRouting } from "../components/providers/PipelineRouting";
import { SecurityBoard } from "../components/security/SecurityBoard";
import { AdminMfaBanner, MFA_BANNER_DISMISS_KEY, MFA_BANNER_QUIET_MS } from "../components/security/AdminMfaBanner";

beforeEach(() => {
  h.fetch.mockReset().mockImplementation(async () => jsonRes({}));
  vi.stubGlobal("fetch", h.fetch);
  h.toast.mockReset();
  h.toastError.mockReset();
  h.toastInfo.mockReset();
  for (const f of Object.values(h.mfa)) f.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});

const sheet = () => screen.getByRole("alertdialog");
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const variablesCalls = () => h.fetch.mock.calls.filter((c) => c[0] === "/api/setup/variables");

describe("PipelineRouting", () => {
  const show = (initial: Record<string, string> = {}) => render(<PipelineRouting initial={initial} configured={[]} githubConfigured />);
  const videoSelect = () => screen.getByLabelText(en.providers.routingVideo) as HTMLSelectElement;
  const autopilot = () => screen.getByRole("switch", { name: en.providers.routingAutopilot });

  it("a generator change asks first, shows now → new, and writes nothing until confirmed", async () => {
    show();
    expect(videoSelect().value).toBe("off");
    fireEvent.change(videoSelect(), { target: { value: "kling" } });
    await act(async () => {});
    expect(sheet().textContent).toContain("Switch the video generator to “Kling”?");
    expect(sheet().textContent).toContain(en.ownerSafety.routeSwitchKeyMissing);
    expect(within(sheet()).getByText(en.providers.routingStock)).toBeTruthy();
    expect(variablesCalls()).toHaveLength(0);
    // the screen still shows the generator the pipeline really uses
    expect(videoSelect().value).toBe("off");
  });

  it("Cancel leaves the old generator and writes nothing", async () => {
    show();
    fireEvent.change(videoSelect(), { target: { value: "kling" } });
    await act(async () => {});
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(variablesCalls()).toHaveLength(0);
    expect(videoSelect().value).toBe("off");
  });

  it("a failed save rolls back: the choice is NOT shown as chosen, and the sheet says why", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({ error: "boom" }, 500));
    show();
    fireEvent.change(videoSelect(), { target: { value: "kling" } });
    await act(async () => {});
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.routeSwitchConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.providers.routingFailed);
    expect(videoSelect().value).toBe("off");
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(videoSelect().value).toBe("off");
  });

  it("a network error rolls back too", async () => {
    h.fetch.mockRejectedValueOnce(new Error("offline"));
    show();
    fireEvent.change(videoSelect(), { target: { value: "kling" } });
    await act(async () => {});
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.routeSwitchConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.ownerTruth.offline);
    expect(videoSelect().value).toBe("off");
  });

  it("a saved change moves the screen, writes the whole consistent set once on a double tap", async () => {
    let finish: (v: unknown) => void = () => {};
    h.fetch.mockImplementation(() => new Promise((r) => (finish = r)));
    show();
    fireEvent.change(videoSelect(), { target: { value: "kling" } });
    await act(async () => {});
    const key = within(sheet()).getByRole("button", { name: en.ownerSafety.routeSwitchConfirm });
    fireEvent.click(key);
    fireEvent.click(key);
    expect(variablesCalls()).toHaveLength(1);
    expect(JSON.parse(variablesCalls()[0][1].body)).toEqual({
      variables: { CHRONOS_VIDEO_PROVIDER: "kling", CHRONOS_ENABLE_VIDEO_GEN: "1", CHRONOS_ENABLE_MINIMAX_BROLL: "0" },
    });
    await act(async () => finish(jsonRes({})));
    expect(videoSelect().value).toBe("kling");
    expect(h.toast).toHaveBeenCalledWith(en.providers.routingSaved);
  });

  it("a coded refusal from the server (recent code required) is worded in the sheet, never the raw code", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({ error: "mfa_recent_required" }, 500));
    show();
    fireEvent.change(videoSelect(), { target: { value: "kling" } });
    await act(async () => {});
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.routeSwitchConfirm }));
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.mfa.recentRequired);
    expect(videoSelect().value).toBe("off");
  });

  it("turning autopilot on asks first; a failed save leaves it off", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({}, 500));
    show();
    expect(autopilot().getAttribute("aria-checked")).toBe("false");
    await tap(autopilot());
    expect(sheet().textContent).toContain(en.ownerSafety.routeAutopilotTitle);
    expect(variablesCalls()).toHaveLength(0);
    expect(autopilot().getAttribute("aria-checked")).toBe("false");
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.routeAutopilotConfirm }));
    expect(within(sheet()).getByRole("alert")).toBeTruthy();
    expect(autopilot().getAttribute("aria-checked")).toBe("false");
    // retry succeeds
    await tap(within(sheet()).getByRole("button", { name: en.ownerSafety.routeAutopilotConfirm }));
    expect(autopilot().getAttribute("aria-checked")).toBe("true");
  });

  it("turning autopilot off needs no sheet, but the switch moves only after the save landed", async () => {
    h.fetch.mockResolvedValueOnce(jsonRes({}, 500));
    show({ CHRONOS_AGENT_AUTOPILOT: "1" });
    expect(autopilot().getAttribute("aria-checked")).toBe("true");
    await tap(autopilot());
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(autopilot().getAttribute("aria-checked")).toBe("true");
    expect(h.toastError).toHaveBeenCalled();
    await tap(autopilot());
    expect(autopilot().getAttribute("aria-checked")).toBe("false");
  });
});

describe("SecurityBoard", () => {
  const factor = (id: string, status: "verified" | "unverified", name = id) => ({ id, status, friendly_name: name });
  const board = async (factors: ReturnType<typeof factor>[] | "error", aal: string | "error" = "aal1") => {
    h.mfa.listFactors.mockResolvedValue(factors === "error" ? { data: null, error: { message: "x" } } : { data: { all: factors }, error: null });
    h.mfa.getAuthenticatorAssuranceLevel.mockResolvedValue(aal === "error" ? { data: null, error: { message: "x" } } : { data: { currentLevel: aal }, error: null });
    render(<SecurityBoard />);
    await waitFor(() => expect(h.mfa.listFactors).toHaveBeenCalled());
    await act(async () => {});
  };
  const removeButtons = () => screen.getAllByRole("button", { name: en.security.remove });

  it("a failed read says 'could not read', never 'no second factor', and retry reads again", async () => {
    await board("error", "error");
    expect(screen.getByRole("alert").textContent).toContain(en.ownerSafety.readFailed);
    expect(screen.queryByText(en.security.noFactors)).toBeNull();
    expect(screen.getByText(en.ownerSafety.levelUnknown)).toBeTruthy();
    h.mfa.listFactors.mockResolvedValue({ data: { all: [] }, error: null });
    await tap(screen.getByRole("button", { name: en.ux.errorRetry }));
    expect(screen.getByText(en.security.noFactors)).toBeTruthy();
  });

  it("really no factors reads 'No second factor yet'", async () => {
    await board([]);
    expect(screen.getByText(en.security.noFactors)).toBeTruthy();
    expect(screen.queryByText(en.ownerSafety.readFailed)).toBeNull();
  });

  it("removing the LAST verified factor needs the word typed, names the consequence, and uses the right error", async () => {
    await board([factor("f1", "verified", "My phone")], "aal2");
    await tap(removeButtons()[0]);
    expect(sheet().textContent).toContain(en.ownerSafety.factorLastTitle);
    expect(sheet().textContent).toContain(en.ownerSafety.factorLastBody);
    const key = within(sheet()).getByRole("button", { name: en.security.remove });
    expect(key.hasAttribute("disabled")).toBe(true);
    fireEvent.click(key);
    expect(h.mfa.unenroll).not.toHaveBeenCalled();
    fireEvent.change(within(sheet()).getByRole("textbox"), { target: { value: "remove" } });
    h.mfa.unenroll.mockResolvedValueOnce({ error: { message: "x" } });
    await tap(key);
    // the REMOVE failure message, not the enrol one
    expect(within(sheet()).getByRole("alert").textContent).toBe(en.ownerSafety.removeFailed);
    expect(en.ownerSafety.removeFailed).not.toBe(en.security.enrollFailed);
    h.mfa.unenroll.mockResolvedValueOnce({ error: null });
    await tap(within(sheet()).getByRole("button", { name: en.security.remove }));
    expect(h.mfa.unenroll).toHaveBeenCalledTimes(2);
    expect(h.mfa.unenroll).toHaveBeenLastCalledWith({ factorId: "f1" });
  });

  it("with two verified factors, removing one names it and does not ask for a typed word", async () => {
    await board([factor("f1", "verified", "My phone"), factor("f2", "verified", "Tablet")], "aal2");
    await tap(removeButtons()[1]);
    expect(sheet().textContent).toContain("Remove “Tablet”?");
    expect(within(sheet()).queryByRole("textbox")).toBeNull();
    expect(within(sheet()).getByRole("button", { name: en.security.remove }).hasAttribute("disabled")).toBe(false);
  });

  it("Cancel on the remove sheet removes nothing", async () => {
    await board([factor("f1", "verified")], "aal2");
    await tap(removeButtons()[0]);
    await tap(within(sheet()).getByRole("button", { name: en.ux.confirmCancel }));
    expect(h.mfa.unenroll).not.toHaveBeenCalled();
  });

  it("an unfinished factor is removed without the heavy confirm", async () => {
    await board([factor("f1", "verified", "Phone"), factor("f2", "unverified", "Old try")]);
    await tap(removeButtons()[1]);
    expect(sheet().textContent).toContain(en.ownerSafety.factorUnverifiedBody);
    expect(within(sheet()).queryByRole("textbox")).toBeNull();
  });

  it("enrolment offers an otpauth link for this phone, a copy-key button, and a working cancel", async () => {
    await board([]);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    h.mfa.enroll.mockResolvedValue({
      data: { id: "new1", totp: { qr_code: "data:image/svg+xml;utf8,<svg/>", secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/Nightshift:me?secret=JBSWY3DPEHPK3PXP" } },
      error: null,
    });
    await tap(screen.getByRole("button", { name: en.security.startEnroll }));
    const link = screen.getByRole("link", { name: en.ownerSafety.openApp });
    expect(link.getAttribute("href")).toBe("otpauth://totp/Nightshift:me?secret=JBSWY3DPEHPK3PXP");
    await tap(screen.getByRole("button", { name: en.ownerSafety.copySecret }));
    expect(writeText).toHaveBeenCalledWith("JBSWY3DPEHPK3PXP");
    // cancel removes the unfinished factor and returns to the start
    h.mfa.unenroll.mockResolvedValue({ error: null });
    await tap(screen.getByRole("button", { name: en.ownerSafety.cancelEnroll }));
    expect(h.mfa.unenroll).toHaveBeenCalledWith({ factorId: "new1" });
    expect(screen.getByRole("button", { name: en.security.startEnroll })).toBeTruthy();
    expect(h.toastInfo).toHaveBeenCalledWith(en.ownerSafety.enrollCancelled);
  });

  it("a failed cancel says so and still leaves the form, with the leftover factor listed to remove", async () => {
    await board([]);
    h.mfa.enroll.mockResolvedValue({ data: { id: "new1", totp: { qr_code: "x", secret: "S", uri: "otpauth://x" } }, error: null });
    await tap(screen.getByRole("button", { name: en.security.startEnroll }));
    h.mfa.unenroll.mockResolvedValue({ error: { message: "x" } });
    h.mfa.listFactors.mockResolvedValue({ data: { all: [factor("new1", "unverified", "")] }, error: null });
    await tap(screen.getByRole("button", { name: en.ownerSafety.cancelEnroll }));
    expect(screen.getByText(en.ownerSafety.cancelFailed)).toBeTruthy();
    expect(screen.getByText(en.security.statusUnverified)).toBeTruthy();
  });

  it("verifying with Go on the keyboard submits the form once", async () => {
    await board([]);
    h.mfa.enroll.mockResolvedValue({ data: { id: "n", totp: { qr_code: "x", secret: "S", uri: "otpauth://x" } }, error: null });
    await tap(screen.getByRole("button", { name: en.security.startEnroll }));
    h.mfa.challenge.mockResolvedValue({ data: { id: "c1" }, error: null });
    h.mfa.verify.mockResolvedValue({ error: null });
    fireEvent.change(screen.getByLabelText(en.security.codeLabel), { target: { value: "123456" } });
    const form = screen.getByLabelText(en.security.codeLabel).closest("form")!;
    await act(async () => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(h.mfa.verify).toHaveBeenCalledTimes(1);
  });
});

describe("AdminMfaBanner", () => {
  const t = en.mfa;
  const show = (action: "warn_enrol" | "warn_complete") => render(<AdminMfaBanner action={action} t={t} path="/x/billing" />);
  const dismiss = () => screen.queryByRole("button", { name: t.bannerDismiss });

  it("the enrol nudge can be hidden, and stays hidden on the next page view", async () => {
    show("warn_enrol");
    expect(screen.getByTestId("admin-mfa-banner")).toBeTruthy();
    await tap(dismiss()!);
    expect(screen.queryByTestId("admin-mfa-banner")).toBeNull();
    expect(Number(window.localStorage.getItem(MFA_BANNER_DISMISS_KEY))).toBeGreaterThan(0);
    cleanup();
    show("warn_enrol");
    await waitFor(() => expect(screen.queryByTestId("admin-mfa-banner")).toBeNull());
  });

  it("it comes back after a day", async () => {
    window.localStorage.setItem(MFA_BANNER_DISMISS_KEY, String(Date.now() - MFA_BANNER_QUIET_MS - 1000));
    show("warn_enrol");
    await act(async () => {});
    expect(screen.getByTestId("admin-mfa-banner")).toBeTruthy();
  });

  it("an aal1 session that must enter a code is never hideable and ignores a stored dismissal", async () => {
    window.localStorage.setItem(MFA_BANNER_DISMISS_KEY, String(Date.now()));
    show("warn_complete");
    await act(async () => {});
    expect(screen.getByTestId("admin-mfa-banner")).toBeTruthy();
    expect(dismiss()).toBeNull();
    expect(screen.getByRole("link", { name: t.bannerCompleteAction }).getAttribute("href")).toBe("/login/verify?next=%2Fx%2Fbilling");
  });

  it("blocked storage does not break it: it shows, and dismissing hides it for this view", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    show("warn_enrol");
    await act(async () => {});
    expect(screen.getByTestId("admin-mfa-banner")).toBeTruthy();
    await tap(dismiss()!);
    expect(screen.queryByTestId("admin-mfa-banner")).toBeNull();
  });

  it("strict enrolment (enrol_only) shows the notice and can never be hidden", async () => {
    window.localStorage.setItem(MFA_BANNER_DISMISS_KEY, String(Date.now()));
    render(<AdminMfaBanner action="enrol_only" t={t} />);
    await act(async () => {});
    expect(screen.getByTestId("admin-mfa-banner")).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.bannerDismiss })).toBeNull();
    expect(screen.getByRole("link", { name: t.bannerEnrolAction }).getAttribute("href")).toBe("/security");
  });

  it("draws nothing for any other action, and the close key is a 44px target", () => {
    expect(renderToStaticMarkup(<AdminMfaBanner action="allow" t={t} />)).toBe("");
    expect(renderToStaticMarkup(<AdminMfaBanner action="challenge" t={t} />)).toBe("");
    show("warn_enrol");
    expect(dismiss()!.className).toContain("size-11");
  });
});
