// @vitest-environment jsdom
/**
 * The custom voice page in the browser (components/voice/*, slice V3 of docs/CUSTOM_VOICE.md), against a fake database, fake
 * storage, a fake MediaRecorder and fake timers.
 *
 * What would break without these, one by one: the request made before the declarations are all ticked; a recording started (or a
 * request spent) in a browser that cannot record; a take shorter than 30 s or longer than 60 s offered for upload; a file picker
 * (v1 is a live recording only); the upload going anywhere but the prefix the database returned, with a codecs-qualified type, or
 * replacing a recording; the database's refusal of the request (the function is granted to nobody) shown as an error instead of
 * "not available yet", or as a success; a state of a voice (pending, testing, approved, rejected, deleted, unknown) drawn as another;
 * a reject word shown raw; a button that acts without asking the database, or whose refusal is lost; a voice id, reference, hash or
 * path reaching the screen; a name or database text rendered as markup; polling that never stops, or stops early; a stuck
 * microphone light; and the three languages drifting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }), usePathname: () => "/chronos/agents/voice" }));

type Err = { code?: string; message: string; hint?: string } | null;
type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  /** What each function answers; a function with no entry answers {ok:true}. */
  rpc: {} as Record<string, (args: Record<string, unknown>) => { data?: unknown; error?: Err } | Promise<{ data?: unknown; error?: Err }>>,
  profiles: [] as Row[],
  attachments: [] as Row[],
  readError: null as Err,
  selects: [] as Array<{ table: string; columns: string }>,
  reads: 0,
  uploads: [] as Array<{ bucket: string; path: string; type: string; upsert: boolean; size: number }>,
  uploadError: null as null | { message: string; statusCode?: string },
  tableWrites: [] as string[],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      db.rpcCalls.push({ fn, args });
      const h = db.rpc[fn];
      const out = h ? await h(args) : { data: { ok: true } };
      return { data: out.data ?? null, error: out.error ?? null };
    },
    from: (table: string) => ({
      select: (columns: string) => {
        db.selects.push({ table, columns });
        return {
          order: async () => {
            db.reads++;
            return { data: table === "voice_profiles" ? db.profiles : [], error: db.readError };
          },
          eq: async () => ({ data: db.attachments, error: null }),
        };
      },
      insert: () => db.tableWrites.push(table),
      update: () => db.tableWrites.push(table),
      delete: () => db.tableWrites.push(table),
    }),
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, blob: Blob, opts: { contentType: string; upsert: boolean }) => {
          db.uploads.push({ bucket, path, type: opts.contentType, upsert: opts.upsert, size: blob.size });
          return { data: {}, error: db.uploadError };
        },
      }),
    },
  }),
}));
vi.mock("@/components/feedback/ToastProvider", () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() }),
}));

import { I18nProvider } from "@/lib/i18n/context";
import { dictionaries, fmt, type Locale } from "@/lib/i18n";
import { CustomVoice } from "@/components/voice/CustomVoice";
import { PROFILE_COLUMNS } from "@/lib/custom-voice";

const UID = "3f2b8c1e-5d6a-4b7c-8d9e-0f1a2b3c4d5e";
const PID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const PHRASE = "apple river candle window garden pencil";
const VOICE_ID = "ABCDEFGHIJ0123456789";
const OWNER_REF = "0123456789abcdef0123456789abcdef";
const SHA = "f".repeat(64);
const LOCALES: Locale[] = ["en", "ru", "uz"];
const d = (l: Locale = "en") => dictionaries[l].customVoice;

const started = () => ({ ok: true, replay: false, profile_id: PID, status: "pending_verification", phrase: PHRASE, upload_prefix: `${UID}/${PID}/`, expires_at: "2026-10-24T20:00:00Z" });

function row(over: Row = {}): Row {
  return {
    id: PID,
    name: "My narrator",
    status: "pending_verification",
    reject_reason: null,
    sample_state: "awaiting",
    keep_sample: false,
    created_at: "2026-10-24T10:00:00Z",
    // Columns the page never asks for. A real database would not send them; if the page asked, they would arrive, and must not show.
    provider_voice_id: VOICE_ID,
    owner_ref: OWNER_REF,
    sample_sha256: SHA,
    ...over,
  };
}

function mount(props: Partial<React.ComponentProps<typeof CustomVoice>> = {}, locale: Locale = "en") {
  const ui: ReactNode = (
    <I18nProvider locale={locale}>
      <CustomVoice channelId="chronos" orgId="org-1" {...props} />
    </I18nProvider>
  );
  return render(ui);
}

// ---- the browser's recorder, faked ----------------------------------------------------------------------------------------
const media = {
  tracksStopped: 0,
  constructed: 0,
  getUserMedia: vi.fn(),
  mime: "audio/webm;codecs=opus",
};
class FakeRecorder {
  static isTypeSupported = (t: string) => t.startsWith("audio/webm") || t === "audio/mp4";
  static last: FakeRecorder | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(_s: unknown, opts?: { mimeType?: string }) {
    media.constructed++;
    FakeRecorder.last = this;
    this.mimeType = opts?.mimeType ?? media.mime;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["0123456789".repeat(40)], { type: this.mimeType }) });
    this.onstop?.();
  }
}
const revoked: string[] = [];
let blobSeq = 0;

