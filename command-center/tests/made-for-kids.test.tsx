// @vitest-environment jsdom
/**
 * YouTube's "made for kids" switch (migration 0140, lib/madeForKids.ts, components/review/MadeForKidsSwitch.tsx).
 *
 * What would break: a Kids story reaching the run without its declaration, kids content switched off with one tap (no
 * confirmation), the confirmation's safe answer not being the one that keeps it on, a review panel offering a change the
 * database refuses (public video, live approval, not an administrator), an unknown drawn as "off", the switch sending anything
 * but true to the run, the copy missing in a language or misspelling the Uzbek letter, and the Python list of kids looks drifting
 * from the Style Library. The database's own rules are attacked in tests/security/test_sec_made_for_kids.py; every upload body
 * in tests/test_made_for_kids.py.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const h = vi.hoisted(() => ({ rpc: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: h.refresh, push: vi.fn() }), usePathname: () => "/kids/videos/x" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: h.rpc }) }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { MadeForKidsSwitch, ReviewMadeForKids } from "@/components/review/MadeForKidsSwitch";
import {
  KIDS_LIBRARY_STYLES,
  KIDS_TAGGED_NOT_KIDS_ONLY,
  audienceUnanswered,
  errorFromRpc,
  isKidsFormat,
  isKidsLook,
  madeForKidsBlocker,
  madeForKidsError,
  madeForKidsView,
  needsConfirm,
} from "@/lib/madeForKids";
import { runHandoffHref, runPrefillFromQuery } from "@/lib/home";
import { APPROVE_REASONS, approvalState, canPressApprove } from "@/lib/videoApproval";
import { buildRenderJobInsert } from "@/lib/runBackend";
import { STYLE_LIBRARY, libraryStyleById } from "@/lib/styles/library";

const en = dictionaries.en.madeForKids;

function wrap(node: ReactNode, locale: Locale = "en") {
  return render(<I18nProvider locale={locale}>{node}</I18nProvider>);
}

beforeEach(() => {
  h.rpc.mockReset();
  h.refresh.mockReset();
});
afterEach(() => cleanup());

describe("what is kids content", () => {
  it("the Python list of kids looks is the Style Library's, id for id", () => {
    const py = readFileSync(join(__dirname, "..", "..", "modules", "made_for_kids.py"), "utf8");
    const block = py.slice(py.indexOf("KIDS_LIBRARY_STYLES = frozenset({"), py.indexOf("})", py.indexOf("KIDS_LIBRARY_STYLES")));
    const ids = [...block.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]);
    expect([...ids].sort()).toEqual([...KIDS_LIBRARY_STYLES].sort());
    expect(KIDS_LIBRARY_STYLES).toContain("claymation-set");
  });

  it("every kids-only look is a look of the library tagged kids; the list is the decision, not the tag", () => {
    for (const id of KIDS_LIBRARY_STYLES) expect(libraryStyleById(id)?.tags, id).toContain("kids");
    const tagged = STYLE_LIBRARY.filter((s) => s.tags.includes("kids")).map((s) => s.id);
    // Every look the kids filter shows is either kids-only or one of the three named exceptions; nothing else slips in.
    expect([...tagged].sort()).toEqual([...KIDS_LIBRARY_STYLES, ...KIDS_TAGGED_NOT_KIDS_ONLY].sort());
  });

  it.each(["cut-paper-collage", "claymation-set", "felt-and-wool", "gouache-storybook", "chalk-on-slate"])(
    "%s makes a video made for kids",
    (id) => expect(isKidsLook(id)).toBe(true),
  );

  it.each(["tilt-shift-miniature", "oil-pastel", "central-asian-miniature"])(
    "%s keeps its kids tag for browsing but does not make a video made for kids",
    (id) => {
      expect(libraryStyleById(id)?.tags).toContain("kids");
      expect(isKidsLook(id)).toBe(false);
      expect(KIDS_LIBRARY_STYLES).not.toContain(id);
    },
  );

  it("the kids format and a kids look are recognised, nothing else is", () => {
    expect(isKidsFormat("kids")).toBe(true);
    for (const id of ["story", "shorts", "", null]) expect(isKidsFormat(id)).toBe(false);
    expect(isKidsLook("gouache-storybook")).toBe(true);
    expect(isKidsLook("blueprint-technical")).toBe(false);
  });

  it("an unknown is never read as off", () => {
    expect(madeForKidsView({})).toEqual({ recorded: false, value: null, kids: false, confirmedOff: false, answered: false });
    expect(madeForKidsView({ made_for_kids: true, kids_content: true })).toEqual({
      recorded: true,
      value: true,
      kids: true,
      confirmedOff: false,
      answered: false,
    });
    expect(madeForKidsView({ made_for_kids: false, kids_content: true, made_for_kids_off_by: "u" }).confirmedOff).toBe(true);
  });

  it("only kids content going off asks first", () => {
    expect(needsConfirm({ kids: true }, false)).toBe(true);
    expect(needsConfirm({ kids: true }, true)).toBe(false);
    expect(needsConfirm({ kids: false }, false)).toBe(false);
  });

  it("the panel refuses in the database's order, then by who you are", () => {
    expect(madeForKidsBlocker({ privacy: "public" }, { approvalLive: true, access: "not_admin" })).toBe("already_public");
    expect(madeForKidsBlocker({ privacy: "private" }, { approvalLive: true, access: "ok" })).toBe("approval_live");
    expect(madeForKidsBlocker({ privacy: "private" }, { approvalLive: false, access: "not_member" })).toBe("not_member");
    expect(madeForKidsBlocker({ privacy: "private" }, { approvalLive: false, access: "not_admin" })).toBe("not_admin");
    expect(madeForKidsBlocker({ privacy: "private" }, { approvalLive: false, access: "ok" })).toBeNull();
  });

  it("the database's words are known and anything else is a plain failure", () => {
    expect(madeForKidsError("confirm_required")).toBe("confirm_required");
    expect(madeForKidsError("something new")).toBe("failed");
    expect(errorFromRpc({ code: "42501" })).toBe("forbidden");
    expect(errorFromRpc({ code: "P0002" })).toBe("not_found");
    expect(errorFromRpc({ code: "500" })).toBe("failed");
  });
});

describe("the Kids story format reaches the run", () => {
  it("the card's link carries format=kids and the form starts with made for kids on", () => {
    const href = runHandoffHref("kids-tales", { topic: "A fox", seconds: 300, language: "Uzbek", format: "kids" });
    expect(href).toContain("format=kids");
    const q = Object.fromEntries(new URL(href, "https://x").searchParams);
    expect(runPrefillFromQuery(q)).toEqual({ brief: "A fox", duration: "300", language: "Uzbek", madeForKids: true });
  });

  it("any other format carries nothing new, and a junk format is ignored", () => {
    expect(runHandoffHref("c", { topic: "t", seconds: 600, language: "English", format: "story" })).not.toContain("format=");
    expect(runPrefillFromQuery({ topic: "t", format: "adults" })).toEqual({ brief: "t", duration: "", language: "" });
    expect(runPrefillFromQuery({ format: ["kids", "kids"] })).toBeNull();
  });

  it("the run carries made_for_kids only as true", () => {
    expect(buildRenderJobInsert("c", { topic: "t", madeForKids: true }, "u").params).toEqual({ topic: "t", made_for_kids: true });
    expect(buildRenderJobInsert("c", { topic: "t", madeForKids: false }, "u").params).toEqual({ topic: "t" });
    expect(buildRenderJobInsert("c", { topic: "t" }, "u").params).toEqual({ topic: "t" });
  });
});

describe("the switch", () => {
  function sw(props: { checked: boolean | null; kids: boolean; disabled?: boolean }, locale: Locale = "en") {
    const onChange = vi.fn();
    wrap(<MadeForKidsSwitch id="t" onChange={onChange} {...props} />, locale);
    return { onChange, button: screen.getByRole("switch") };
  }

  it("kids content is on, says why, and turning it off asks first: keep is the default answer", () => {
    const { onChange, button } = sw({ checked: true, kids: true });
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText(en.label)).toBeTruthy();
    expect(screen.getByText(`${en.help} ${en.kidsNote}`)).toBeTruthy();
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(en.confirmTitle);
    const keep = screen.getByRole("button", { name: en.confirmNo });
    expect(document.activeElement).toBe(keep);
    fireEvent.click(keep);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: en.confirmYes }));
    expect(onChange).toHaveBeenCalledWith(false, true);
  });

  it("a video that is not kids content switches at once, both ways", () => {
    const off = sw({ checked: true, kids: false });
    fireEvent.click(off.button);
    expect(off.onChange).toHaveBeenCalledWith(false, false);
    cleanup();
    const on = sw({ checked: false, kids: true });
    fireEvent.click(on.button);
    expect(on.onChange).toHaveBeenCalledWith(true, false);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("not recorded is drawn as neither, and a locked switch does nothing", () => {
    const { button, onChange } = sw({ checked: null, kids: false, disabled: true });
    expect(button.getAttribute("aria-checked")).toBe("mixed");
    fireEvent.click(button);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("speaks Uzbek with the right letters, and Russian", () => {
    sw({ checked: true, kids: true }, "uz");
    expect(screen.getByText("Bolalar uchun moʻljallangan (YouTube talabi)")).toBeTruthy();
    expect(dictionaries.uz.madeForKids.help).toContain("izohlarni");
    cleanup();
    sw({ checked: true, kids: true }, "ru");
    expect(screen.getByText(dictionaries.ru.madeForKids.label)).toBeTruthy();
  });
});

describe("the review panel's audience question", () => {
  // As the pipeline leaves a kids video: detected and declared made for kids, nobody's answer yet.
  const DETECTED = {
    video_id: "Kd5aBc7dEfG",
    privacy: "private",
    made_for_kids: true,
    kids_content: true,
    made_for_kids_answered_by: null,
    made_for_kids_answered_at: null,
  };
  const radios = () => screen.getAllByRole("radio") as HTMLButtonElement[];

  it("asks the question with two answers and pre-selects neither: the detection is a hint", () => {
    wrap(<ReviewMadeForKids video={DETECTED} access="ok" approvalLive={false} />);
    expect(screen.getByRole("radiogroup").getAttribute("aria-required")).toBe("true");
    expect(screen.getByText(en.question)).toBeTruthy();
    expect(radios().map((r) => [r.textContent, r.getAttribute("aria-checked")])).toEqual([
      [en.yes, "false"],
      [en.no, "false"],
    ]);
    expect(screen.getByTestId("made-for-kids-hint").textContent).toContain(en.hintKids);
    expect(screen.getByTestId("made-for-kids-note").textContent).toBe(en.unanswered);
    expect(h.rpc).not.toHaveBeenCalled();
  });

  it("the hint says what the system guessed either way, and nothing when nothing was recorded", () => {
    wrap(<ReviewMadeForKids video={{ ...DETECTED, made_for_kids: false, kids_content: false }} access="ok" approvalLive={false} />);
    expect(screen.getByTestId("made-for-kids-hint").textContent).toContain(en.hintNotKids);
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    cleanup();
    wrap(<ReviewMadeForKids video={{ video_id: "Old0ld0ld01", privacy: "private", made_for_kids_answered_by: null }} access="ok" approvalLive={false} />);
    expect(screen.getByTestId("made-for-kids-hint").textContent).toContain(en.hintUnknown);
  });

  it("Yes is recorded at once, through set_video_made_for_kids, even when it agrees with the guess", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, already: false }, error: null });
    wrap(<ReviewMadeForKids video={DETECTED} access="ok" approvalLive={false} />);
    fireEvent.click(screen.getByRole("radio", { name: en.yes }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc).toHaveBeenCalledWith("set_video_made_for_kids", { p_video_id: "Kd5aBc7dEfG", p_made_for_kids: true, p_confirm_off: false });
    await waitFor(() => expect(screen.getByRole("radio", { name: en.yes }).getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByRole("radio", { name: en.no }).getAttribute("aria-checked")).toBe("false");
    expect(h.refresh).toHaveBeenCalled();
  });

  it("No on what the system takes for kids content asks first; going back records nothing", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, already: false }, error: null });
    wrap(<ReviewMadeForKids video={DETECTED} access="ok" approvalLive={false} />);
    fireEvent.click(screen.getByRole("radio", { name: en.no }));
    expect(h.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole("alertdialog").textContent).toContain(en.confirmTitle);
    const back = screen.getByRole("button", { name: en.confirmBack });
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(h.rpc).not.toHaveBeenCalled();
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: en.no }));
    fireEvent.click(screen.getByRole("button", { name: en.confirmYes }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledTimes(1));
    expect(h.rpc).toHaveBeenCalledWith("set_video_made_for_kids", { p_video_id: "Kd5aBc7dEfG", p_made_for_kids: false, p_confirm_off: true });
    await waitFor(() => expect(screen.getByRole("radio", { name: en.no }).getAttribute("aria-checked")).toBe("true"));
  });

  it("No on a video the system does not take for kids content is recorded at once", async () => {
    h.rpc.mockResolvedValue({ data: { ok: true, already: false }, error: null });
    wrap(<ReviewMadeForKids video={{ ...DETECTED, made_for_kids: false, kids_content: false }} access="ok" approvalLive={false} />);
    fireEvent.click(screen.getByRole("radio", { name: en.no }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith("set_video_made_for_kids", {
      p_video_id: "Kd5aBc7dEfG",
      p_made_for_kids: false,
      p_confirm_off: false,
    }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("a person's earlier answer is shown as chosen, with its date", () => {
    wrap(
      <ReviewMadeForKids
        video={{ ...DETECTED, made_for_kids_answered_by: "u-1", made_for_kids_answered_at: "2026-11-12T10:00:00Z" }}
        access="ok"
        approvalLive={false}
      />,
    );
    expect(screen.getByRole("radio", { name: en.yes }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("made-for-kids-note").textContent).toBe(dictionaries.en.madeForKids.answeredOn.replace("{when}", "2026-11-12"));
  });

  it("a refusal is said in words and nothing is chosen", async () => {
    h.rpc.mockResolvedValue({ data: { ok: false, error: "rate_limited" }, error: null });
    wrap(<ReviewMadeForKids video={DETECTED} access="ok" approvalLive={false} />);
    fireEvent.click(screen.getByRole("radio", { name: en.yes }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(en.errors.rate_limited));
    expect(radios().every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("a public video, a live approval and a non-administrator are locked, and say why", () => {
    for (const [video, access, live, why] of [
      [{ ...DETECTED, privacy: "public" }, "ok", false, en.blockers.already_public],
      [DETECTED, "ok", true, en.blockers.approval_live],
      [DETECTED, "not_admin", false, en.blockers.not_admin],
    ] as const) {
      wrap(<ReviewMadeForKids video={video} access={access} approvalLive={live} />);
      for (const r of radios()) expect(r.disabled).toBe(true);
      expect(screen.getByTestId("made-for-kids-note").textContent).toBe(why);
      fireEvent.click(radios()[0]);
      expect(h.rpc).not.toHaveBeenCalled();
      cleanup();
    }
  });

  it("speaks Uzbek with the right letters", () => {
    wrap(<ReviewMadeForKids video={DETECTED} access="ok" approvalLive={false} />, "uz");
    expect(screen.getByText("Bu video bolalar uchun moʻljallanganmi? (YouTube talabi)")).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Ha" })).toBeTruthy();
    expect(screen.getByRole("radio", { name: "Yoʻq" })).toBeTruthy();
    expect(screen.getByTestId("made-for-kids-hint").textContent).toContain("Tizim taxmini: bolalar uchun");
  });
});

describe("approving waits for the answer", () => {
  const ROW = {
    review_state: "pending",
    privacy: "private",
    publish_state: "uploaded",
    published_at: "2026-10-19T10:00:00Z",
    preview_path: "c/x.mp4",
    cut_sha256: "c0ffee".repeat(10) + "abcd",
    gate_verdict: { allowed: true, blocks: [], warnings: [], checks_run: [] },
  };

  it("an unanswered video cannot be approved; an answer, either answer, opens it", () => {
    const now = { autoPublish: false, access: "ok" as const, nowMs: Date.parse("2026-11-12T10:00:00Z") };
    const unanswered = approvalState({ ...ROW, made_for_kids_answered_by: null }, now);
    expect(unanswered.blocker).toBe("audience_unanswered");
    expect(canPressApprove(unanswered)).toBe(false);
    for (const answered of [{ made_for_kids: true }, { made_for_kids: false }]) {
      const s = approvalState({ ...ROW, ...answered, made_for_kids_answered_by: "u-1" }, now);
      expect(s.blocker).toBeNull();
      expect(canPressApprove(s)).toBe(true);
    }
    // A database before 0140 has no such column and does not ask: nothing to wait for there.
    expect(approvalState(ROW, now).blocker).toBeNull();
    expect(audienceUnanswered({})).toBe(false);
  });

  it("the database's refusal and the blocker are said in all three languages", () => {
    expect(APPROVE_REASONS).toContain("audience_unanswered");
    for (const loc of ["en", "ru", "uz"] as const) {
      expect(dictionaries[loc].review.blocker.audience_unanswered.length).toBeGreaterThan(20);
      expect(dictionaries[loc].review.reasons.audience_unanswered.length).toBeGreaterThan(20);
    }
  });
});

describe("the copy", () => {
  it("exists in all three languages with the same keys", () => {
    const keys = (o: object): string[] =>
      Object.entries(o).flatMap(([k, v]) => (typeof v === "object" ? keys(v).map((x) => `${k}.${x}`) : [k])).sort();
    expect(keys(dictionaries.ru.madeForKids)).toEqual(keys(en));
    expect(keys(dictionaries.uz.madeForKids)).toEqual(keys(en));
  });
});
