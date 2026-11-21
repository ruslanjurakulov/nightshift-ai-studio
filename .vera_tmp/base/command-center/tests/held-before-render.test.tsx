// @vitest-environment jsdom
/**
 * A run the early fact-check stop held before its video was made (modules/held_video.py, hold_detail.stage):
 * there is no cut, so the page must not say a preview "was kept", must not offer to repair a scene, and must show
 * the texts that were flagged (the title, the description, ... which belong to no scene). The customer's job page
 * reads the `held` error code.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/c/videos/x" }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => null }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { ReviewPanel } from "@/components/review/ReviewPanel";
import { FLAGGED_SOURCES, FLAGGED_VERDICTS, heldBeforeRender, heldEvidence, heldFlagged, parseEvidence } from "@/lib/heldVideos";
import { sceneRepairEligibility } from "@/lib/sceneRepair";
import { JOB_ERROR_CODES, parseJobError } from "@/lib/runBackend";
import type { VideoRow } from "@/lib/types";

const FLAGGED = [
  { source: "title", verdict: "likely_inaccurate", reasoning: "No source says so.", text: "The Keeper Killed Them" },
  { source: "description", verdict: "unverifiable", reasoning: "", text: "Exactly 1900 men were lost." },
];
const HELD = {
  video_id: "run-0123456789abcdef0123",
  channel_id: "chronos",
  title: "The Lost City",
  published_at: null,
  privacy: null,
  publish_state: "blocked",
  preview_path: null,
  hold_detail: { reason: "blocked", stage: "before_render", gate: { allowed: false, blocks: ["fact_check_flagged:2"] }, flagged: FLAGGED },
};

afterEach(cleanup);

function panel(over: Partial<VideoRow> = {}, locale: Locale = "en", evidence?: ReturnType<typeof parseEvidence>) {
  const node: ReactNode = (
    <I18nProvider locale={locale}>
      <ReviewPanel
        video={{ ...HELD, ...over } as unknown as VideoRow}
        autoPublish={false}
        gate={{ allowed: false, reasons: ["fact_check_flagged:2"], flagged: null }}
        staleRequest={null}
        access="ok"
        channelName="Chronos"
        evidence={evidence ?? null}
      />
    </I18nProvider>
  );
  return render(node);
}

describe("heldBeforeRender / heldFlagged", () => {
  it("reads the fixed stage word and nothing else", () => {
    expect(heldBeforeRender(HELD)).toBe(true);
    expect(heldBeforeRender({ hold_detail: { stage: "later" } })).toBe(false);
    expect(heldBeforeRender({ hold_detail: null })).toBe(false);
    expect(heldBeforeRender(undefined)).toBe(false);
  });

  it("parses the flagged texts and drops what this build does not know", () => {
    const got = heldFlagged({
      hold_detail: {
        flagged: [
          ...FLAGGED,
          { source: "script", verdict: "unverifiable", text: "x" },
          { source: "title", verdict: "maybe", text: "x" },
          null,
          "str",
        ],
      },
    });
    expect(got.map((f) => [f.source, f.verdict])).toEqual([["title", "likely_inaccurate"], ["description", "unverifiable"]]);
  });

  it("caps the count and the lengths again, and a non-list is empty", () => {
    const many = Array.from({ length: 60 }, () => ({ source: "title", verdict: "unverifiable", reasoning: "r".repeat(900), text: "t".repeat(900) }));
    const got = heldFlagged({ hold_detail: { flagged: many } });
    expect(got).toHaveLength(20);
    expect(got[0].text).toHaveLength(200);
    expect(got[0].reasoning).toHaveLength(300);
    expect(heldFlagged({ hold_detail: { flagged: "nope" } })).toEqual([]);
    expect(heldFlagged(null)).toEqual([]);
  });
});

describe("Regenerate scene is not offered for a run with no cut", () => {
  it("is not repairable, with its own reason", () => {
    expect(sceneRepairEligibility(HELD)).toEqual({ repairable: false, reason: "no_cut" });
  });
  it("a held run that did render is repairable as before, and an uploaded one is not", () => {
    expect(sceneRepairEligibility({ ...HELD, hold_detail: { reason: "blocked" } })).toEqual({ repairable: true });
    expect(sceneRepairEligibility({ ...HELD, published_at: "2026-10-19T10:00:00Z" })).toEqual({ repairable: false, reason: "uploaded" });
  });
});

describe("the review panel for such a run", () => {
  it("says it was held before the video was made, not that a preview was lost", () => {
    panel();
    expect(screen.getByText(dictionaries.en.review.previewBeforeRender)).toBeTruthy();
    expect(screen.queryByText(dictionaries.en.review.previewMissing)).toBeNull();
  });

  it("an ordinary held run with no preview keeps the old sentence", () => {
    panel({ hold_detail: { reason: "blocked" } } as never);
    expect(screen.getByText(dictionaries.en.review.previewMissing)).toBeTruthy();
  });

  it("lists the flagged texts with where they ship and what the check said", () => {
    panel();
    const box = screen.getByTestId("flagged-texts");
    expect(box.textContent).toContain("The Keeper Killed Them");
    expect(box.textContent).toContain(dictionaries.en.review.flaggedSources.title);
    expect(box.textContent).toContain(dictionaries.en.review.flaggedVerdicts.likely_inaccurate);
    expect(box.textContent).toContain("Exactly 1900 men were lost.");
  });

  it("shows no list when nothing outside the narration was flagged", () => {
    panel({ hold_detail: { reason: "blocked", stage: "before_render" } } as never);
    expect(screen.queryByTestId("flagged-texts")).toBeNull();
  });

  it("renders model-written text as text, never as markup", () => {
    panel({ hold_detail: { stage: "before_render", flagged: [{ source: "title", verdict: "unverifiable", reasoning: "", text: "<img src=x onerror=alert(1)>" }] } } as never);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("flagged-texts").textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

const WIKI = "https://en.wikipedia.org/wiki/Mary_Celeste";
const GROUNDING = {
  enabled: true,
  unavailable: null,
  upgraded: 2,
  flagged_by_evidence: 1,
  cleared: [
    { claim_id: "c001-2", title: "Mary Celeste", url: WIKI, quote: "discovered adrift and deserted <b>in</b> the Atlantic" },
    { claim_id: "c001-3", title: "Evil", url: "https://evil.example/wiki/x", quote: "x" },
  ],
  sources: [
    { title: "Mary Celeste", url: WIKI, ids: ["W1"], claims: 2 },
    { title: "Evil", url: "https://evil.example/wiki/x", claims: 1 },
    { title: "Scheme", url: "javascript:alert(1)", claims: 1 },
    { title: "Lookalike", url: "https://en.wikipedia.org.evil.example/wiki/x", claims: 1 },
    "str",
    null,
  ],
};

describe("the sources of the online check (modules/grounding.py)", () => {
  it("keeps only links to the English Wikipedia", () => {
    const got = parseEvidence(GROUNDING);
    expect(got?.sources).toEqual([{ title: "Mary Celeste", url: WIKI, claims: 2 }]);
    expect(got).toMatchObject({ enabled: true, unavailable: null, upgraded: 2, flaggedByEvidence: 1 });
  });

  it("reads a record it does not know as no record, never as an empty one that says nothing was found", () => {
    for (const bad of [null, undefined, "x", 7, [], true]) expect(parseEvidence(bad)).toBeNull();
    expect(heldEvidence({ hold_detail: { reason: "blocked" } })).toBeNull();
    expect(heldEvidence({ hold_detail: { grounding: GROUNDING } })?.sources).toHaveLength(1);
  });

  it("takes the reason word only in its fixed shape and caps the list", () => {
    expect(parseEvidence({ unavailable: "http_429" })?.unavailable).toBe("http_429");
    expect(parseEvidence({ unavailable: "<script>alert(1)</script>" })?.unavailable).toBeNull();
    const many = Array.from({ length: 80 }, (_, i) => ({ title: `T${i}`, url: `${WIKI}_${i}`, claims: 1 }));
    expect(parseEvidence({ sources: many })?.sources).toHaveLength(30);
  });

  it("shows each cleared claim with its id, its source and its quote, as text, so a clearance can be audited", () => {
    expect(parseEvidence(GROUNDING)?.cleared).toEqual([
      { claimId: "c001-2", title: "Mary Celeste", url: WIKI, quote: "discovered adrift and deserted <b>in</b> the Atlantic" },
    ]);
    panel({} as never, "en", parseEvidence(GROUNDING));
    const list = screen.getByTestId("evidence-cleared");
    expect(list.querySelectorAll("li")).toHaveLength(1);
    expect(list.textContent).toContain("c001-2");
    expect(list.textContent).toContain("discovered adrift and deserted <b>in</b> the Atlantic");
    expect(list.querySelector("b")).toBeNull();
    expect((list.querySelector("a") as HTMLAnchorElement).getAttribute("href")).toBe(WIKI);
  });

  it("does not say the page proves the claim", () => {
    for (const locale of ["en", "ru", "uz"] as const) {
      expect(dictionaries[locale].review.sourcesNote).not.toMatch(/only when|только если|faqat .* boʻlsa/);
    }
    expect(dictionaries.en.review.sourcesNote).toContain("not proof");
  });

  it("lists the pages as links that open safely, with the claims each backed", () => {
    panel({} as never, "en", parseEvidence(GROUNDING));
    const box = screen.getByTestId("evidence-sources");
    const a = box.querySelector("a") as HTMLAnchorElement;
    expect(a.getAttribute("href")).toBe(WIKI);
    expect(a.textContent).toBe("Mary Celeste");
    expect(a.getAttribute("rel")).toContain("noopener");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(box.querySelectorAll("a")).toHaveLength(2); // the source and the cleared claim's source, both Wikipedia
    expect(box.textContent).toContain("2 claim(s)");
  });

  it("says when the check was off, when it could not run, and when it found nothing: three different sentences", () => {
    const en = dictionaries.en.review;
    const off = panel({} as never, "en", parseEvidence({ enabled: false, unavailable: null }));
    expect(screen.getByTestId("evidence-sources").textContent).toContain(en.sourcesOff);
    off.unmount();
    const down = panel({} as never, "en", parseEvidence({ enabled: true, unavailable: "http_429" }));
    expect(screen.getByTestId("evidence-sources").textContent).toContain("http_429");
    expect(screen.getByTestId("evidence-sources").textContent).not.toContain(en.sourcesNone);
    down.unmount();
    panel({} as never, "en", parseEvidence({ enabled: true, unavailable: null, sources: [] }));
    expect(screen.getByTestId("evidence-sources").textContent).toContain(en.sourcesNone);
  });

  it("shows nothing at all for a video with no record", () => {
    panel({} as never, "en", null);
    expect(screen.queryByTestId("evidence-sources")).toBeNull();
  });

  it("renders a hostile title as text", () => {
    panel({} as never, "en", parseEvidence({ sources: [{ title: "<img src=x onerror=alert(1)>", url: WIKI, claims: 1 }] }));
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByTestId("evidence-sources").textContent).toContain("<img src=x onerror=alert(1)>");
  });

  for (const locale of ["en", "ru", "uz"] as const) {
    it(`${locale}: the copy is complete`, () => {
      const r = dictionaries[locale].review;
      for (const key of ["sourcesHeading", "sourcesNote", "sourcesOff", "sourcesUnavailable", "sourcesNone", "sourcesClaims", "sourcesCleared"] as const) {
        expect(r[key], key).toBeTruthy();
      }
      expect(r.sourcesUnavailable).toContain("{reason}");
      expect(r.sourcesClaims).toContain("{n}");
    });
  }
});

describe("the sentences, in every language", () => {
  for (const locale of ["en", "ru", "uz"] as const) {
    const r = dictionaries[locale].review;
    it(`${locale}: the new review copy is complete`, () => {
      expect(r.previewBeforeRender).toBeTruthy();
      expect(r.flaggedHeading).toBeTruthy();
      expect(Object.keys(r.flaggedSources).sort()).toEqual([...FLAGGED_SOURCES].sort());
      expect(Object.keys(r.flaggedVerdicts).sort()).toEqual([...FLAGGED_VERDICTS].sort());
      for (const v of [...Object.values(r.flaggedSources), ...Object.values(r.flaggedVerdicts)]) expect(v).toBeTruthy();
    });
    it(`${locale}: the held job-error sentence exists`, () => {
      expect(dictionaries[locale].create.jobError.held).toBeTruthy();
    });
  }
  it("ru and uz are not copies of English", () => {
    for (const l of ["ru", "uz"] as const) {
      expect(dictionaries[l].review.previewBeforeRender).not.toBe(dictionaries.en.review.previewBeforeRender);
      expect(dictionaries[l].create.jobError.held).not.toBe(dictionaries.en.create.jobError.held);
    }
  });
  it("the customer sentence names no vendor and says nothing was charged (the page adds the refund line)", () => {
    expect(dictionaries.en.create.jobError.held).toMatch(/nothing was charged/);
    expect(dictionaries.en.create.jobError.held).not.toMatch(/gemini|google|eleven|pexels|kling|youtube|supabase/i);
  });
});

describe("the held job-error code", () => {
  it("is in the closed list and parses from the worker's prefix", () => {
    expect(JOB_ERROR_CODES).toContain("held");
    expect(parseJobError("[code:held] main.py exited with code 79: the fact-check held the script")).toEqual({
      code: "held",
      text: "main.py exited with code 79: the fact-check held the script",
    });
  });
});