function installRecorder() {
  media.tracksStopped = 0;
  media.constructed = 0;
  media.getUserMedia = vi.fn(async () => ({ getTracks: () => [{ stop: () => void media.tracksStopped++ }] }));
  (globalThis as { MediaRecorder?: unknown }).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: media.getUserMedia }, configurable: true });
  URL.createObjectURL = vi.fn(() => `blob:fake/${++blobSeq}`);
  URL.revokeObjectURL = vi.fn((u: string) => void revoked.push(u));
}
function removeRecorder() {
  delete (globalThis as { MediaRecorder?: unknown }).MediaRecorder;
  Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
  delete (document as { permissionsPolicy?: unknown }).permissionsPolicy;
}

beforeEach(() => {
  db.rpcCalls = [];
  db.rpc = {};
  db.profiles = [];
  db.attachments = [];
  db.readError = null;
  db.selects = [];
  db.reads = 0;
  db.uploads = [];
  db.uploadError = null;
  db.tableWrites = [];
  revoked.length = 0;
  media.mime = "audio/webm;codecs=opus";
  installRecorder();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  removeRecorder();
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------
const calls = (fn: string) => db.rpcCalls.filter((c) => c.fn === fn);
const DECLARATIONS = ["decOwnVoice", "decSoleSpeaker", "decOver18", "decDataToPartner", "decNoImpersonation"] as const;

async function openFlow(locale: Locale = "en") {
  mount({}, locale);
  fireEvent.click(await screen.findByRole("button", { name: d(locale).addVoice }));
}
function fillConsent(locale: Locale = "en", name = "Narrator") {
  fireEvent.change(screen.getByLabelText(d(locale).nameLabel), { target: { value: name } });
  for (const k of DECLARATIONS) fireEvent.click(screen.getByLabelText(d(locale)[k]));
}
async function submit(locale: Locale = "en") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: d(locale).continue }));
  });
}
async function toRecording(locale: Locale = "en") {
  db.rpc.request_voice_clone = () => ({ data: started() });
  await openFlow(locale);
  fillConsent(locale);
  await submit(locale);
  await screen.findByTestId("phrase");
}
const flush = () => act(async () => {});
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function record(seconds: number) {
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: d().startRecording }));
  });
  await advance(seconds * 1000);
  const stop = screen.queryByRole("button", { name: d().stopRecording });
  if (stop) {
    await act(async () => {
      fireEvent.click(stop);
    });
  }
}
const dialog = () => within(screen.getByRole("alertdialog"));

// =================================================================================================================================
describe("not available yet: the request function is granted to nobody", () => {
  it("a permission refusal on the request is 'not available yet': nothing recorded, uploaded or stored", async () => {
    db.rpc.request_voice_clone = () => ({ error: { code: "42501", message: "permission denied for function request_voice_clone" } });
    await openFlow();
    fillConsent();
    await submit();
    expect(await screen.findByText(d().notAvailableTitle)).toBeTruthy();
    expect(screen.getByText(d().notAvailableBody).closest("[role=status]")).toBeTruthy();
    // The raw message is never shown.
    expect(document.body.textContent).not.toMatch(/permission denied|request_voice_clone/);
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(media.constructed).toBe(0);
    expect(db.uploads).toEqual([]);
    expect(db.tableWrites).toEqual([]);
    expect(screen.queryByTestId("phrase")).toBeNull();
  });

  it("0117 not being applied at all reads the same way", async () => {
    db.rpc.request_voice_clone = () => ({ error: { code: "PGRST202", message: "Could not find the function public.request_voice_clone" } });
    await openFlow();
    fillConsent();
    await submit();
    expect(await screen.findByText(d().notAvailableTitle)).toBeTruthy();
  });

  it("a voice table that cannot be read shows 'not available yet' in the list, not an empty list and not an error", async () => {
    db.readError = { code: "42501", message: "permission denied for table voice_profiles" };
    mount();
    expect(await screen.findByText(d().notAvailableTitle)).toBeTruthy();
    expect(screen.queryByText(d().noVoices)).toBeNull();
    expect(screen.queryByRole("button", { name: d().addVoice })).toBeNull();
  });

  it("a list that failed for another reason offers a retry, and the retry asks again", async () => {
    db.readError = { code: "XX000", message: "boom" };
    mount();
    expect((await screen.findByRole("alert")).textContent).toContain(d().loadFailed);
    expect(document.body.textContent).not.toContain("boom");
    db.readError = null;
    const before = db.reads;
    fireEvent.click(screen.getByRole("button", { name: d().retry }));
    await screen.findByText(d().noVoices);
    expect(db.reads).toBeGreaterThan(before);
  });
});

