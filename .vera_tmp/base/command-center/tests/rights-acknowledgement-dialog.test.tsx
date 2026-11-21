// @vitest-environment jsdom
/**
 * The rights acknowledgement dialog (components/studio/RightsAcknowledgementDialog.tsx, migration 0174) and its place in the
 * Studio's generate flow.
 *
 * What would break: a box that starts ticked, a Confirm that works without the tick, words shown for a version this page does
 * not carry, an acknowledgement posted for the wrong input or the wrong version, a failure read as success (the job then
 * starts), a retry that records an input twice, a second kind skipped, a refusal of the job that is not turned into the
 * question, or a job that starts again with other settings or another price than the press the person made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/chronos/create",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), back: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/channels-client", () => ({ useChannelPath: () => (p: string) => `/chronos${p}` }));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, type Locale } from "@/lib/i18n";
import { RightsAcknowledgementDialog, type PostAcknowledgement, type RightsAckState } from "@/components/studio/RightsAcknowledgementDialog";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import type { StudioModel } from "@/lib/creative/studio";

const PIC = "22222222-2222-4222-8222-222222222222";
const END = "33333333-3333-4333-8333-333333333333";
const ORG = "11111111-1111-4111-8111-111111111111";
const V1 = "likeness_photo.v1";
const withI18n = (ui: ReactNode, locale: Locale = "en") => <I18nProvider locale={locale}>{ui}</I18nProvider>;

const ask = (missing: Extract<RightsAckState, { phase: "ask" }>["missing"]): RightsAckState => ({
  phase: "ask",
  missing,
  subjectKeys: { [PIC]: "source_asset_id", [END]: "end_asset_id" },
});
const photo = (subject: string, textVersion: string | null = V1) => ({ kind: "likeness_photo", textVersion, subject });
const ok = (subject: string, kind = "likeness_photo", version = V1) =>
  Promise.resolve({ status: 201, body: { acknowledgement: { kind, text_version: version, subject }, replay: false } });

function open(state: RightsAckState, post: PostAcknowledgement, locale: Locale = "en") {
  const onAcknowledged = vi.fn();
  const onClose = vi.fn();
  render(withI18n(<RightsAcknowledgementDialog state={state} post={post} onAcknowledged={onAcknowledged} onClose={onClose} />, locale));
  return { onAcknowledged, onClose, dialog: screen.getByRole("dialog") };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the dialog", () => {
  const d = dictionaries.en.rightsAck;

  it("shows the exact words, an unticked box and the Terms link; Confirm waits for the tick", () => {
    const post = vi.fn<PostAcknowledgement>();
    const { dialog } = open(ask([photo(PIC)]), post);
    expect(within(dialog).getByTestId("rights-ack-question").textContent).toBe(d.kinds.likeness_photo.question);
    expect(within(dialog).getByTestId("rights-ack-statement").textContent).toBe(d.kinds.likeness_photo.statement);
    const box = within(dialog).getByRole("checkbox", { name: new RegExp(d.checkbox) }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    const terms = within(dialog).getByRole("link", { name: d.termsLink });
    expect(terms.getAttribute("href")).toBe("/terms#acceptable-use");
    expect(within(dialog).getByText(d.subjects.source_asset_id)).toBeTruthy();
    expect(within(dialog).getByText("Text version likeness_photo.v1")).toBeTruthy();
    const confirm = within(dialog).getByRole("button", { name: d.confirm }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    expect(post).not.toHaveBeenCalled();
  });

  it("asks once per file, each in its own unticked box, records each at the version and language shown, then hands back once", async () => {
    const post = vi.fn<PostAcknowledgement>((i) => ok(i.subject));
    const { onAcknowledged, dialog } = open(ask([photo(PIC), photo(END)]), post);
    expect(within(dialog).getByText(d.subjects.source_asset_id)).toBeTruthy();
    expect(within(dialog).queryByText(d.subjects.end_asset_id)).toBeNull();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    // The second file: a fresh, unticked box of its own.
    await within(dialog).findByText(d.subjects.end_asset_id);
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
    expect(post.mock.calls.map((c) => c[0])).toEqual([
      { kind: "likeness_photo", text_version: V1, subject: PIC, locale: "en" },
      { kind: "likeness_photo", text_version: V1, subject: END, locale: "en" },
    ]);
  });

  it("records the language the words were read in", async () => {
    const post = vi.fn<PostAcknowledgement>((i) => ok(i.subject));
    const { onAcknowledged, dialog } = open(ask([photo(PIC)]), post, "uz");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: dictionaries.uz.rightsAck.confirm }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0].locale).toBe("uz");
  });

  it("the hourly limit says so and offers no Confirm", async () => {
    const post = vi.fn<PostAcknowledgement>(() => Promise.resolve({ status: 429, body: { error: "acknowledgement_limit" } }));
    const { onAcknowledged, dialog } = open(ask([photo(PIC)]), post);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    expect((await within(dialog).findByTestId("rights-ack-problem")).textContent).toBe(d.problems.rate_limited);
    expect(within(dialog).queryByTestId("rights-ack-confirm")).toBeNull();
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("loading: the button says it is recording and nothing can be pressed twice", async () => {
    let release: () => void = () => {};
    const post = vi.fn<PostAcknowledgement>(
      (i) => new Promise((r) => (release = () => r({ status: 201, body: { acknowledgement: { kind: i.kind, text_version: i.text_version, subject: i.subject } } }))),
    );
    const { onAcknowledged, dialog } = open(ask([photo(PIC)]), post);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    const busy = (await within(dialog).findByRole("button", { name: d.confirming })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(busy);
    expect(post).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
  });

  it("error and retry: a failure starts nothing, and Retry records it then", async () => {
    let n = 0;
    const post = vi.fn<PostAcknowledgement>((i) => {
      n += 1;
      if (n === 1) return Promise.resolve({ status: 502, body: { error: "failed" } });
      return ok(i.subject);
    });
    const { onAcknowledged, dialog } = open(ask([photo(PIC)]), post);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    const problem = await within(dialog).findByTestId("rights-ack-problem");
    expect(problem.getAttribute("data-problem")).toBe("failed");
    expect(problem.textContent).toBe(d.problems.failed);
    expect(onAcknowledged).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: d.retry }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
    expect(post.mock.calls.map((c) => c[0].subject)).toEqual([PIC, PIC]);
  });

  it("a network failure is a failure too", async () => {
    const post = vi.fn<PostAcknowledgement>(() => Promise.reject(new Error("offline")));
    const { onAcknowledged, dialog } = open(ask([photo(PIC)]), post);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    expect((await within(dialog).findByTestId("rights-ack-problem")).getAttribute("data-problem")).toBe("failed");
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("words changed in the database: says to reload, and offers no Confirm", async () => {
    const post = vi.fn<PostAcknowledgement>(() => Promise.resolve({ status: 409, body: { error: "acknowledgement_version_changed" } }));
    const { onAcknowledged, dialog } = open(ask([photo(PIC)]), post);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    expect((await within(dialog).findByTestId("rights-ack-problem")).textContent).toBe(d.problems.version_changed);
    expect(within(dialog).queryByTestId("rights-ack-confirm")).toBeNull();
    expect(onAcknowledged).not.toHaveBeenCalled();
  });

  it("a version this page does not carry is never shown, so it can never be acknowledged", () => {
    const post = vi.fn<PostAcknowledgement>();
    const { dialog } = open(ask([photo(PIC, "likeness_photo.v2")]), post);
    expect(within(dialog).queryByTestId("rights-ack-statement")).toBeNull();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).queryByTestId("rights-ack-confirm")).toBeNull();
    expect(within(dialog).getByTestId("rights-ack-problem").textContent).toBe(d.problems.stale);
    expect(post).not.toHaveBeenCalled();
  });

  it("a second kind is asked in its own box, unticked again", async () => {
    const post = vi.fn<PostAcknowledgement>((i) => ok(i.subject, i.kind, i.text_version));
    const { onAcknowledged, dialog } = open(
      ask([photo(PIC), { kind: "third_party_content", textVersion: "third_party_content.v1", subject: PIC }]),
      post,
    );
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    await waitFor(() => expect(within(dialog).getByTestId("rights-ack-ask").getAttribute("data-kind")).toBe("third_party_content"));
    expect(onAcknowledged).not.toHaveBeenCalled();
    expect((within(dialog).getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getByTestId("rights-ack-question").textContent).toBe(d.kinds.third_party_content.question);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: d.confirm }));
    await waitFor(() => expect(onAcknowledged).toHaveBeenCalledTimes(1));
    expect(post.mock.calls.map((c) => c[0].kind)).toEqual(["likeness_photo", "third_party_content"]);
  });

  it("checking: says so while the database is asked", () => {
    const { dialog } = open({ phase: "checking" }, vi.fn());
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    expect(within(dialog).getByTestId("rights-ack-checking").textContent).toBe(d.checking);
  });

  it("Escape and Cancel close it without recording anything", () => {
    const post = vi.fn<PostAcknowledgement>();
    const { onClose, dialog } = open(ask([photo(PIC)]), post);
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.click(within(dialog).getByRole("button", { name: d.cancel }));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(post).not.toHaveBeenCalled();
  });

  it.each(["ru", "uz"] as const)("speaks %s", (locale) => {
    const t = dictionaries[locale].rightsAck;
    const { dialog } = open(ask([photo(PIC)]), vi.fn(), locale);
    expect(within(dialog).getByTestId("rights-ack-question").textContent).toBe(t.kinds.likeness_photo.question);
    expect(within(dialog).getByRole("checkbox", { name: new RegExp(t.checkbox) })).toBeTruthy();
    expect(within(dialog).getByRole("link", { name: t.termsLink })).toBeTruthy();
  });
});

// ── in the Studio ───────────────────────────────────────────────────────────

const ACKER: StudioModel = { id: "runway-gen4-turbo", displayName: "Runway Gen-4 Turbo", capabilities: ["i2v"], beta: false };
const library = {
  available: true,
  assets: [
    {
      id: PIC, kind: "image", mime: "image/png", bytes: 2048, width: 1280, height: 720, durationS: null, source: "upload",
      name: "portrait.png", variants: ["thumb"], version: 1, createdAt: "2026-10-01T10:00:00Z", thumbUrl: `/t/${PIC}`,
      viewUrl: `/api/media/file/${PIC}/original`,
    },
  ],
  uploads: [],
};

describe("the Studio's generate flow", () => {
  let creates: Array<Record<string, unknown>>;
  let acks: Array<Record<string, unknown>>;
  let acknowledged: boolean;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

  beforeEach(() => {
    creates = [];
    acks = [];
    acknowledged = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith("/api/media")) return json(library);
        if (url === "/api/creative/quote") return json({ quote: { credits: 25 } });
        if (url.startsWith("/api/creative/acknowledgements?")) {
          return json({
            required: [{ kind: "likeness_photo", text_version: V1 }],
            missing: acknowledged ? [] : [{ kind: "likeness_photo", text_version: V1, subject: PIC }],
          });
        }
        if (url === "/api/creative/acknowledgements" && init?.method === "POST") {
          const b = JSON.parse(String(init.body));
          acks.push(b);
          acknowledged = true;
          return json({ acknowledgement: { kind: b.kind, text_version: b.text_version, subject: b.subject }, replay: false }, 201);
        }
        if (url === "/api/creative/jobs" && init?.method === "POST") {
          const b = JSON.parse(String(init.body));
          creates.push(b);
          // The database's answer: nothing was held, and the detail names the input.
          if (!acknowledged) {
            return json({ error: "acknowledgement_required", detail: `kind=likeness_photo version=${V1} subject=${PIC}` }, 428);
          }
          return json({ job: { id: "j1" } }, 201);
        }
        if (url.startsWith("/api/creative/jobs")) return json({ jobs: [] });
        if (url.startsWith("/api/style-kits")) return json({ error: "not_available" }, 503);
        return json({}, 404);
      }),
    );
  });

  it("the database's refusal opens the dialog; after the tick the same press is sent again", async () => {
    render(
      withI18n(
        <GeneratePanel orgId={ORG} models={[ACKER]} initial={{ capability: "i2v", model: ACKER.id, prompt: "", aspect: "16:9", duration: 5, sourceId: PIC }} />,
      ),
    );
    const button = await screen.findByRole("button", { name: "Generate · 25 credits" }, { timeout: 3000 });
    fireEvent.click(button);
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("rights-ack-ask");
    expect(creates).toHaveLength(1);
    // Nothing is sent before the person ticks and confirms.
    expect(acks).toHaveLength(0);
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(within(dialog).getByRole("button", { name: dictionaries.en.rightsAck.confirm }));
    await waitFor(() => expect(creates).toHaveLength(2));
    expect(acks).toEqual([{ kind: "likeness_photo", text_version: V1, subject: PIC, locale: "en" }]);
    // The same press: the same model, settings and confirmed price; a fresh idempotency key is a new request (nothing was held).
    const [first, second] = creates;
    expect(second.model).toBe(first.model);
    expect(second.params).toEqual(first.params);
    expect(second.max_credits).toBe(25);
    expect(second.params).toMatchObject({ source_asset_id: PIC });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closing the dialog starts nothing", async () => {
    render(
      withI18n(
        <GeneratePanel orgId={ORG} models={[ACKER]} initial={{ capability: "i2v", model: ACKER.id, prompt: "", aspect: "16:9", duration: 5, sourceId: PIC }} />,
      ),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Generate · 25 credits" }, { timeout: 3000 }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByTestId("rights-ack-ask");
    fireEvent.click(within(dialog).getByRole("button", { name: dictionaries.en.rightsAck.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(creates).toHaveLength(1);
    expect(acks).toHaveLength(0);
  });
});
