"use client";

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUp, Film, FolderOpen, ImageIcon, LayoutTemplate, ListChecks, Projector } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { STUDIO_PROJECTS } from "@/lib/navigation";
import { filmStudioStrings } from "@/lib/i18n/film-studio";
import { useChannelPath } from "@/lib/channels-client";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { StudioSide, type CreditsReading, type ProjectsReading } from "@/components/studio/Desks";
import { AssistantPlanner, savedPlanPhase, type AssistantPlannerProps, type PlannerPhase } from "@/components/assistant/AssistantPlanner";
import { DESK_ICONS } from "@/components/studio/deskIcons";
import { DESK_TOOLS, deskFor, deskHref, type MediaDesk } from "@/lib/creative/desks";
import {
  CREATIVE_EXAMPLES,
  STUDIO_MODES,
  examplePrompt,
  exampleFillsPrompt,
  type CreativeExample,
  type StudioMode,
} from "@/lib/creative/examples";
import {
  defaultDescribeLanguage,
  describePrefill,
  isActiveStatus,
  isStudioCapability,
  modelsFor,
  needsSource,
  promptRule,
  type StudioCapability,
  type StudioJob,
  type StudioModel,
  type StudioPrefill,
} from "@/lib/creative/studio";
import { TOPIC_MAX } from "@/lib/home";
import { attachErrorKey, attachWords, toolForAttachment, uploadAttachment } from "@/lib/creative/attach";
import { checkAttachment, discardPending, indexedDbStore, takePending, type AttachKind } from "@/lib/site/pending-attachment";
import { PENDING_PARAM } from "@/lib/site/prompt-link";
import { IDEA_PARAM, takeIdea } from "@/lib/site/idea-handoff";
import { StartBox, type StartChannel } from "@/components/prompt/StartBox";
import { KIND_TOOL, type CreateKind } from "@/lib/customer/create";
import { formatMediaBytes } from "@/lib/media";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import "@/components/studio/desk.css";
import "@/components/studio/studio-home.css";
import "@/components/studio/availability.css";
import { useShell } from "@/components/shell/ShellContext";
import { DeskAvailabilityNote, NothingOnSaleNote } from "@/components/studio/Availability";
import { deskOpen, nothingOnSale, toolOpen, type ToolAvailability } from "@/lib/tool-availability";

/** A kind of the overview with something on sale (the YouTube video is the channel pipeline, not a model on sale). */
function modeOpen(av: ToolAvailability, m: StudioMode): boolean {
  return m === "youtube" || deskOpen(av, m);
}

/**
 * The kind the overview opens on: the one a link came with; else the first with something on sale, so a person whose workspace can
 * buy no picture is not greeted by a picture box that cannot be sent (the YouTube video when nothing is on sale).
 */
export function startMode(av: ToolAvailability, initial: StudioPrefill | null): StudioMode {
  if (initial && isStudioCapability(initial.capability)) return deskFor(initial.capability);
  return STUDIO_MODES.find((m) => modeOpen(av, m)) ?? "youtube";
}

/** Smooth only for a reader who has not asked for less motion. */
function scrollBehavior(): ScrollBehavior {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "auto";
  }
}

/** The props the page computes for the Assistant (all of them data: the page is a server component). */
export type AssistantData = Pick<AssistantPlannerProps, "orgId" | "models" | "channels" | "currentSlug" | "canRun" | "runConfigured">;

/**
 * /create with no section asked for: composer first. "What shall we make
 * today?", the five kinds as chips, one box to write in (the existing
 * composer, GeneratePanel's `composer` layout: same tools, same quote, same
 * create request), examples that fill it, the recent work as pictures, and the
 * full pages under "Advanced". Nothing on this page spends except the box's
 * priced send key; every card, chip and action only fills the box.
 *
 * On a phone the box is pinned above the tab bar while the page scrolls under
 * it (studio-home.css), the way a chat's input is.
 */