// =================================================================================================================================
describe("consent", () => {
  it("shows the explanation and the honest limit before anything is asked", async () => {
    mount();
    await screen.findByText(d().noVoices);
    expect(screen.getByText(d().limitsBody).textContent).toMatch(/does not prove whose voice it is/);
    expect(screen.getByText(d().recordOnlyBody)).toBeTruthy();
    // Nothing has been asked of the database but the list.
    expect(db.rpcCalls).toEqual([]);
  });

  it("keeps Continue disabled until the name is 2 to 60 characters and all five declarations are ticked", async () => {
    await openFlow();
    const go = () => screen.getByRole("button", { name: d().continue }) as HTMLButtonElement;
    expect(go().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(d().nameLabel), { target: { value: "A" } });
    for (const k of DECLARATIONS) fireEvent.click(screen.getByLabelText(d()[k]));
    expect(go().disabled).toBe(true); // name too short
    fireEvent.change(screen.getByLabelText(d().nameLabel), { target: { value: "  Narrator  " } });
    expect(go().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(d().nameLabel), { target: { value: "x".repeat(61) } });
    expect(go().disabled).toBe(true); // too long
    fireEvent.change(screen.getByLabelText(d().nameLabel), { target: { value: "Narrator" } });
    for (const k of DECLARATIONS) {
      fireEvent.click(screen.getByLabelText(d()[k]));
      expect(go().disabled, `without ${k}`).toBe(true);
      fireEvent.click(screen.getByLabelText(d()[k]));
      expect(go().disabled, `with ${k}`).toBe(false);
    }
  });

  it("makes every declaration a required checkbox, each with its own label", async () => {
    await openFlow();
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes).toHaveLength(5);
    for (const b of boxes) expect(b.required).toBe(true);
    for (const k of DECLARATIONS) expect(screen.getByLabelText(d()[k])).toBeTruthy();
  });

  it("marks the consent text as a placeholder that needs counsel, and records the placeholder version", async () => {
    await openFlow();
    expect(screen.getByTestId("consent-placeholder").textContent).toMatch(/counsel review required/i);
    expect(screen.getByText(fmt(d().consentVersion, { version: "v0" }))).toBeTruthy();
  });

  it("asks with exactly the five declarations, the placeholder version, no kept sample and the organization", async () => {
    db.rpc.request_voice_clone = () => ({ data: started() });
    await openFlow();
    fillConsent("en", "  Narrator  ");
    await submit();
    const [call] = calls("request_voice_clone");
    expect(call.args).toMatchObject({
      p_name: "Narrator",
      p_consent_version: "v0",
      p_keep_sample: false,
      p_org: "org-1",
    });
    expect(call.args.p_declarations).toEqual({ own_voice: true, sole_speaker: true, over_18: true, voice_data_to_provider: true, no_impersonation: true });
    expect(call.args.p_idem).toMatch(/^[A-Za-z0-9_:.-]{1,255}$/);
  });

  it("does not ask before the declarations are ticked, even if the form is submitted", async () => {
    await openFlow();
    fireEvent.change(screen.getByLabelText(d().nameLabel), { target: { value: "Narrator" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: d().continue }).closest("form")!);
    });
    expect(calls("request_voice_clone")).toEqual([]);
  });

  it("a retry of the same request reuses the idempotency key; a changed request gets a new one", async () => {
    db.rpc.request_voice_clone = () => ({ error: { code: "XX000", message: "boom" } });
    await openFlow();
    fillConsent();
    await submit();
    await submit();
    fireEvent.change(screen.getByLabelText(d().nameLabel), { target: { value: "Another name" } });
    await submit();
    const keys = calls("request_voice_clone").map((c) => c.args.p_idem);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it.each([
    ["name_real_person", "errNameRealPerson"],
    ["name_length", "errNameLength"],
    ["name_characters", "errNameCharacters"],
    ["name_link", "errNameLink"],
    ["declarations_incomplete", "errDeclarations"],
    ["consent_version", "errConsentVersion"],
    ["org_required", "errOrgRequired"],
    ["rate_limited", "errRateLimited"],
    ["voice_slots", "errVoiceSlots"],
  ] as const)("the database's word %s is shown as a sentence, never raw", async (hint, key) => {
    db.rpc.request_voice_clone = () => ({ error: { code: "22023", message: `voice_request: SECRET-DETAIL (${hint})`, hint } });
    await openFlow();
    fillConsent();
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(d()[key]);
    expect(document.body.textContent).not.toMatch(/SECRET-DETAIL|voice_request/);
    // Still on the form, so the person can fix it.
    expect(screen.queryByTestId("phrase")).toBeNull();
  });

  it("a request that never arrived is a network message, and the form stays", async () => {
    db.rpc.request_voice_clone = () => {
      throw new TypeError("Failed to fetch");
    };
    await openFlow();
    fillConsent();
    await submit();
    expect((await screen.findByRole("alert")).textContent).toBe(d().errNetwork);
  });

  it("an answer without a usable phrase or upload folder is not a started request", async () => {
    for (const bad of [{ ...started(), phrase: "<b>apple</b>" }, { ...started(), upload_prefix: `${UID}/${UID}/` }, { ok: true }]) {
      cleanup();
      db.rpc.request_voice_clone = () => ({ data: bad });
      await openFlow();
      fillConsent();
      await submit();
      expect((await screen.findByRole("alert")).textContent).toBe(d().errGeneric);
      expect(screen.queryByTestId("phrase")).toBeNull();
      expect(media.getUserMedia).not.toHaveBeenCalled();
    }
  });

  it("an unsupported browser is told so before anything is requested, and spends no request", async () => {
    removeRecorder();
    await openFlow();
    fillConsent();
    expect(await screen.findByText(d().recUnsupported)).toBeTruthy();
    expect((screen.getByRole("button", { name: d().continue }) as HTMLButtonElement).disabled).toBe(true);
    await submit();
    expect(calls("request_voice_clone")).toEqual([]);
  });

  it("a site policy that forbids the microphone is told apart from a refusal, before any request", async () => {
    (document as { permissionsPolicy?: unknown }).permissionsPolicy = { allowsFeature: (f: string) => f !== "microphone" };
    await openFlow();
    fillConsent();
    expect(await screen.findByText(d().recBlockedBySite)).toBeTruthy();
    expect((screen.getByRole("button", { name: d().continue }) as HTMLButtonElement).disabled).toBe(true);
    expect(calls("request_voice_clone")).toEqual([]);
  });
});

