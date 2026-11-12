"use client";

import { useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, ArrowUp, FolderOpen, LayoutTemplate, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { StudioSide, type CreditsReading, type ProjectsReading } from "@/components/studio/Desks";
import { AssistantPlanner, type AssistantPlannerProps } from "@/components/assistant/AssistantPlanner";
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
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import "@/components/studio/desk.css";
import "@/components/studio/studio-home.css";

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
}) {
  const { t, locale, fmt } = useI18n();
  const th = t.studioHome;
  const path = useChannelPath();
  const router = useRouter();
  const [mode, setMode] = useState<StudioMode>(initial && isStudioCapability(initial.capability) ? deskFor(initial.capability) : "image");
  const [planning, setPlanning] = useState(false);
  // The words typed, carried across modes and into the Plan.
  const [draft, setDraft] = useState(initial?.prompt ?? "");
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill | null }>({ nonce: 0, value: initial });
  const [topicNonce, setTopicNonce] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [working, setWorking] = useState<Partial<Record<MediaDesk, number>>>({});
  const composerRef = useRef<HTMLDivElement>(null);
  const examplesRef = useRef<HTMLElement>(null);
  const chipRefs = useRef<Array<HTMLButtonElement | null>>([]);

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

  /** A fresh box with these settings (a new mount: nothing typed before leaks into it). */
  const fill = (value: StudioPrefill | null, nextMode?: StudioMode) => {
    setPlanning(false);
    if (nextMode) setMode(nextMode);
    else if (value && isStudioCapability(value.capability)) setMode(deskFor(value.capability));
    setPrefill((p) => ({ nonce: p.nonce + 1, value }));
    if (value) setDraft(value.prompt);
    toComposer();
  };

  /** A fresh box for mode `m`, with the words typed so far where its first tool takes words (Enhance starts from a file). */
  const openMode = (m: StudioMode) => {
    setMode(m);
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
    } else setPlanning(true);
  };

  const pickExample = (e: CreativeExample) => {
    const text = examplePrompt(e, locale);
    if (e.mode === "youtube" || !e.capability) {
      setPlanning(false);
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

  const onJobs = (jobs: StudioJob[]) => {
    const n: Partial<Record<MediaDesk, number>> = {};
    for (const j of jobs) {
      if (!isActiveStatus(j.status) || !isStudioCapability(j.capability)) continue;
      const d = deskFor(j.capability);
      n[d] = (n[d] ?? 0) + 1;
    }
    setWorking(n);
  };

  // The chips are one radio group: ←/→ move and choose, Home/End jump, one tab stop.
  function onChipKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    const n = STUDIO_MODES.length;
    let to = -1;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") to = (i + 1) % n;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") to = (i - 1 + n) % n;
    else if (e.key === "Home") to = 0;
    else if (e.key === "End") to = n - 1;
    if (to < 0) return;
    e.preventDefault();
    switchMode(STUDIO_MODES[to]);
    chipRefs.current[to]?.focus();
  }

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
      <Sparkles aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="sc-pill-label">{th.plan.toggle}</span>
    </button>
  ) : null;

  const desk: MediaDesk | null = mode === "youtube" ? null : mode;
  let box: ReactNode;
  if (planning && assistant) {
    box = <AssistantPlanner {...assistant} variant="composer" initialGoal={draft} onGoalChange={setDraft} composerExtra={planToggle} />;
  } else if (mode === "youtube") {
    box = (
      <TopicComposer
        key={topicNonce}
        initial={draft}
        onDraft={setDraft}
        extra={planToggle}
        onGo={(topic) => router.push(path(`/create?desk=youtube&topic=${encodeURIComponent(topic)}`))}
      />
    );
  } else if (orgId && desk) {
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
        composerExtra={planToggle}
        onCreated={() => setRefreshKey((k) => k + 1)}
      />
    );
  } else {
    // No organization to bill: nothing can be made here, but a plan can still be drafted and priced.
    box = (
      <div className="studio-field flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="text-sm text-[var(--color-muted)]">{t.desk.noOrg}</p>
        {planToggle}
      </div>
    );
  }

  const dock = { "--studio-dock-offset": bottomBar ? "60px" : "0px" } as CSSProperties;

  return (
    <div className="sh" style={dock} data-testid="studio-home">
      <div className="sh-head">
        <h1 className="sh-title">{th.title}</h1>
        <p className="sh-lead">{th.lead}</p>
      </div>

      <div role="radiogroup" aria-label={th.modesLabel} className="sh-modes" data-testid="studio-modes">
        {STUDIO_MODES.map((m, i) => {
          const Icon = DESK_ICONS[m];
          const on = mode === m;
          const busy = m !== "youtube" ? (working[m] ?? 0) : 0;
          return (
            <button
              key={m}
              ref={(el) => {
                chipRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={on}
              tabIndex={on ? 0 : -1}
              onClick={() => switchMode(m)}
              onKeyDown={(e) => onChipKey(e, i)}
              className="sh-mode"
              data-mode={m}
            >
              <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.75} />
              <span>{th.modes[m]}</span>
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

      <div ref={composerRef} className="sh-composer scroll-mt-24" data-sticky="mobile" data-testid="studio-composer" aria-label={th.composerLabel} role="group">
        {box}
      </div>

      <section ref={examplesRef} className="sh-section" aria-labelledby="sh-examples-title" tabIndex={-1}>
        <div className="sh-section-head">
          <h2 id="sh-examples-title" className="sh-h2">
            {th.examples.title}
          </h2>
          <p className="sh-section-lead">{th.examples.lead}</p>
        </div>
        <ul className="sh-examples" aria-label={th.examples.listLabel}>
          {CREATIVE_EXAMPLES.map((e) => (
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
}: {
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
            go();
          }}
          rows={3}
          maxLength={TOPIC_MAX}
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
