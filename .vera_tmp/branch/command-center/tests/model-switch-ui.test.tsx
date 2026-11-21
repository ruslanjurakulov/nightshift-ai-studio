// @vitest-environment jsdom
/**
 * The owner's model switches: what a tap does and what it never does.
 *
 * Nothing is sent by the first tap of Switch off: a form (reason, note) comes first, then the database is asked how many jobs the switch-off
 * touches, then the confirmation shows that number, and only the confirmation sends the switch, with confirm:true. Switch on asks once.
 * While the switches are not in force every button is disabled and the page says why. A model whose provider is off says it stays hidden.
 * Every refusal is worded in the person's language, the owner's reason is shown to the owner and nobody else, and every control is a real
 * button (44 px) that names what it changes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { jsonRes } from "./helpers/response";
import { en } from "../lib/i18n/en";
import { ru } from "../lib/i18n/ru";
import { uz } from "../lib/i18n/uz";
import { SWITCH_REASONS, coerceSwitchDoc, type SwitchDoc } from "../lib/model-switch";

const h = vi.hoisted(() => ({ fetch: vi.fn(), refresh: vi.fn(), toast: vi.fn(), locale: "en" as "en" | "ru" | "uz" }));

vi.mock("@/lib/i18n/context", async () => {
  const dicts = { en: (await import("../lib/i18n/en")).en, ru: (await import("../lib/i18n/ru")).ru, uz: (await import("../lib/i18n/uz")).uz };
  const { fmt } = await import("../lib/i18n");
  return { useI18n: () => ({ t: dicts[h.locale], locale: h.locale, fmt, setLocale: () => {} }) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh }) }));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: h.toast, error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { ModelSwitchBoard } from "../components/models/ModelSwitchBoard";

const s = en.modelSwitch;
const model = (id: string, name: string, over: Record<string, unknown> = {}) => ({
  id,
  display_name: name,
  capabilities: ["t2v"],
  availability: "ga",
  switch: null,
  hidden: false,
  ...over,
});
const doc = (over: Record<string, unknown> = {}): SwitchDoc =>
  coerceSwitchDoc({
    enforced: true,
    auto_suggest: false,
    suggest_threshold: 3,
    suggest_window_minutes: 60,
    providers: [
      {
        provider: "bytedance",
        switch: null,
        hidden: false,
        models: [model("seedance-1.0-pro", "Seedance 1.0 Pro"), model("seedance-1.5-pro", "Seedance 1.5 Pro", { availability: "beta" })],
      },
      {
        provider: "google",
        switch: { enabled: false, reason: "out_of_funds", note: "wallet empty", changed_at: "2026-10-25T10:00:00Z", changed_by_email: "owner@a.uz" },
        hidden: true,
        models: [
          model("veo-3.1", "Veo 3.1", { hidden: true }),
          model("gemini-3-pro-image", "Gemini 3 Pro Image", { hidden: true, capabilities: ["t2i"], switch: { enabled: true, reason: null, note: null, changed_at: "2026-10-24T10:00:00Z", changed_by_email: "owner@a.uz" } }),
        ],
      },
    ],
    alerts: [],
    log: [],
    ...over,
  })!;

const show = (d: SwitchDoc = doc()) => render(<ModelSwitchBoard doc={d} />);
const card = (provider: string) => within(document.querySelector(`[data-provider="${provider}"]`) as HTMLElement);
const sheet = () => screen.getByRole("alertdialog");
const tap = async (el: HTMLElement) => {
  await act(async () => {
    fireEvent.click(el);
  });
};
const sent = (n = 0) => {
  const [url, init] = h.fetch.mock.calls[n] as [string, RequestInit];
  return { url, body: JSON.parse(String(init.body)) as Record<string, unknown> };
};
const PREVIEW = { ok: true, models: 2, queued: 2, running: 1, waiting: 3, in_flight: 1 };

beforeEach(() => {
  h.locale = "en";
  h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body ?? "{}"));
    if (b.action === "preview") return jsonRes(PREVIEW);
    return jsonRes({ ok: true, jobs_stopped: 3, in_flight: 1, enabled: b.enabled });
  });
  h.refresh.mockReset();
  h.toast.mockReset();
  vi.stubGlobal("fetch", h.fetch);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the owner reads", () => {
  it("each provider and each model has its status in words, never by colour alone", () => {
    show();
    const bytedance = card("bytedance");
    expect(bytedance.getAllByText(s.status.on).length).toBeGreaterThan(0);
    const google = card("google");
    expect(google.getAllByText(s.status.hidden).length).toBeGreaterThan(0);
    // a model that is on under a provider that is off stays hidden and says why
    const gem = within(document.querySelector('[data-model="gemini-3-pro-image"]') as HTMLElement);
    expect(gem.getByText(s.status.hiddenByProvider)).toBeTruthy();
  });

  it("the lamp is lit in caution for what is hidden and in green for what is not, beside the words", () => {
    show();
    const tone = (el: HTMLElement) => el.closest("[data-tone]")!.getAttribute("data-tone");
    expect(tone(card("google").getAllByText(s.status.hidden)[0])).toBe("warn");
    expect(tone(card("bytedance").getAllByText(s.status.on)[0])).toBe("ok");
  });

  it("shows who switched it, when and why, and 'never switched' for a row that never was", () => {
    show();
    const google = card("google");
    expect(google.getAllByText(/owner@a\.uz/).length).toBeGreaterThan(0);
    expect(google.getAllByText(new RegExp(s.reasons.out_of_funds)).length).toBeGreaterThan(0);
    expect(google.getAllByText(/wallet empty/).length).toBeGreaterThan(0);
    expect(card("bytedance").getAllByText(s.neverChanged).length).toBeGreaterThan(0);
  });

  it("names the sale state beside a model without changing it, and says a switch never changes it", () => {
    show();
    expect(screen.getByText(s.saleNote)).toBeTruthy();
    expect(screen.getByText(s.providerHint)).toBeTruthy();
    expect(screen.getByText(s.pipelineNote)).toBeTruthy();
    expect(document.querySelector('[data-model="seedance-1.5-pro"]')!.textContent).toContain(s.sale.beta);
    expect(document.querySelector('[data-model="seedance-1.0-pro"]')!.textContent).toContain(s.sale.ga);
  });

  it("when the switches are not in force it says so, and every button is disabled", () => {
    show(doc({ enforced: false }));
    expect(screen.getByText(s.notInForce.title)).toBeTruthy();
    const buttons = screen.getAllByRole("button", { name: /: (on|off)$/ });
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) expect((b as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("switch-in-force")).toBeNull();
  });

  it("a row recorded as off while the switches are not in force does not claim to be hidden", () => {
    show(doc({ enforced: false, providers: [{ provider: "google", switch: { enabled: false, reason: "other", note: null, changed_at: "2026-10-25T10:00:00Z", changed_by_email: "owner@a.uz" }, hidden: false, models: [model("veo-3.1", "Veo 3.1")] }] }));
    expect(card("google").getAllByText(s.status.offNotInForce).length).toBeGreaterThan(0);
    expect(card("google").queryByText(s.status.hidden)).toBeNull();
  });

  it("when they are in force it says so", () => {
    show();
    expect(screen.getByTestId("switch-in-force")).toBeTruthy();
    expect(screen.queryByText(s.notInForce.title)).toBeNull();
  });

  it("lists the last changes with who, what, why and how many jobs it stopped, and a change made in the SQL editor reads as that", () => {
    show(
      doc({
        log: [
          { at: "2026-10-25T10:00:00Z", kind: "switch", scope: "provider", target: "google", enabled: false, previous_enabled: null, reason: "out_of_funds", note: "wallet empty", jobs_stopped: 2, in_flight: 1, actor_email: "owner@a.uz", detail: {} },
          { at: "2026-10-25T09:00:00Z", kind: "settings", scope: null, target: null, enabled: null, previous_enabled: null, reason: null, note: null, jobs_stopped: 0, in_flight: 0, actor_email: null, detail: {} },
        ],
      }),
    );
    const rows = screen.getAllByTestId("switch-log-row");
    expect(rows[0].textContent).toContain("owner@a.uz");
    expect(rows[0].textContent).toContain("switched provider google off");
    expect(rows[0].textContent).toContain(`${s.log.stopped}: 2`);
    expect(rows[1].textContent).toContain(s.log.system);
    expect(rows[1].textContent).toContain(s.log.settings);
  });

  it("an empty log and no alerts say so", () => {
    show();
    expect(screen.getByText(s.log.empty)).toBeTruthy();
    expect(screen.getByText(s.alerts.none)).toBeTruthy();
    expect(screen.getByText(s.alerts.off)).toBeTruthy();
  });
});

describe("switching off", () => {
  const open = async (provider = "bytedance") => {
    await tap(card(provider).getAllByRole("button", { name: `${provider === "bytedance" ? "bytedance (Seedance 1.0 Pro, Seedance 1.5 Pro): on" : ""}` })[0]);
  };

  it("the first tap sends nothing: it opens a form that needs a reason", async () => {
    show();
    await open();
    expect(h.fetch).not.toHaveBeenCalled();
    const form = card("bytedance").getByRole("form");
    const review = within(form).getByRole("button", { name: s.form.review }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    const select = within(form).getByLabelText(s.reasonLabel) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(["", ...SWITCH_REASONS]);
    fireEvent.change(select, { target: { value: "out_of_funds" } });
    expect(review.disabled).toBe(false);
  });

  it("submitting the form without a reason (Enter on the note) sends nothing, not even the count", async () => {
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(h.fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("asks the database how many jobs it touches, shows that number, and sends the switch only from the confirmation", async () => {
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "out_of_funds" } });
    fireEvent.change(within(form).getByLabelText(s.noteLabel), { target: { value: "balance empty" } });
    await tap(within(form).getByRole("button", { name: s.form.review }));
    // the preview went first and it was only a preview
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(sent(0)).toEqual({ url: "/api/owner/model-switch", body: { action: "preview", scope: "provider", target: "bytedance" } });
    const dlg = within(sheet());
    expect(dlg.getByText(s.confirmOff.waiting).parentElement!.textContent).toContain("3");
    expect(dlg.getByText(s.confirmOff.inFlight).parentElement!.textContent).toContain("1");
    expect(dlg.getByText(s.confirmOff.modelsAffected).parentElement!.textContent).toContain("2");
    expect(dlg.getByText(s.reasons.out_of_funds)).toBeTruthy();
    expect(dlg.getByText("balance empty")).toBeTruthy();
    await tap(dlg.getByRole("button", { name: s.confirmOff.confirm }));
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(sent(1)).toEqual({
      url: "/api/owner/model-switch",
      body: { action: "set", scope: "provider", target: "bytedance", enabled: false, reason: "out_of_funds", note: "balance empty", confirm: true },
    });
    expect(screen.getByTestId("switch-message").textContent).toBe(`Switched off. Jobs stopped: 3. Already with the vendor: 1.`);
    expect(h.refresh).toHaveBeenCalled();
  });

  async function switchOffBytedance() {
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "out_of_funds" } });
    await tap(within(form).getByRole("button", { name: s.form.review }));
    await tap(within(sheet()).getByRole("button", { name: s.confirmOff.confirm }));
  }
  const sets = () => h.fetch.mock.calls.filter((c) => JSON.parse(String((c[1] as RequestInit).body)).action === "set").length;

  it("a long queue is stopped in batches: the same switch-off is sent again until the database says nothing is left", async () => {
    const answers = [
      { ok: true, jobs_stopped: 200, in_flight: 1, remaining: 202, complete: false },
      { ok: true, jobs_stopped: 200, in_flight: 1, remaining: 2, complete: false },
      { ok: true, jobs_stopped: 2, in_flight: 1, remaining: 0, complete: true },
    ];
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      return jsonRes(b.action === "preview" ? PREVIEW : answers.shift() ?? { ok: true, jobs_stopped: 0, remaining: 0 });
    });
    await switchOffBytedance();
    expect(sets()).toBe(3);
    expect(screen.getByTestId("switch-message").textContent).toBe("Switched off. Jobs stopped: 402. Already with the vendor: 1.");
  });

  it("stops asking when a call stops nothing (workers hold the rest) and says what is still waiting and that none can be sent", async () => {
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      return jsonRes(b.action === "preview" ? PREVIEW : { ok: true, jobs_stopped: 0, in_flight: 1, remaining: 4, complete: false });
    });
    await switchOffBytedance();
    expect(sets()).toBe(1);
    const text = screen.getByTestId("switch-message").textContent!;
    expect(text).toContain("Jobs stopped: 0");
    expect(text).toContain(s.done.stillWaiting.replace("{remaining}", "4"));
    expect(text).toContain("None of them can be sent");
  });

  it("a later batch that fails says the model is already off and that the waiting jobs cannot be sent, never 'nothing was changed'", async () => {
    let n = 0;
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.action === "preview") return jsonRes(PREVIEW);
      n += 1;
      return n === 1 ? jsonRes({ ok: true, jobs_stopped: 200, in_flight: 1, remaining: 9, complete: false }) : jsonRes({ ok: false, error: "rpc_failed" }, 502);
    });
    await switchOffBytedance();
    expect(sets()).toBe(2);
    const dlg = within(sheet());
    expect(dlg.getByText(new RegExp(s.done.sweepInterrupted.slice(0, 30)))).toBeTruthy();
    expect(sheet().textContent).not.toContain("Nothing was changed");
  });

  it("a retry whose first call fails still says the model is off: the switch row was already written by an earlier call", async () => {
    let n = 0;
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.action === "preview") return jsonRes(PREVIEW);
      n += 1;
      return n === 1 ? jsonRes({ ok: true, jobs_stopped: 200, in_flight: 1, remaining: 9, complete: false }) : jsonRes({ ok: false, error: "rate_limited" }, 429);
    });
    await switchOffBytedance();
    expect(sheet().textContent).toContain(s.done.sweepInterrupted);
    // the owner presses the confirmation again: call 0 of the retry is refused (rate limit), the earlier call had written the switch
    await tap(within(sheet()).getByRole("button", { name: s.confirmOff.confirm }));
    expect(sets()).toBe(3);
    expect(sheet().textContent).toContain(s.done.sweepInterrupted);
    expect(sheet().textContent).not.toContain("Nothing was changed");
    expect(sheet().textContent).not.toContain("Too many changes just now");
  });

  it("closing the confirmation after an interrupted sweep leaves a message that the model is off", async () => {
    let n = 0;
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      if (b.action === "preview") return jsonRes(PREVIEW);
      n += 1;
      return n === 1 ? jsonRes({ ok: true, jobs_stopped: 200, in_flight: 1, remaining: 9, complete: false }) : jsonRes({ ok: false, error: "rate_limited" }, 429);
    });
    await switchOffBytedance();
    await tap(within(sheet()).getByRole("button", { name: /cancel/i }));
    expect(screen.getByTestId("switch-message").textContent).toBe(s.done.sweepInterrupted);
    expect(h.refresh).toHaveBeenCalled();
  });

  it("a first call that is refused with nothing written shows the refusal, not the already-off wording", async () => {
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      return b.action === "preview" ? jsonRes(PREVIEW) : jsonRes({ ok: false, error: "rate_limited" }, 429);
    });
    await switchOffBytedance();
    expect(sets()).toBe(1);
    expect(sheet().textContent).toContain("Too many changes just now");
    expect(sheet().textContent).not.toContain(s.done.sweepInterrupted);
  });

  it("never asks for more than the 60 calls the database allows in a 10-minute window", async () => {
    h.fetch.mockReset().mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      return jsonRes(b.action === "preview" ? PREVIEW : { ok: true, jobs_stopped: 200, in_flight: 1, remaining: 100000, complete: false });
    });
    await switchOffBytedance();
    expect(sets()).toBe(60);
    expect(screen.getByTestId("switch-message").textContent).toContain(s.done.stillWaiting.replace("{remaining}", "100000"));
  });

  it("says in all three languages that a batch is a plain off, that every request is logged, and what the rate limit does", () => {
    for (const d of [en, ru, uz]) expect(d.modelSwitch.sweepNote.length).toBeGreaterThan(60);
    expect(s.sweepNote).toContain("200");
    expect(s.sweepNote).toContain("60 requests per 10 minutes");
    expect(s.sweepNote).toContain("plain “off”");
    expect(s.sweepNote).toContain("logged");
    show();
    expect(screen.getByText(s.sweepNote)).toBeTruthy();
  });

  it("cancelling the confirmation sends no switch", async () => {
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "other" } });
    await tap(within(form).getByRole("button", { name: s.form.review }));
    await tap(within(sheet()).getByRole("button", { name: en.confirmSheets ? /cancel/i : /cancel/i }));
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });

  it("a note with line breaks is flattened to one line and one that is too long cannot be reviewed", async () => {
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "other" } });
    const note = within(form).getByLabelText(s.noteLabel) as HTMLInputElement;
    fireEvent.change(note, { target: { value: "a\tb\t\tc" } });
    expect(note.value).toBe("a b c");
    fireEvent.change(note, { target: { value: "x".repeat(201) } });
    expect((within(form).getByRole("button", { name: s.form.review }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("when the preview cannot be read nothing is switched off and the page says so", async () => {
    h.fetch.mockImplementation(async () => jsonRes({ ok: false, error: "rpc_failed" }, 502));
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "other" } });
    await tap(within(form).getByRole("button", { name: s.form.review }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("switch-message").textContent).toContain(s.confirmOff.previewFailed);
  });

  it("a refusal on the switch itself is worded in the sheet and the form stays", async () => {
    h.fetch.mockImplementation(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? "{}"));
      return b.action === "preview" ? jsonRes(PREVIEW) : jsonRes({ ok: false, error: "owner_required" }, 422);
    });
    show();
    await open();
    const form = card("bytedance").getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "other" } });
    await tap(within(form).getByRole("button", { name: s.form.review }));
    await tap(within(sheet()).getByRole("button", { name: s.confirmOff.confirm }));
    expect(within(sheet()).getByText(s.err.owner_required)).toBeTruthy();
  });

  it("a model switch-off is its own call with scope model, and no models-affected line", async () => {
    show();
    const row = within(document.querySelector('[data-model="seedance-1.5-pro"]') as HTMLElement);
    await tap(row.getByRole("button", { name: "Seedance 1.5 Pro: on" }));
    const form = row.getByRole("form");
    fireEvent.change(within(form).getByLabelText(s.reasonLabel), { target: { value: "vendor_outage" } });
    await tap(within(form).getByRole("button", { name: s.form.review }));
    expect(sent(0).body).toEqual({ action: "preview", scope: "model", target: "seedance-1.5-pro" });
    expect(within(sheet()).queryByText(s.confirmOff.modelsAffected)).toBeNull();
    await tap(within(sheet()).getByRole("button", { name: s.confirmOff.confirm }));
    expect(sent(1).body).toMatchObject({ action: "set", scope: "model", target: "seedance-1.5-pro", enabled: false, reason: "vendor_outage", confirm: true });
    expect("note" in sent(1).body).toBe(false);
  });
});

describe("switching on", () => {
  it("asks once, sends enabled:true with no reason, and says the stopped jobs stay stopped", async () => {
    show();
    await tap(card("google").getAllByRole("button", { name: /google.*: off$/ })[0]);
    expect(h.fetch).not.toHaveBeenCalled();
    expect(within(sheet()).getByText(s.confirmOn.body)).toBeTruthy();
    await tap(within(sheet()).getByRole("button", { name: s.confirmOn.confirm }));
    expect(sent(0)).toEqual({ url: "/api/owner/model-switch", body: { action: "set", scope: "provider", target: "google", enabled: true } });
  });

  it("a model switched on under a provider that is still off is told it stays hidden", async () => {
    const d = doc({
      providers: [
        {
          provider: "google",
          switch: { enabled: false, reason: "other", note: null, changed_at: "2026-10-25T10:00:00Z", changed_by_email: "owner@a.uz" },
          hidden: true,
          models: [model("veo-3.1", "Veo 3.1", { hidden: true, switch: { enabled: false, reason: "other", note: null, changed_at: "2026-10-25T10:00:00Z", changed_by_email: "owner@a.uz" } })],
        },
      ],
    });
    show(d);
    await tap(within(document.querySelector('[data-model="veo-3.1"]') as HTMLElement).getByRole("button", { name: "Veo 3.1: off" }));
    await tap(within(sheet()).getByRole("button", { name: s.confirmOn.confirm }));
    expect(screen.getByTestId("switch-message").textContent).toBe(s.done.onStillHidden);
  });
});

describe("the alert", () => {
  const withAlert = () =>
    doc({
      auto_suggest: true,
      alerts: [{ id: 4, provider: "bytedance", kind: "may_be_out_of_funds", failures: 5, window_minutes: 60, first_at: "2026-10-25T09:00:00Z", last_at: "2026-10-25T09:50:00Z" }],
    });

  it("says which provider may be out of funds, that it is only a suggestion, and offers to dismiss it", async () => {
    show(withAlert());
    const alert = within(screen.getByTestId("switch-alert"));
    expect(alert.getByText(/bytedance \(Seedance 1\.0 Pro, Seedance 1\.5 Pro\) may be out of funds: 5 jobs failed/)).toBeTruthy();
    expect(alert.getByText(s.alerts.note)).toBeTruthy();
    expect(screen.getByText("Alert on a likely empty balance: on (3 failures in 60 minutes).")).toBeTruthy();
    h.fetch.mockImplementation(async () => jsonRes({ ok: true, id: 4 }));
    await tap(alert.getByRole("button", { name: s.alerts.dismiss }));
    expect(sent(0)).toEqual({ url: "/api/owner/model-switch", body: { action: "dismiss", id: 4 } });
    expect(screen.getByTestId("switch-message").textContent).toBe(s.alerts.dismissed);
  });

  it("nothing in the alert switches anything off: the provider's own switch is still the owner's tap", () => {
    show(withAlert());
    expect(h.fetch).not.toHaveBeenCalled();
    expect(card("bytedance").getAllByText(s.status.on).length).toBeGreaterThan(0);
  });
});

describe("three languages", () => {
  it.each(["ru", "uz"] as const)("%s: the board, the form and the confirmation are in that language", async (loc) => {
    h.locale = loc;
    const d = { ru, uz }[loc].modelSwitch;
    show();
    expect(screen.getAllByText(d.status.on).length).toBeGreaterThan(0);
    expect(screen.getAllByText(d.status.hidden).length).toBeGreaterThan(0);
    await tap(card("bytedance").getAllByRole("button", { name: /bytedance.*: /})[0]);
    const form = card("bytedance").getByRole("form");
    expect(within(form).getByLabelText(d.reasonLabel)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(d.reasonLabel), { target: { value: "terms_review" } });
    await tap(within(form).getByRole("button", { name: d.form.review }));
    expect(within(sheet()).getByText(d.confirmOff.waiting)).toBeTruthy();
    expect(within(sheet()).getByText(d.reasons.terms_review)).toBeTruthy();
  });

  it("every control is a real button, and the toggles name what they change", () => {
    show();
    for (const b of screen.getAllByRole("button", { name: /: (on|off)$/ })) {
      expect(b.tagName).toBe("BUTTON");
      expect(b.getAttribute("type")).toBe("button");
      expect(b.className).toContain("min-h-11");
    }
    expect(screen.queryByRole("button", { name: /all|every|everything/i })).toBeNull();
  });
});