// =================================================================================================================================
describe("recording", () => {
  it("shows the phrase the database made, the length rule and when the request ends; no file can be chosen", async () => {
    await toRecording();
    expect(screen.getByTestId("phrase").textContent).toBe(PHRASE);
    expect(screen.getByText(fmt(d().phraseHelp, { min: 30, max: 60 }))).toBeTruthy();
    expect(document.querySelector("input[type=file]")).toBeNull();
    expect(document.querySelector("[accept]")).toBeNull();
    expect(document.body.innerHTML).not.toMatch(/type="file"|dropzone|ondrop/i);
  });

  it("tells a refused microphone from a missing one from any other failure, and can try again", async () => {
    await toRecording();
    const start = () => fireEvent.click(screen.getByRole("button", { name: d().startRecording }));
    for (const [err, text] of [
      ["NotAllowedError", d().recDenied],
      ["SecurityError", d().recDenied],
      ["NotFoundError", d().recNoDevice],
      ["AbortError", d().recFailed],
    ] as const) {
      media.getUserMedia.mockRejectedValueOnce(Object.assign(new Error("x"), { name: err }));
      await act(async () => start());
      expect(screen.getByTestId("recorder-status").textContent, err).toContain(text);
      expect(media.constructed).toBe(0);
      // Still able to try again.
      expect((screen.getByRole("button", { name: d().startRecording }) as HTMLButtonElement).disabled).toBe(false);
    }
  });

  it("throws away a take shorter than 30 seconds, says how long it was, releases the microphone and offers no upload", async () => {
    await toRecording();
    await record(10);
    expect(screen.getByTestId("recorder-status").textContent).toContain(fmt(d().recTooShort, { seconds: 10, min: 30 }));
    expect(screen.queryByRole("button", { name: d().uploadRecording })).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
    expect(media.tracksStopped).toBe(1);
    expect(db.uploads).toEqual([]);
    // Record again.
    expect(screen.getByRole("button", { name: d().reRecord })).toBeTruthy();
  });

  it("accepts a take of 30 seconds or more, lets the person listen, and shows the seconds", async () => {
    await toRecording();
    await record(35);
    expect(screen.getByTestId("recorder-status").textContent).toContain(fmt(d().recReady, { seconds: 35 }));
    const audio = document.querySelector("audio") as HTMLAudioElement;
    expect(audio.getAttribute("aria-label")).toBe(d().listenLabel);
    expect(audio.hasAttribute("controls")).toBe(true);
    expect(audio.getAttribute("src")).toMatch(/^blob:/);
    expect((screen.getByRole("button", { name: d().uploadRecording }) as HTMLButtonElement).disabled).toBe(false);
    expect(media.tracksStopped).toBe(1);
  });

  it("accepts exactly 30 seconds and refuses 29", async () => {
    await toRecording();
    await record(29);
    expect(screen.queryByRole("button", { name: d().uploadRecording })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: d().reRecord })));
    await advance(30_000);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: d().stopRecording })));
    expect(screen.getByRole("button", { name: d().uploadRecording })).toBeTruthy();
  });

  it("stops by itself at 60 seconds and never offers more", async () => {
    await toRecording();
    await record(75); // the person walked away; the recorder must not keep going
    expect(screen.getByTestId("recorder-status").textContent).toContain(fmt(d().recMaxReached, { max: 60 }));
    expect(screen.getByTestId("recorder-status").textContent).toContain(fmt(d().recReady, { seconds: 60 }));
    expect(screen.getByRole("timer").textContent).toBe(fmt(d().timerValue, { seconds: 60, max: 60 }));
    expect(media.tracksStopped).toBe(1);
    expect(screen.queryByRole("button", { name: d().stopRecording })).toBeNull();
  });

  it("record again discards the take (its URL is released) and starts clean", async () => {
    await toRecording();
    await record(35);
    const url = (document.querySelector("audio") as HTMLAudioElement).getAttribute("src")!;
    await act(async () => fireEvent.click(screen.getByRole("button", { name: d().reRecord })));
    expect(revoked).toContain(url);
    expect(document.querySelector("audio")).toBeNull();
    expect(screen.queryByRole("button", { name: d().uploadRecording })).toBeNull();
    expect(screen.getByRole("button", { name: d().startRecording })).toBeTruthy();
  });

  it("releases the microphone when the page is left mid-recording", async () => {
    await toRecording();
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: d().startRecording })));
    await advance(5000);
    expect(media.tracksStopped).toBe(0);
    cleanup();
    expect(media.tracksStopped).toBe(1);
  });

  it("a recorder that fails mid-take is a failure, not a take, and the microphone is released", async () => {
    await toRecording();
    vi.useFakeTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: d().startRecording })));
    await advance(40_000);
    await act(async () => void FakeRecorder.last?.onerror?.());
    expect(screen.getByTestId("recorder-status").textContent).toContain(d().recFailed);
    expect(screen.queryByRole("button", { name: d().uploadRecording })).toBeNull();
    expect(document.querySelector("audio")).toBeNull();
    expect(media.tracksStopped).toBe(1);
    // Nothing from the failed take is offered later by a stop.
    await advance(30_000);
    expect(screen.queryByRole("button", { name: d().uploadRecording })).toBeNull();
  });
});