export function StudioHome({
  orgId,
  models,
  unavailable = [],
  plans = null,
  defaultStyleKitId = null,
  dna = null,
  bottomBar = true,
  initial = null,
  credits,
  projects,
  assistant = null,
  pending = null,
  idea = false,
  ideaKind = "video",
  start = null,
}: {
  orgId: string | null;
  models: StudioModel[];
  unavailable?: readonly string[];
  plans?: UpsellCatalog | null;
  defaultStyleKitId?: string | null;
  dna?: (StudioDna & { href: string }) | null;
  /** The phone's bottom tab bar is shown (not for the platform operator): the pinned box rests above it. */
  bottomBar?: boolean;
  /** A form the link came with (a model from the catalog, a preset): fills the box once. */
  initial?: StudioPrefill | null;
  credits: CreditsReading;
  projects: ProjectsReading;
  /** The Assistant's data; null = no Plan toggle (no organization to plan for). */
  assistant?: AssistantData | null;
  /**
   * The public home page's composer sent a file kept in this browser for this link (`?attach=<nonce>`, lib/site/pending-attachment.ts),
   * with the words typed beside it (already cleaned by the page). Taken once, and uploaded only when the person answers Use.
   */
  pending?: { nonce: string; words: string } | null;
  /** `?idea=1`: the landing's idea box kept the visitor's words in this browser (lib/site/idea-handoff.ts); the box takes them once. */
  idea?: boolean;
  /** `?idea=1&kind=image|audio`: the start box sent the words for that kind, so they fill its box, not the clip box. */
  ideaKind?: CreateKind;
  /** The start box at the top (components/prompt/StartBox.tsx): whether the server's flag opens Nightshift AI here, and the channel; null = none. */
  start?: { agentOpen: boolean; channel: StartChannel | null } | null;
}) {
  const { t, locale, fmt } = useI18n();
  const th = t.studioHome;
  const path = useChannelPath();
  const router = useRouter();
  const { tools, features } = useShell();
  const [mode, setMode] = useState<StudioMode>(() => startMode(tools, initial));
  const [planning, setPlanning] = useState(false);
  // Once opened, the planner stays mounted (hidden while another mode is shown): a running plan's loop
  // belongs to that one instance, so leaving the Plan never orphans it and coming back never starts a second.
  const [planMounted, setPlanMounted] = useState(false);
  const [planPhase, setPlanPhase] = useState<PlannerPhase>("plan");
  // Whether the next box takes focus: yes when a card or an action filled it, no when a mode chip was picked.
  const [focusBox, setFocusBox] = useState(initial !== null);
  // The words typed, carried across modes and into the Plan.
  const [draft, setDraft] = useState(initial?.prompt ?? "");
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill | null }>({ nonce: 0, value: initial });
  const [topicNonce, setTopicNonce] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [working, setWorking] = useState<Partial<Record<MediaDesk, number>>>({});
  const composerRef = useRef<HTMLDivElement>(null);
  const examplesRef = useRef<HTMLElement>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const homeRef = useRef<HTMLDivElement>(null);

  // A plan interrupted on this device (running when the tab closed, or stopped at a refusal) opens the Plan,
  // so it is shown with its Continue as it was when the planner sat on this page. A finished one waits behind the toggle.
  useEffect(() => {
    if (!assistant) return;
    const saved = savedPlanPhase(assistant.orgId);
    if (saved === "running" || saved === "stopped") {
      setPlanMounted(true);
      setPlanning(true);
    }
    // Once, on load: later changes are the person's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The pinned box on a phone: never taller than what is visible, and lifted above the on-screen keyboard
  // (the visual viewport shrinks under it while the layout viewport, which sticky follows, does not).
  useEffect(() => {
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    const el = homeRef.current;
    if (!vv || !el) return;
    const dockPx = bottomBar ? 60 : 0;
    const update = () => {
      const keyboard = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      const open = keyboard > 80;
      el.style.setProperty("--sh-kb", `${open ? keyboard : 0}px`);
      el.style.setProperty("--sh-room", `${Math.max(160, Math.round(vv.height - (open ? 0 : dockPx) - 24))}px`);
    };
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, [bottomBar]);

  // A file attached with [+] (or from the home page): asked about (the home page's), on its way into the library, in the library
  // and offered (the person had moved on meanwhile), or the one line that says what became of it.
  const [attach, setAttach] = useState<
    | { phase: "idle" }
    // No object URL: nothing of the file (its picture, its name) is drawn before the person answers Use.
    | { phase: "confirm"; file: File; kind: AttachKind; words: string }
    | { phase: "uploading"; name: string; kind: AttachKind; url: string }
    | { phase: "ready"; assetId: string; kind: AttachKind; name: string; desk: MediaDesk | null }
    | { phase: "said"; tone: "ok" | "error"; line: string }
  >({ phase: "idle" });
  const attachSeq = useRef(0);
  const pickedUp = useRef(false);
  // The words as typed NOW (an upload that ends reads these, not the ones it started with).
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Every choice the person makes (a mode, an example, a result into the box, the Plan) counts here: an upload that ends after one
  // is offered, never forced over it.
  const choices = useRef(0);
  // Every change the person makes INSIDE the box (words, model, shape, length, any setting: GeneratePanel onEdit, the topic box's
  // typing), by the same rule. Not onDraftChange, which also fires when a box mounts with its words.
  const edits = useRef(0);
  const planningRef = useRef(planning);
  planningRef.current = planning;
  // The box is pressing Generate (GeneratePanel onSubmittingChange): it is never swapped under a create in flight.
  const panelSubmitting = useRef(false);
  const [submittingNow, setSubmittingNow] = useState(false);
  const uploadAbort = useRef<AbortController | null>(null);

  // The local preview's object URL lives as long as the line that shows it.
  useEffect(() => {
    if (attach.phase !== "uploading") return;
    const url = attach.url;
    return () => URL.revokeObjectURL(url);
  }, [attach]);

  // Leaving the page stops the transfer (the PUT takes the same signal) and the asking about it. A file already sent stays the
  // library's; one cut off mid-PUT is never registered, and its ticket lapses.
  useEffect(() => () => uploadAbort.current?.abort(), []);

  /** Focus is in a text field of the composer (the words, the topic, the Plan's goal): a remount now would take it away mid-word. */
  const typingInBox = (): boolean => {
    const el = typeof document !== "undefined" ? document.activeElement : null;
    if (!el || !composerRef.current?.contains(el)) return false;
    return el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "file");
  };

  const toComposer = () => composerRef.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: "nearest" });

  /** The mode's first tool that someone sells (the panel's own starting rule). */
  const firstTool = (d: MediaDesk): StudioCapability => DESK_TOOLS[d].find((c) => modelsFor(models, c).length > 0) ?? DESK_TOOLS[d][0];
  const form = (capability: StudioCapability, over: Partial<StudioPrefill> = {}): StudioPrefill => ({
    capability,
    model: "",
    prompt: "",
    aspect: dna?.aspect ?? "16:9",
    duration: 5,
    ...over,
  });

  /** A fresh box with these settings (a new mount: nothing typed before leaks into it). `auto`: an attachment's own switch, not a choice. */
  const fill = (value: StudioPrefill | null, nextMode?: StudioMode, auto = false) => {
    if (!auto) choices.current += 1;
    setPlanning(false);
    setFocusBox(true);
    if (nextMode) setMode(nextMode);
    else if (value && isStudioCapability(value.capability)) setMode(deskFor(value.capability));
    setPrefill((p) => ({ nonce: p.nonce + 1, value }));
    if (value) setDraft(value.prompt);
    toComposer();
  };

  /** Words handed to this page (the landing's idea, the start box above): the box of the kind they were sent for (Create's own map). */
  const fillWords = (words: string, kind: CreateKind, auto = false) => {
    const tool = KIND_TOOL[kind];
    fill(form(tool, { prompt: attachWords(tool, words) }), undefined, auto);
  };

  /** A fresh box for mode `m`, with the words typed so far where its first tool takes words (Enhance starts from a file). */
  const openMode = (m: StudioMode) => {
    choices.current += 1;
    setMode(m);
    setFocusBox(false);
    // A fresh box: the last attachment's line was about the box it replaced.
    if (attach.phase === "said") setAttach({ phase: "idle" });
    if (m === "youtube") {
      setTopicNonce((n) => n + 1);
      return;
    }
    const cap = firstTool(m);
    const carry = draft.trim() && promptRule(cap) !== "none" && m !== "enhance";
    setPrefill((p) => ({ nonce: p.nonce + 1, value: carry ? form(cap, { prompt: draft }) : null }));
  };

  const switchMode = (m: StudioMode) => {
    if (m === mode && !planning) return;
    setPlanning(false);
    openMode(m);
  };

  // Back from the Plan, the goal's words come with it.
  const togglePlan = () => {
    if (planning) {
      setPlanning(false);
      openMode(mode);
    } else {
      choices.current += 1;
      setPlanMounted(true);
      setPlanning(true);
    }
  };

  const pickExample = (e: CreativeExample) => {
    const text = examplePrompt(e, locale);
    if (e.mode === "youtube" || !e.capability) {
      setPlanning(false);
      setFocusBox(true);
      setMode("youtube");
      setDraft(text);
      setTopicNonce((n) => n + 1);
      toComposer();
      return;
    }
    // The example's model only when this organization is offered it for the tool; else the box's own default.
    const offered = e.modelId && modelsFor(models, e.capability).some((m) => m.id === e.modelId) ? e.modelId : "";
    fill(
      form(e.capability, {
        model: offered,
        prompt: exampleFillsPrompt(e) ? text : "",
        ...(e.aspect ? { aspect: e.aspect } : {}),
        ...(e.duration ? { duration: e.duration } : {}),
      }),
      e.mode,
    );
  };

  // A finished picture into the box: as a source for this mode's picture tool, a clip, or an upscale.
  const useAsSource = (id: string) => {
    const m: MediaDesk = mode !== "youtube" && DESK_TOOLS[mode].some(needsSource) ? mode : "image";
    const cap = DESK_TOOLS[m].find(needsSource) ?? "edit";
    fill(form(cap, { sourceId: id, prompt: promptRule(cap) === "none" ? "" : draft }), m);
  };
  const animate = (id: string) => fill(form("i2v", { sourceId: id }), "video");
  const enhance = (id: string) => fill(form("upscale", { sourceId: id, factor: 2 }), "enhance");
  const describe = (id: string) => {
    const value = describePrefill(id, defaultDescribeLanguage(locale));
    if (value) fill(value, "image");
  };

  /** An attached file now in the library into the box: the tool for its kind on `desk`, the words as typed now, the switch said. */
  const applyAttached = (assetId: string, kind: AttachKind, onDesk: MediaDesk | null) => {
    const words = draftRef.current;
    const cap = toolForAttachment(kind, models, onDesk);
    fill(form(cap, { sourceId: assetId, prompt: attachWords(cap, words) }), deskFor(cap), true);
    // A tool that takes no words still keeps them typed for the next box.
    setDraft(words);
    setAttach({
      phase: "said",
      tone: "ok",
      line: fmt(kind === "image" ? th.attachFlow.switchedImage : th.attachFlow.switchedVideo, { tool: t.desk.tools[cap] }),
    });
  };

  /**
   * A picture or a video into the box: the library's upload first, then the tool for what the library registered it as, on the desk
   * it was attached on (lib/creative/attach toolForAttachment), with the words as typed when it lands. The change of tool is said in
   * one line (CLAUDE.md #4). If the person moved on meanwhile (another mode, an example, a result into the box), changed anything
   * in the box (the swap is a fresh mount: a model, a shape or a length picked meanwhile was lost), is typing in it (the remount
   * takes focus and broke an IME composition) or is pressing Generate, the box is NOT swapped under them: the file is offered with
   * "Use it in the box" instead. Nothing is priced or started here: the box asks its price as for any filled form, and only its
   * send key spends.
   */
  const attachFile = async (file: File, onDesk: MediaDesk | null) => {
    const check = checkAttachment(file);
    if (!check.ok) {
      const line =
        check.error === "type"
          ? th.attachFlow.badType
          : check.error === "size"
            ? fmt(th.attachFlow.tooBig, { max: formatMediaBytes(check.max ?? null) })
            : th.attachFlow.emptyFile;
      setAttach({ phase: "said", tone: "error", line });
      return;
    }
    if (!orgId) {
      setAttach({ phase: "said", tone: "error", line: th.attachFlow.noOrg });
      return;
    }
    const seq = ++attachSeq.current;
    uploadAbort.current?.abort();
    const ctl = new AbortController();
    uploadAbort.current = ctl;
    const choicesAtStart = choices.current;
    const editsAtStart = edits.current;
    setAttach({ phase: "uploading", name: file.name, kind: check.kind, url: URL.createObjectURL(file) });
    const r = await uploadAttachment({ orgId, file, kind: check.kind, mime: check.mime, signal: ctl.signal });
    // A newer file was attached meanwhile, or the page is gone: this one's outcome is not what the box shows.
    if (seq !== attachSeq.current || ctl.signal.aborted) return;
    if (!r.ok) {
      const key = attachErrorKey(r.error);
      const media = t.media.errors as Record<string, string>;
      const line = "flow" in key ? th.attachFlow[key.flow] : fmt(media[key.media] ?? media.failed, { max: formatMediaBytes(r.maxBytes ?? null) || "—" });
      setAttach({ phase: "said", tone: "error", line });
      return;
    }
    // In the Plan: the swap would close it under the person (its goal box is theirs as much as the words are).
    if (choices.current !== choicesAtStart || edits.current !== editsAtStart || typingInBox() || planningRef.current || panelSubmitting.current) {
      setAttach({ phase: "ready", assetId: r.assetId, kind: r.kind, name: file.name, desk: onDesk });
      return;
    }
    applyAttached(r.assetId, r.kind, onDesk);
  };

  // The home page's kept file, for THIS link's nonce: taken out of this browser once (read and deleted in one transaction, so a
  // reload, React's second effect run or another tab never takes it twice), and the address loses `attach=`. Nothing is uploaded
  // until the person answers "Use the file you attached on the home page?" (the tab may not be theirs: someone else may have signed
  // up in it). The words come into the clip box either way.
  useEffect(() => {
    if (!pending || pickedUp.current) return;
    pickedUp.current = true;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete(PENDING_PARAM);
      window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
    } catch {
      // The address keeps the nonce; the file is taken once either way.
    }
    const words = pending.words;
    // No workspace to put it in: nothing will read it later, so it is not kept; the line says to attach it again.
    if (!orgId) {
      void discardPending(indexedDbStore());
      setAttach({ phase: "said", tone: "error", line: th.attachFlow.noOrg });
      return;
    }
    void takePending(indexedDbStore(), pending.nonce).then((p) => {
      if (words) fillWords(words, ideaKind, true);
      if (p.state === "ready") {
        setAttach({ phase: "confirm", file: p.file, kind: p.kind, words });
        return;
      }
      // The file is not here: said, never a box that looks attached.
      setAttach({
        phase: "said",
        tone: "error",
        line: p.state === "expired" ? th.attachFlow.expired : p.state === "unavailable" ? th.attachFlow.unreadable : th.attachFlow.gone,
      });
    });
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The landing's idea, taken out of this browser once (read and deleted together: a reload or another tab never fills it twice) and
  // put in the clip box, not sent: nothing is priced or started until the person presses the button and sees the price (rule 3).
  // The address loses `idea=` either way. Nothing kept (expired, another browser, storage off) is an empty box, never an error.
  const ideaTaken = useRef(false);
  useEffect(() => {
    if (!idea || ideaTaken.current) return;
    ideaTaken.current = true;
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete(IDEA_PARAM);
      window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
    } catch {
      // The address keeps `idea=1`; the words are taken once either way.
    }
    const words = takeIdea();
    if (words) fillWords(words, ideaKind, true);
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onJobs = (jobs: StudioJob[]) => {
    const n: Partial<Record<MediaDesk, number>> = {};
    for (const j of jobs) {
      if (!isActiveStatus(j.status) || !isStudioCapability(j.capability)) continue;
      const d = deskFor(j.capability);
      n[d] = (n[d] ?? 0) + 1;
    }
    setWorking(n);
  };

  // The chips are one radio group: ←/→ move and choose, Home/End jump, one tab stop. A kind with nothing on sale is passed over.
  function onChipKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = STUDIO_MODES.length;
    const open = (k: number) => modeOpen(tools, STUDIO_MODES[k]);
    const step = (from: number, d: number) => {
      for (let k = 1; k <= n; k++) {
        const j = (from + d * k + n * k) % n;
        if (open(j)) return j;
      }
      return -1;
    };
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = step(i, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = step(i, -1);
    else if (e.key === "Home") to = step(n - 1, 1);
    else if (e.key === "End") to = step(0, -1);
    if (to < 0) return;
    e.preventDefault();
    switchMode(STUDIO_MODES[to]);
    chipRefs.current[to]?.focus();
  }

  const planRunning = planPhase === "running";
  const planToggle = assistant ? (
    <button
      type="button"
      aria-pressed={planning}
      onClick={togglePlan}
      aria-label={th.plan.toggleLabel}
      title={th.plan.toggleLabel}
      className="sc-pill tap press"
      data-testid="composer-plan"
    >
      <ListChecks aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="sc-pill-label">{th.plan.toggle}</span>
      {/* A plan still making its items while another mode is open: said here, never hidden. */}
      {planRunning && !planning && (
        <span data-testid="composer-plan-running">
          <span aria-hidden className="ns-lamp" data-tone="run" data-live="true" />
          <span className="sr-only">{t.assistant.status.creating}</span>
        </span>
      )}
    </button>
  ) : null;

  const desk: MediaDesk | null = mode === "youtube" ? null : mode;
  const planner =
    assistant && planMounted ? (
      <div hidden={!planning} data-testid="plan-box">
        <AssistantPlanner
          {...assistant}
          variant="composer"
          initialGoal={draft}
          onGoalChange={setDraft}
          onPhaseChange={setPlanPhase}
          composerExtra={planning ? planToggle : null}
        />
      </div>
    ) : null;
  // The attachment's upload and its one line live INSIDE the box, in its flow: drawn after the box they sat on the page's own text
  // where the pinned phone box overlaps it (studio-attached-390, the first screenshots of this change).
  const thumb = (kind: AttachKind, url: string) => (
    <span className="sh-attach-thumb" aria-hidden>
      {kind === "image" ? (
        // The person's own file from this device: never optimised or sent anywhere else.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" />
      ) : (
        <>
          <video src={`${url}#t=0.1`} muted playsInline preload="metadata" />
          <Film className="sh-attach-mark" />
        </>
      )}
    </span>
  );
  const confirmWords = (kind: AttachKind) => (kind === "image" ? th.attachFlow.confirmImage : th.attachFlow.confirmVideo);
  // Seen in the box; HEARD from one live region outside it (attachLive below), which does not remount when the box does.
  const attachNote: ReactNode =
    attach.phase === "confirm" ? (
      // Its kind, in words and a glyph, and nothing of the file itself: the browser may be shared, and whoever signed in may not be
      // the one who chose it. Its picture and its name are drawn from Use on (the upload's line).
      <div className="sh-attach sh-attach-ask" data-testid="composer-pending-confirm">
        <span className="sh-attach-glyph" aria-hidden>
          {attach.kind === "image" ? <ImageIcon className="size-4" strokeWidth={1.75} /> : <Film className="size-4" strokeWidth={1.75} />}
        </span>
        <div className="sh-attach-ask-body">
          <p className="sh-attach-ask-title">{confirmWords(attach.kind)}</p>
          <p className="sh-attach-ask-note">{th.attachFlow.confirmNote}</p>
          <div className="sh-attach-ask-keys">
            <button
              type="button"
              className="sc-pill tap press"
              data-testid="composer-pending-use"
              onClick={(e) => {
                // The answer takes focus (Safari would leave it in the words): a words box still focused when the upload ends would
                // read as typing, and the file would only be offered.
                e.currentTarget.focus();
                void attachFile(attach.file, null);
              }}
            >
              {th.attachFlow.confirmUse}
            </button>
            <button
              type="button"
              className="sc-pill tap press"
              data-testid="composer-pending-discard"
              onClick={() => setAttach({ phase: "said", tone: "ok", line: th.attachFlow.discarded })}
            >
              {th.attachFlow.confirmDiscard}
            </button>
          </div>
        </div>
      </div>
    ) : attach.phase === "uploading" ? (
      <div className="sh-attach" data-testid="composer-uploading">
        {thumb(attach.kind, attach.url)}
        <span className="sh-attach-line">{fmt(th.attachFlow.uploading, { name: attach.name })}</span>
      </div>
    ) : attach.phase === "ready" ? (
      <div className="sh-attach" data-testid="composer-attach-ready">
        <span className="sh-attach-line">{fmt(th.attachFlow.ready, { name: attach.name })}</span>
        <button
          type="button"
          className="sc-pill tap press"
          data-testid="composer-attach-use"
          disabled={submittingNow}
          onClick={() => applyAttached(attach.assetId, attach.kind, attach.desk)}
        >
          {th.attachFlow.readyUse}
        </button>
      </div>
    ) : attach.phase === "said" ? (
      <p className="sh-attach-said" data-tone={attach.tone} data-testid="composer-attach-line">
        {attach.line}
      </p>
    ) : null;
  const attachLive =
    attach.phase === "confirm"
      ? confirmWords(attach.kind)
      : attach.phase === "uploading"
        ? fmt(th.attachFlow.uploading, { name: attach.name })
        : attach.phase === "ready"
          ? fmt(th.attachFlow.ready, { name: attach.name })
          : attach.phase === "said"
            ? attach.line
            : "";
  let noteInBox = false;
  let box: ReactNode = null;
  if (planning && assistant) {
    box = null;
  } else if (mode === "youtube") {
    box = (
      <TopicComposer
        key={topicNonce}
        initial={draft}
        autoFocus={focusBox}
        onDraft={(v) => {
          edits.current += 1;
          setDraft(v);
        }}
        extra={planToggle}
        onGo={(topic) => router.push(path(`/create?desk=youtube&topic=${encodeURIComponent(topic)}`))}
      />
    );
  } else if (orgId && desk) {
    noteInBox = true;
    box = (
      <GeneratePanel
        key={`${mode}:${prefill.nonce}`}
        layout="composer"
        desk={desk}
        orgId={orgId}
        models={models}
        initial={prefill.value && deskFor(prefill.value.capability) === desk ? prefill.value : null}
        defaultStyleKitId={defaultStyleKitId}
        dna={dna}
        plans={plans}
        unavailable={unavailable}
        onDraftChange={setDraft}
        onEdit={() => {
          edits.current += 1;
        }}
        autoFocusPrompt={focusBox}
        composerExtra={planToggle}
        onAttachFile={desk === "voice" ? undefined : (file) => void attachFile(file, desk)}
        onSubmittingChange={(on) => {
          panelSubmitting.current = on;
          setSubmittingNow(on);
        }}
        attachBusy={attach.phase === "uploading"}
        attachNote={attachNote}
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    );
  } else {
    // No organization to bill: nothing can be made here, but a plan can still be drafted and priced.
    noteInBox = true;
    box = (
      <div className="studio-field flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-[var(--color-muted)]">{t.desk.noOrg}</p>
        {planToggle}
        {attachNote && <div className="w-full">{attachNote}</div>}
      </div>
    );
  }

  const dock = { "--studio-dock-offset": bottomBar ? "60px" : "0px" } as CSSProperties;

  return (
    <div ref={homeRef} className="sh" style={dock} data-testid="studio-home">
      <div className="sh-head">
        <h1 className="sh-title">{th.title}</h1>
        <p className="sh-lead">{th.lead}</p>
      </div>

      {/* The start box: Nightshift AI, the edit desk, a channel video, or this page's own box below (filled, never sent). */}
      {start && <StartBox agentOpen={start.agentOpen} channel={start.channel} fillHere={fillWords} />}

      {/* Not one picture, clip or voice tool on sale: said once, plainly, with the way to what works today. */}
      <NothingOnSaleNote />

      <div role="radiogroup" aria-label={th.modesLabel} className="sh-modes" data-testid="studio-modes">
        {STUDIO_MODES.map((m, i) => {
          const Icon = DESK_ICONS[m];
          const on = mode === m;
          const busy = m !== "youtube" ? (working[m] ?? 0) : 0;
          // Nothing on sale for this kind (lib/tool-availability.ts): said on the chip, and the chip does nothing.
          const closed = !modeOpen(tools, m);
          return (
            <button
              key={m}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              aria-disabled={closed && !on ? true : undefined}
              tabIndex={on ? 0 : -1}
              onClick={() => {
                if (!closed || on) switchMode(m);
              }}
              onKeyDown={(e) => onChipKey(e, i)}
              className={closed ? "sh-mode av-closed" : "sh-mode"}
              data-mode={m}
              data-unavailable={closed ? "true" : undefined}
            >
              <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
              <span>{th.modes[m]}</span>
              {closed && <span className="av-tag">· {t.availability.notYet}</span>}
              {busy > 0 && (
                <span className="sh-mode-live" title={fmt(t.desk.workingNow, { n: busy })}>
                  <span aria-hidden className="ns-lamp" data-tone="run" data-live="true" />
                  <span className="sr-only">{fmt(t.desk.workingNow, { n: busy })}</span>
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* The box's own tool row (Describe, Relight…) cannot say it; this line names the tools of this kind with nothing on sale. */}
      {desk && !nothingOnSale(tools) && <DeskAvailabilityNote desk={desk} />}

      {/* id="prompt": the target of "Skip to the prompt" (components/shell/SkipLink). */}
      <div ref={composerRef} id="prompt" className="sh-composer scroll-mt-24" data-sticky="mobile" data-testid="studio-composer" aria-label={th.composerLabel} role="group">
        {planner}
        {box}
        {/* Only where the box is not the composer panel (the YouTube video, the Plan): there is no panel to put it in. */}
        {!noteInBox && attachNote}
        {/* One live region for the attachment, outside the box so it is not remounted with it: only its words change. */}
        <p className="sr-only" aria-live="polite" data-testid="composer-attach-live">
          {attachLive}
        </p>
      </div>

      <section ref={examplesRef} className="sh-section" aria-labelledby="sh-examples-title" tabIndex={-1}>
        <div className="sh-section-head">
          <h2 id="sh-examples-title" className="sh-h2">
            {th.examples.title}
          </h2>
          <p className="sh-section-lead">{th.examples.lead}</p>
        </div>
        <ul className="sh-examples" aria-label={th.examples.listLabel}>
          {/* An example for a tool with nothing on sale would fill a box that cannot be sent: not offered. */}
          {CREATIVE_EXAMPLES.filter((e) => !e.capability || toolOpen(tools, e.capability)).map((e) => (
            <li key={e.id}>
              <ExampleCard example={e} onUse={() => pickExample(e)} />
            </li>
          ))}
        </ul>
      </section>

      <div className="sh-section">
        {orgId ? (
          <JobFeed
            orgId={orgId}
            models={models}
            refreshKey={refreshKey}
            limit={12}
            onLoaded={onJobs}
            title={th.recent.title}
            emptyTitle={th.recent.emptyTitle}
            emptyBody={th.recent.emptyBody}
            emptyAction={
              <button
                type="button"
                className="sc-pill tap press mt-1"
                onClick={() => {
                  examplesRef.current?.scrollIntoView?.({ behavior: scrollBehavior(), block: "start" });
                  examplesRef.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
                }}
              >
                <LayoutTemplate aria-hidden className="size-4" strokeWidth={1.75} />
                {th.recent.emptyAction}
              </button>
            }
            headerAction={
              <Link href={path("/library")} className="tap-link inline-flex items-center gap-1 text-xs text-[var(--color-primary)] underline">
                <FolderOpen aria-hidden className="size-3.5" />
                {th.recent.all}
              </Link>
            }
            onRetry={(p) => fill(p)}
            onUseAsSource={useAsSource}
            onDescribe={describe}
            onMakeSimilar={(p) => fill(p)}
            onAnimate={animate}
            onEnhance={enhance}
            download
          />
        ) : null}
      </div>

      <section className="sh-section sh-advanced" aria-labelledby="sh-advanced-title">
        <div className="sh-section-head">
          <h2 id="sh-advanced-title" className="sh-h2">
            {th.advanced.title}
          </h2>
          <p className="sh-section-lead">{th.advanced.lead}</p>
        </div>
        <ul className="sh-pages">
          {STUDIO_MODES.map((m) => {
            const Icon = DESK_ICONS[m];
            if (!modeOpen(tools, m)) {
              return (
                <li key={m}>
                  <span className="sh-page av-closed" data-unavailable="true">
                    <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{th.advanced.pages[m]}</span>
                      <span className="av-tag truncate">{t.availability.notYet}</span>
                    </span>
                  </span>
                </li>
              );
            }
            return (
              <li key={m}>
                <Link href={path(deskHref(m))} className="sh-page">
                  <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
                  <span className="min-w-0 truncate">{th.advanced.pages[m]}</span>
                  <ArrowRight aria-hidden className="ml-auto size-3.5 shrink-0 opacity-60" />
                </Link>
              </li>
            );
          })}
          {/* Studio → Projects (NIGHTSHIFT_FILM_STUDIO, resolved per viewer by the layout): a whole video planned scene by scene. */}
          {features.filmStudio === true && (
            <li>
              <Link href={path(STUDIO_PROJECTS)} className="sh-page" data-testid="studio-home-projects">
                <Projector aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
                <span className="min-w-0 truncate">{filmStudioStrings(locale).section}</span>
                <ArrowRight aria-hidden className="ml-auto size-3.5 shrink-0 opacity-60" />
              </Link>
            </li>
          )}
          <li>
            <Link href={path("/presets")} className="sh-page">
              <LayoutTemplate aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">{th.advanced.presets}</span>
              <ArrowRight aria-hidden className="ml-auto size-3.5 shrink-0 opacity-60" />
            </Link>
          </li>
        </ul>
        <StudioSide credits={credits} projects={projects} className="sh-side" />
      </section>
    </div>
  );
}

/** The YouTube video's box: the topic only. "Continue" opens the video page, which shows the price and asks before it runs. */
function TopicComposer({
  initial,
  onDraft,
  onGo,
  extra,
  autoFocus = false,
}: {
  autoFocus?: boolean;
  initial: string;
  onDraft: (v: string) => void;
  onGo: (topic: string) => void;
  extra: ReactNode;
}) {
  const { t } = useI18n();
  const th = t.studioHome;
  const [topic, setTopic] = useState(initial.slice(0, TOPIC_MAX));
  const ready = topic.trim().length > 0;
  const go = () => {
    if (ready) onGo(topic.replace(/\s+/g, " ").trim());
  };
  return (
    <section className="studio-surface sc-composer" aria-labelledby="yt-topic-label" data-testid="topic-composer">
      <form
        className="sc-body"
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
      >
        <label id="yt-topic-label" htmlFor="yt-topic" className="sr-only">
          {th.youtube.label}
        </label>
        <textarea
          id="yt-topic"
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            onDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
            e.preventDefault();
            if (e.repeat) return;
            go();
          }}
          rows={3}
          maxLength={TOPIC_MAX}
          autoFocus={autoFocus}
          placeholder={th.youtube.placeholder}
          aria-describedby="yt-topic-note sc-enter-hint-yt"
          className="sc-input"
        />
        <div className="sc-bar">
          <div className="sc-bar-start">{extra}</div>
          <button type="submit" disabled={!ready} className="sc-plan-send press" data-testid="topic-continue">
            <ArrowUp aria-hidden className="size-4 shrink-0" strokeWidth={2.25} />
            <span>{th.youtube.send}</span>
          </button>
        </div>
        <div className="sc-foot">
          <p id="yt-topic-note" className="text-xs text-[var(--color-muted)]">
            {th.youtube.note}
          </p>
          <span id="sc-enter-hint-yt" className="sc-hint">
            {th.enterHint}
          </span>
        </div>
      </form>
    </section>
  );
}

/**
 * One example. Without a sample it is the prompt set in type over its two
 * colours (no stock picture, ever); with `mediaSrc` the sample fills the same
 * frame. Pressing it fills the box above and nothing else.
 */
function ExampleCard({ example, onUse }: { example: CreativeExample; onUse: () => void }) {
  const { t, locale, fmt } = useI18n();
  const th = t.studioHome;
  const text = examplePrompt(example, locale);
  const Icon = DESK_ICONS[example.mode];
  const isVideo = example.mediaSrc ? /\.(mp4|webm)$/i.test(example.mediaSrc) : false;
  const art = { "--ex-a": example.hues[0], "--ex-b": example.hues[1] } as CSSProperties;
  return (
    <button type="button" onClick={onUse} className="sh-ex press" aria-label={fmt(th.examples.use, { prompt: text })} data-example={example.id}>
      <span className="sh-ex-art" style={art} data-media={example.mediaSrc ? "true" : undefined}>
        {example.mediaSrc ? (
          isVideo ? (
            <video src={example.mediaSrc} muted playsInline preload="metadata" aria-hidden className="sh-ex-media" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- our own same-origin sample, sized by the card
            <img src={example.mediaSrc} alt="" loading="lazy" className="sh-ex-media" />
          )
        ) : (
          <span aria-hidden className="sh-ex-quote">
            {text}
          </span>
        )}
      </span>
      <span className="sh-ex-meta">
        <Icon aria-hidden className="size-3.5 shrink-0" strokeWidth={1.75} />
        <span className="min-w-0 truncate">{th.modes[example.mode]}</span>
      </span>
      {example.mediaSrc && <span className="sh-ex-text">{text}</span>}
    </button>
  );
}
