// @vitest-environment jsdom
/**
 * The format picker on "Plan a series" (components/series/PlanSeriesPanel.tsx, migration 0122's carrier).
 *
 * What would break without these:
 *  - a press with no format sending anything it did not send before formats existed (an extra argument breaks a database without 0122);
 *  - a format that is not one of the three reaching the database, or "none" sent as an empty string the database would refuse;
 *  - the lists still offering a length or a count the picked format does not fit, or a choice left outside the format;
 *  - a changed format reusing the key of the earlier request (the database refuses a key reused with other terms);
 *  - the page saying the outline follows the format;
 *  - the picker missing in a language, or unreachable by keyboard / label.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ rpc: vi.fn(), push: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: h.push }), usePathname: () => "/chronos/series" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode } & Record<string, unknown>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { PlanSeriesPanel, type RecentPlansView } from "@/components/series/PlanSeriesPanel";
import { FORMAT_TEMPLATES, TEMPLATE_IDS } from "@/lib/seriesTemplates";

const ID = "11111111-2222-3333-4444-555555555555";
const channels = [{ channel_id: "news", name: "News" }];
const recent: RecentPlansView = { state: "ok", plans: [] };

function panel(locale: Locale = "en") {
  let n = 0;
  return render(
    <I18nProvider locale={locale}>
      <PlanSeriesPanel channels={channels} series={[]} canEdit planBase="/chronos/series" recent={recent} randomId={() => `uuid-${++n}-aaaaaaaa`} />
    </I18nProvider>,
  );
}

const s = dictionaries.en.seriesPlan;
const picker = () => document.querySelector("[data-plan-template]") as HTMLSelectElement;
const lengthSelect = () => screen.getByLabelText(s.entry.length) as HTMLSelectElement;
const countSelect = () => screen.getByLabelText(s.entry.episodes) as HTMLSelectElement;
const values = (sel: HTMLSelectElement) => Array.from(sel.options).map((o) => o.value);
const topic = () => screen.getByRole("textbox") as HTMLInputElement;
const submit = () => screen.getByRole("button", { name: s.entry.submit }) as HTMLButtonElement;

beforeEach(() => {
  h.rpc.mockReset();
  h.push.mockReset();
  h.rpc.mockResolvedValue({ data: { id: ID, status: "requested", render_job_id: 1, replayed: false }, error: null });
});
afterEach(() => cleanup());

async function press() {
  fireEvent.click(submit());
  await waitFor(() => expect(h.rpc).toHaveBeenCalled());
}

describe("the picker", () => {
  it("is a labelled select: none first, then the three formats by name, and starts on none", () => {
    panel();
    const el = picker();
    expect(screen.getByLabelText(s.entry.template.label)).toBe(el);
    expect(el.value).toBe("");
    expect(values(el)).toEqual(["", ...TEMPLATE_IDS]);
    expect(Array.from(el.options).map((o) => o.textContent)).toEqual([
      s.entry.template.none,
      s.entry.template.myth_vs_fact.name,
      s.entry.template.top5_countdown.name,
      s.entry.template.one_question_one_answer.name,
    ]);
    expect(el.getAttribute("aria-describedby")).toBe("plan-template-hint");
    expect(document.getElementById("plan-template-hint")?.textContent).toBe("");
  });

  it("is in every language", () => {
    for (const loc of ["ru", "uz"] as const) {
      cleanup();
      panel(loc);
      const t = dictionaries[loc].seriesPlan.entry.template;
      expect(screen.getByLabelText(t.label)).toBe(picker());
      expect(Array.from(picker().options).map((o) => o.textContent)).toEqual([t.none, t.myth_vs_fact.name, t.top5_countdown.name, t.one_question_one_answer.name]);
      fireEvent.change(picker(), { target: { value: "top5_countdown" } });
      expect(document.getElementById("plan-template-hint")?.textContent).toContain(t.top5_countdown.hint);
      expect(document.getElementById("plan-template-hint")?.textContent).toContain(t.notice);
    }
  });

  it("says what the format is, what it fits, and that it is only a request", () => {
    panel();
    fireEvent.change(picker(), { target: { value: "myth_vs_fact" } });
    const hint = document.getElementById("plan-template-hint")?.textContent ?? "";
    expect(hint).toContain(s.entry.template.myth_vs_fact.hint);
    expect(hint).toContain("Fits 3 to 4 episodes of 1 to 8 minutes each.");
    expect(hint).toContain(s.entry.template.notice);
    expect(s.entry.template.notice).toMatch(/request/i);
    expect(hint).not.toMatch(/follow|guarantee|ensure/i);
    expect(hint).not.toMatch(/\{[a-z]+\}/);
    fireEvent.change(picker(), { target: { value: "" } });
    expect(document.getElementById("plan-template-hint")?.textContent).toBe("");
  });
});

describe("what it narrows", () => {
  it("offers only the lengths the format fits and keeps a choice that still fits", () => {
    panel();
    expect(values(lengthSelect())).toEqual(["60", "180", "300", "480", "600"]);
    fireEvent.change(picker(), { target: { value: "one_question_one_answer" } });
    expect(values(lengthSelect())).toEqual(["60", "180", "300"]);
    expect(lengthSelect().value).toBe("300");
    fireEvent.change(picker(), { target: { value: "top5_countdown" } });
    expect(values(lengthSelect())).toEqual(["180", "300", "480", "600"]);
    expect(lengthSelect().value).toBe("300");
    expect(values(countSelect())).toEqual(["3", "4"]);
  });

  it("moves a length that no longer fits to the nearest one that does, in sight, and does not move it back", () => {
    panel();
    fireEvent.change(lengthSelect(), { target: { value: "600" } });
    fireEvent.change(picker(), { target: { value: "one_question_one_answer" } });
    expect(lengthSelect().value).toBe("300");
    fireEvent.change(picker(), { target: { value: "" } });
    expect(values(lengthSelect())).toEqual(["60", "180", "300", "480", "600"]);
    expect(lengthSelect().value).toBe("300");
    fireEvent.change(lengthSelect(), { target: { value: "60" } });
    fireEvent.change(picker(), { target: { value: "top5_countdown" } });
    expect(lengthSelect().value).toBe("180");
  });

  it("narrows and moves the episode count too (the table fits 3 or 4 today, so this narrows the table for one test)", () => {
    const t = FORMAT_TEMPLATES.myth_vs_fact as { episodes: readonly [number, number] };
    const saved = t.episodes;
    t.episodes = [4, 4];
    try {
      panel();
      expect(values(countSelect())).toEqual(["3", "4"]);
      expect(countSelect().value).toBe("3");
      fireEvent.change(picker(), { target: { value: "myth_vs_fact" } });
      expect(values(countSelect())).toEqual(["4"]);
      expect(countSelect().value).toBe("4");
      fireEvent.change(picker(), { target: { value: "" } });
      expect(values(countSelect())).toEqual(["3", "4"]);
      expect(countSelect().value).toBe("4");
    } finally {
      t.episodes = saved;
    }
  });

  it("disables the picker when the form is disabled", () => {
    cleanup();
    render(
      <I18nProvider locale="en">
        <PlanSeriesPanel channels={channels} series={[]} canEdit={false} planBase="/chronos/series" recent={recent} />
      </I18nProvider>,
    );
    expect(picker().disabled).toBe(true);
  });
});

describe("what is sent", () => {
  it("with no format: exactly the arguments that were sent before formats existed, no p_template key at all", async () => {
    panel();
    fireEvent.change(topic(), { target: { value: "Rome" } });
    await press();
    const [, args] = h.rpc.mock.calls[0];
    expect(Object.keys(args).sort()).toEqual(["p_channel", "p_duration_s", "p_idem", "p_language", "p_n", "p_series", "p_topic"]);
    expect("p_template" in args).toBe(false);
  });

  it("with a format: its id, and the length and count moved inside it", async () => {
    panel();
    fireEvent.change(topic(), { target: { value: "Rome" } });
    fireEvent.change(lengthSelect(), { target: { value: "600" } });
    fireEvent.change(picker(), { target: { value: "one_question_one_answer" } });
    await press();
    const [fn, args] = h.rpc.mock.calls[0];
    expect(fn).toBe("request_series_plan");
    expect(args).toMatchObject({ p_template: "one_question_one_answer", p_duration_s: 300, p_n: 3 });
    expect(args.p_idem).toMatch(/^[A-Za-z0-9_:.-]{8,128}$/);
    await waitFor(() => expect(h.push).toHaveBeenCalledWith(`/chronos/series/${ID}`));
  });

  it("each of the three ids is sent as itself", async () => {
    for (const id of TEMPLATE_IDS) {
      cleanup();
      h.rpc.mockClear();
      panel();
      fireEvent.change(topic(), { target: { value: "Rome" } });
      fireEvent.change(picker(), { target: { value: id } });
      await press();
      expect(h.rpc.mock.calls[0][1].p_template, id).toBe(id);
    }
  });

  it("a value that is not one of the options is 'none', never sent", async () => {
    panel();
    fireEvent.change(topic(), { target: { value: "Rome" } });
    fireEvent.change(picker(), { target: { value: "nope" } });
    expect(picker().value).toBe("");
    await press();
    expect("p_template" in h.rpc.mock.calls[0][1]).toBe(false);
  });

  it("a changed format is a different request with a new key; the same press again replays the key", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "NS409", message: "plan_in_progress" } });
    panel();
    fireEvent.change(topic(), { target: { value: "Rome" } });
    fireEvent.change(picker(), { target: { value: "myth_vs_fact" } });
    await press();
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(2));
    expect(h.rpc.mock.calls[1][1].p_idem).toBe(h.rpc.mock.calls[0][1].p_idem);
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.change(picker(), { target: { value: "top5_countdown" } });
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(3));
    expect(h.rpc.mock.calls[2][1].p_idem).not.toBe(h.rpc.mock.calls[0][1].p_idem);
    await waitFor(() => expect(submit().disabled).toBe(false));
    fireEvent.change(picker(), { target: { value: "" } });
    fireEvent.click(submit());
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(4));
    expect(h.rpc.mock.calls[3][1].p_idem).not.toBe(h.rpc.mock.calls[2][1].p_idem);
    expect("p_template" in h.rpc.mock.calls[3][1]).toBe(false);
  });
});

describe("what a refusal says", () => {
  it("the database's word for a format it does not accept is read out in the three languages", async () => {
    for (const loc of ["en", "ru", "uz"] as const) {
      cleanup();
      h.rpc.mockReset();
      h.rpc.mockResolvedValue({ data: null, error: { code: "22023", message: "invalid_template" } });
      panel(loc);
      fireEvent.change(screen.getByRole("textbox"), { target: { value: "Rome" } });
      fireEvent.change(picker(), { target: { value: "myth_vs_fact" } });
      fireEvent.click(screen.getByRole("button", { name: dictionaries[loc].seriesPlan.entry.submit }));
      await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(dictionaries[loc].seriesPlan.entry.errors.invalid_template));
      expect(screen.getByRole("alert").getAttribute("data-plan-error")).toBe("invalid_template");
      expect(h.push).not.toHaveBeenCalled();
    }
  });

  it("'not available yet' is still the answer to a call the database does not allow, with a format too", async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "permission denied for function request_series_plan" } });
    panel();
    fireEvent.change(topic(), { target: { value: "Rome" } });
    fireEvent.change(picker(), { target: { value: "top5_countdown" } });
    await press();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(s.entry.errors.not_available));
    expect(s.entry.errors.not_available).toContain("nothing was charged");
  });
});