// =================================================================================================================================
describe("upload", () => {
  async function recorded(seconds = 35) {
    await toRecording();
    await record(seconds);
    vi.useRealTimers();
  }
  const send = async () => {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Use this recording|Send again/ }));
    });
  };

  it("uploads to the prefix the database returned as sample.webm, declared as audio/webm, never replacing", async () => {
    await recorded();
    db.profiles = [row({ sample_state: "awaiting" })];
    await send();
    expect(db.uploads).toHaveLength(1);
    expect(db.uploads[0]).toMatchObject({ bucket: "voice-samples", path: `${UID}/${PID}/sample.webm`, type: "audio/webm", upsert: false });
    expect(db.uploads[0].size).toBeGreaterThan(0);
    expect(screen.getByText(d().uploadDone)).toBeTruthy();
  });

  it("only uploads after the request succeeded: the first and only database call before it is the request", async () => {
    await recorded();
    await send();
    expect(db.rpcCalls[0].fn).toBe("request_voice_clone");
    expect(db.uploads).toHaveLength(1);
  });

  it("sends a Safari recording as audio/mp4 with the m4a name the bucket accepts", async () => {
    media.mime = "audio/mp4";
    (FakeRecorder as unknown as { isTypeSupported: (t: string) => boolean }).isTypeSupported = (t) => t === "audio/mp4";
    await recorded();
    await send();
    expect(db.uploads[0]).toMatchObject({ path: `${UID}/${PID}/sample.m4a`, type: "audio/mp4" });
    (FakeRecorder as unknown as { isTypeSupported: (t: string) => boolean }).isTypeSupported = (t) => t.startsWith("audio/webm") || t === "audio/mp4";
  });

  it("after the upload the list is read again so the new request shows", async () => {
    await recorded();
    const before = db.reads;
    db.profiles = [row({ sample_state: "stored" })];
    await send();
    await waitFor(() => expect(db.reads).toBeGreaterThan(before));
    expect(await screen.findByText(d().statusPending)).toBeTruthy();
  });

  it.each([
    [{ message: "new row violates row-level security policy", statusCode: "403" }, "uploadExpired"],
    [{ message: "The resource already exists", statusCode: "409" }, "uploadExists"],
    [{ message: "The object exceeded the maximum allowed size", statusCode: "413" }, "uploadTooLarge"],
    [{ message: "Failed to fetch" }, "uploadNetwork"],
    [{ message: "who knows", statusCode: "500" }, "uploadFailed"],
  ] as const)("a storage refusal (%j) is worded as %s and never raw", async (err, key) => {
    await recorded();
    db.uploadError = err;
    await send();
    expect((await screen.findByRole("alert")).textContent).toBe(d()[key]);
    expect(document.body.textContent).not.toMatch(/row-level|who knows|statusCode/);
  });

  it("keeps the take after a failed send, so sending again needs no new recording", async () => {
    await recorded();
    db.uploadError = { message: "Failed to fetch" };
    await send();
    expect(document.querySelector("audio")).toBeTruthy();
    db.uploadError = null;
    await send();
    expect(db.uploads).toHaveLength(2);
    expect(screen.getByText(d().uploadDone)).toBeTruthy();
  });

  it("a second tap during the send does not send twice", async () => {
    await recorded();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const uploads = db.uploads;
    db.uploadError = null;
    const btn = screen.getByRole("button", { name: d().uploadRecording });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      release();
      await gate;
    });
    expect(uploads).toHaveLength(1);
  });
});

// =================================================================================================================================
describe("the voices, in every state", () => {
  const show = async (r: Row, props: Partial<React.ComponentProps<typeof CustomVoice>> = {}, locale: Locale = "en") => {
    db.profiles = [r];
    mount(props, locale);
    await screen.findByRole("heading", { name: String(r.name) });
  };

  it("asks the table for the explicit columns only, and no provider id, reference, hash or path ever reaches the screen", async () => {
    await show(row({ status: "approved", sample_state: "stored" }));
    expect(db.selects.find((s) => s.table === "voice_profiles")?.columns).toBe(PROFILE_COLUMNS);
    for (const s of db.selects) expect(s.columns).not.toContain("*");
    const text = document.body.innerHTML;
    for (const secret of [VOICE_ID, OWNER_REF, SHA, UID, "provider_voice_id", "owner_ref", "sample_sha256"]) expect(text).not.toContain(secret);
  });

  it("pending, no recording seen: says so, and offers delete", async () => {
    await show(row({ sample_state: "awaiting" }));
    expect(screen.getByText(d().statusPending)).toBeTruthy();
    expect(screen.getByText(d().pendingAwaitingBody)).toBeTruthy();
    expect(screen.getByRole("button", { name: d().deleteVoice })).toBeTruthy();
    expect(screen.queryByRole("button", { name: d().approve })).toBeNull();
  });

  it("pending, recording stored: says it is being checked, and that the page updates by itself", async () => {
    await show(row({ sample_state: "stored" }));
    expect(screen.getByText(d().pendingBody)).toBeTruthy();
    expect(screen.getByText(d().checkingStatus)).toBeTruthy();
  });

  it("testing: the test step is a labelled stub that makes no call, and approve asks the database", async () => {
    await show(row({ status: "testing", sample_state: "stored" }));
    expect(screen.getByText(d().statusTesting)).toBeTruthy();
    expect(screen.getByTestId("test-stub").textContent).toContain(d().testStubLabel);
    expect(screen.getByTestId("test-stub").textContent).toMatch(/TODO/);
    // No button or link that looks like a test.
    expect(screen.queryByRole("button", { name: /test|hear|play/i })).toBeNull();
    expect(db.rpcCalls).toEqual([]);

    db.rpc.approve_voice = () => ({ data: { ok: true, already: false, status: "approved" } });
    fireEvent.click(screen.getByRole("button", { name: d().approve }));
    expect(db.rpcCalls).toEqual([]); // asking first
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().approve })));
    await waitFor(() => expect(calls("approve_voice")).toHaveLength(1));
    expect(calls("approve_voice")[0].args).toEqual({ p_profile: PID });
  });

  it.each([
    ["not_tested", "refNotTested"],
    ["not_verified", "refNotVerified"],
    ["not_testing", "refNotTesting"],
    ["something_new", "refUnknown"],
  ] as const)("approve refused with %s is shown in the sheet and nothing is claimed", async (word, key) => {
    await show(row({ status: "testing" }));
    db.rpc.approve_voice = () => ({ data: { ok: false, error: word } });
    fireEvent.click(screen.getByRole("button", { name: d().approve }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().approve })));
    await waitFor(() => expect(dialog().getByRole("alert").textContent).toBe(d()[key]));
    expect(screen.queryByText(d().statusApproved)).toBeNull();
  });

  it("an approve answer with no ok is not an approval", async () => {
    await show(row({ status: "testing" }));
    db.rpc.approve_voice = () => ({ data: {} });
    fireEvent.click(screen.getByRole("button", { name: d().approve }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().approve })));
    await waitFor(() => expect(dialog().getByRole("alert").textContent).toBe(d().refUnknown));
  });

  it("approved: attach to this channel asks the database for the narrator slot, and its refusal is worded", async () => {
    await show(row({ status: "approved", sample_state: "purged" }));
    expect(screen.getByText(d().statusApproved)).toBeTruthy();
    expect(screen.getByText(d().disclosureBody)).toBeTruthy();
    db.rpc.attach_voice_to_channel = () => ({ data: { ok: false, error: "voice_in_use" } });
    fireEvent.click(screen.getByRole("button", { name: d().attach }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().attach })));
    await waitFor(() => expect(dialog().getByRole("alert").textContent).toBe(d().refVoiceInUse));
    expect(calls("attach_voice_to_channel")[0].args).toEqual({ p_profile: PID, p_channel: "chronos", p_slot: "narrator" });
  });

  it("approved: a role refusal on attach is worded as a permission problem", async () => {
    await show(row({ status: "approved" }));
    db.rpc.attach_voice_to_channel = () => ({ error: { code: "42501", message: "forbidden" } });
    fireEvent.click(screen.getByRole("button", { name: d().attach }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().attach })));
    await waitFor(() => expect(dialog().getByRole("alert").textContent).toBe(d().errForbidden));
  });

  it("approved and attached here: offers detach, not attach, and detaching asks the database", async () => {
    db.attachments = [{ voice_profile_id: PID, channel_id: "chronos", slot: "narrator", status: "active" }];
    await show(row({ status: "approved" }));
    expect(screen.getByText(d().attachedHere)).toBeTruthy();
    expect(screen.queryByRole("button", { name: d().attach })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: d().detach }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().detach })));
    await waitFor(() => expect(calls("detach_voice_from_channel")).toHaveLength(1));
    expect(calls("detach_voice_from_channel")[0].args).toEqual({ p_profile: PID, p_channel: "chronos" });
  });

  it("approved, on the every-channel view: no single channel to attach to, so no attach button", async () => {
    await show(row({ status: "approved" }), { channelId: null });
    expect(screen.getByText(d().attachNeedsChannel)).toBeTruthy();
    expect(screen.queryByRole("button", { name: d().attach })).toBeNull();
  });

  it("approved and attached elsewhere: counts the other channels without naming them", async () => {
    db.attachments = [
      { voice_profile_id: PID, channel_id: "other-a", slot: "narrator", status: "active" },
      { voice_profile_id: PID, channel_id: "other-b", slot: "secondary", status: "active" },
    ];
    await show(row({ status: "approved" }));
    expect(screen.getByText(fmt(d().attachedElsewhere, { count: 2 }))).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/other-a|other-b/);
  });

  it.each([
    ["sample_timeout", "reasonSampleTimeout"],
    ["verification_failed", "reasonPhrase"],
    ["provider_not_enabled", "reasonNotEnabled"],
    ["worker_lost", "reasonOurSide"],
    ["not_audio", "reasonNotAudio"],
    ["a_word_from_the_future", "reasonUnknown"],
    [null, "reasonUnknown"],
  ] as const)("rejected with %s reads as translated text, never the word", async (word, key) => {
    await show(row({ status: "rejected", reject_reason: word, sample_state: "purge_pending" }));
    expect(screen.getByText(d().statusRejected)).toBeTruthy();
    expect(screen.getByText(fmt(d().rejectedBody, { reason: d()[key] }))).toBeTruthy();
    if (word) expect(document.body.textContent).not.toContain(word);
  });

  it("deleted: says deletion was requested (not done), and offers no action", async () => {
    await show(row({ status: "deleted", sample_state: "purge_pending" }));
    expect(screen.getByText(d().statusDeleted)).toBeTruthy();
    expect(screen.getByText(d().deletedBody)).toBeTruthy();
    expect(screen.queryByRole("button", { name: d().deleteVoice })).toBeNull();
    expect(screen.queryByRole("button", { name: d().approve })).toBeNull();
    expect(screen.queryByRole("button", { name: d().attach })).toBeNull();
  });

  it("a status this build does not know reads as unknown and offers no action", async () => {
    await show(row({ status: "paused" }));
    expect(screen.getByText(d().statusUnknown)).toBeTruthy();
    expect(screen.getByText(d().unknownBody)).toBeTruthy();
    expect(screen.queryByRole("button", { name: d().deleteVoice })).toBeNull();
  });

  it("delete voice asks first, then asks the database; its refusal stays in the sheet", async () => {
    await show(row({ status: "approved" }));
    db.rpc.delete_voice = () => ({ error: { code: "P0002", message: "not_found" } });
    fireEvent.click(screen.getByRole("button", { name: d().deleteVoice }));
    expect(calls("delete_voice")).toEqual([]);
    expect(dialog().getByText(d().deleteVoiceMessage)).toBeTruthy();
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().deleteVoice })));
    await waitFor(() => expect(dialog().getByRole("alert").textContent).toBe(d().errNotFound));
    expect(calls("delete_voice")[0].args).toEqual({ p_profile: PID });
  });

  it("cancelling the delete asks the database nothing", async () => {
    await show(row({ status: "approved" }));
    fireEvent.click(screen.getByRole("button", { name: d().deleteVoice }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: dictionaries.en.ux.confirmCancel })));
    expect(db.rpcCalls).toEqual([]);
  });

  it("delete my recording is offered only for a stored recording, asks first, and asks the database", async () => {
    await show(row({ status: "approved", sample_state: "purged" }));
    expect(screen.queryByRole("button", { name: d().deleteSample })).toBeNull();
    cleanup();
    await show(row({ status: "approved", sample_state: "stored", keep_sample: true }));
    expect(screen.getByText(d().sampleStored)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: d().deleteSample }));
    expect(calls("delete_voice_sample")).toEqual([]);
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().deleteSample })));
    await waitFor(() => expect(calls("delete_voice_sample")).toHaveLength(1));
    expect(calls("delete_voice_sample")[0].args).toEqual({ p_profile: PID });
  });

  it("says where the raw recording is: queued for deletion, or deleted", async () => {
    await show(row({ status: "approved", sample_state: "purge_pending" }));
    expect(screen.getByText(d().samplePurgePending)).toBeTruthy();
    cleanup();
    await show(row({ status: "approved", sample_state: "purged" }));
    expect(screen.getByText(d().samplePurged)).toBeTruthy();
  });

  it("renders the name and everything else from the database as text, never as markup", async () => {
    const evil = `<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>`;
    await show(row({ name: evil, status: "rejected", reject_reason: `<b>sample_timeout</b>` }));
    expect(screen.getByRole("heading", { name: evil })).toBeTruthy();
    expect(document.querySelector("img[onerror]")).toBeNull();
    expect(document.querySelector("script")).toBeNull();
    expect(document.querySelector("li b")).toBeNull();
    expect((window as { __pwn?: number }).__pwn).toBeUndefined();
  });

  it("every action writes through a database function, never a table", async () => {
    await show(row({ status: "approved" }));
    db.rpc.delete_voice = () => ({ data: { ok: true } });
    fireEvent.click(screen.getByRole("button", { name: d().deleteVoice }));
    await act(async () => fireEvent.click(dialog().getByRole("button", { name: d().deleteVoice })));
    await waitFor(() => expect(calls("delete_voice")).toHaveLength(1));
    expect(db.tableWrites).toEqual([]);
  });

  it("an empty list says so and offers to add a voice", async () => {
    mount();
    expect(await screen.findByText(d().noVoices)).toBeTruthy();
    expect(screen.getByRole("button", { name: d().addVoice })).toBeTruthy();
  });
});

// =================================================================================================================================
describe("waiting for the check", () => {
  it("looks again every 5 seconds while a request is pending, and stops when it settles", async () => {
    vi.useFakeTimers();
    db.profiles = [row({ sample_state: "stored" })];
    mount();
    await flush();
    expect(db.reads).toBe(1);
    await advance(5000);
    expect(db.reads).toBe(2);
    await advance(5000);
    expect(db.reads).toBe(3);
    db.profiles = [row({ status: "testing", sample_state: "stored" })];
    await advance(5000);
    expect(screen.getByText(d().statusTesting)).toBeTruthy();
    const settled = db.reads;
    await advance(60_000);
    expect(db.reads).toBe(settled);
    expect(screen.queryByText(d().checkingStatus)).toBeNull();
  });

  it("does not poll at all when nothing is pending", async () => {
    vi.useFakeTimers();
    db.profiles = [row({ status: "approved" })];
    mount();
    await flush();
    await advance(60_000);
    expect(db.reads).toBe(1);
  });

  it("stops by itself after 10 minutes, says so, and Check again starts it over", async () => {
    vi.useFakeTimers();
    db.profiles = [row({ sample_state: "stored" })];
    mount();
    await flush();
    await advance(10 * 60 * 1000 + 6000);
    expect(screen.getByText(d().checkingPaused)).toBeTruthy();
    const stopped = db.reads;
    await advance(60_000);
    expect(db.reads).toBe(stopped);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: d().refresh })));
    expect(db.reads).toBe(stopped + 1);
    expect(screen.queryByText(d().checkingPaused)).toBeNull();
    await advance(5000);
    expect(db.reads).toBe(stopped + 2);
  });

  it("stops polling when the page is left", async () => {
    vi.useFakeTimers();
    db.profiles = [row({ sample_state: "stored" })];
    mount();
    await flush();
    cleanup();
    const n = db.reads;
    await advance(30_000);
    expect(db.reads).toBe(n);
  });

  it("announces status changes in a polite live region", async () => {
    db.profiles = [row({ sample_state: "stored" })];
    mount();
    await screen.findByText(d().checkingStatus);
    const region = screen.getByText(d().checkingStatus).closest("[aria-live]");
    expect(region?.getAttribute("aria-live")).toBe("polite");
    expect(region?.getAttribute("role")).toBe("status");
  });
});

// =================================================================================================================================
describe("languages and layout", () => {
  it.each(["ru", "uz"] as Locale[])("renders the list, a card and the consent form in %s", async (locale) => {
    db.profiles = [row({ status: "rejected", reject_reason: "verification_failed" })];
    mount({}, locale);
    expect(await screen.findByText(d(locale).statusRejected)).toBeTruthy();
    expect(screen.getByText(fmt(d(locale).rejectedBody, { reason: d(locale).reasonPhrase }))).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: d(locale).addVoice }));
    expect(screen.getByTestId("consent-placeholder").textContent).toBe(d(locale).consentPlaceholderMarker);
    for (const k of DECLARATIONS) expect(screen.getByLabelText(d(locale)[k])).toBeTruthy();
  });

  it("the not-available state is translated", async () => {
    db.rpc.request_voice_clone = () => ({ error: { code: "42501", message: "permission denied for function request_voice_clone" } });
    for (const locale of LOCALES) {
      cleanup();
      await openFlow(locale);
      fillConsent(locale);
      await submit(locale);
      expect(await screen.findByText(d(locale).notAvailableTitle)).toBeTruthy();
    }
  });

  it("uses no fixed width that could overflow a 320 px screen", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..", "components", "voice");
    for (const f of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, f), "utf8");
      expect(src, f).not.toMatch(/\bw-\[\d{3,}px\]|min-w-\[\d{3,}px\]|width:\s*\d{3,}px/);
    }
  });
});
