"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useChannelPath } from "@/lib/channels-client";
import { GeneratePanel } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { TemplateGallery } from "@/components/studio/TemplateGallery";
import { useI18n } from "@/lib/i18n/context";
import { defaultDescribeLanguage, describePrefill, promptRule, wordsMax, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import { DESK_TOOLS, type MediaDesk } from "@/lib/creative/desks";
import type { FeedVariant } from "@/components/studio/JobFeed";
import { useShell } from "@/components/shell/ShellContext";
import { DeskAvailabilityNote, NothingOnSaleNote } from "@/components/studio/Availability";
import { toolOpen } from "@/lib/tool-availability";
import { IDEA_PARAM, takeIdea } from "@/lib/site/idea-handoff";
import { attachWords } from "@/lib/creative/attach";
import "@/components/studio/desk.css";

/** How each desk shows what it made (components/studio/JobFeed variants). */
const DESK_FEED: Record<MediaDesk, FeedVariant> = { video: "monitor", image: "table", enhance: "table", voice: "takes" };

/**
 * The Studio's "make one thing" half: the composer on the left (sticky from
 * `lg` up), the canvas of what it made on the right — templates as a strip
 * above the results. On a phone the composer comes first, its Generate pinned
 * above the bottom tab bar, and the results follow as a two-column grid.
 *
 * "Try again" and a template refill the composer (a fresh mount with those
 * settings); "Use as picture" hands a finished picture to it without clearing
 * the words. "Describe" on a finished picture opens the composer on Describe
 * with that picture, and "Make similar" on a description opens it on Image with
 * the text. None of them starts a generation: only the priced press does.
 */
export function GenerateSection({
  orgId,
  models,
  initial = null,
  defaultStyleKitId = null,
  dna = null,
  bottomBar = true,
  plans = null,
  desk = null,
  project = null,
  unavailable = [],
  idea = false,
}: {
  /**
   * The desk this section is (lib/creative/desks): its tools only, laid out
   * around its job — Video's monitor over a docked slate, Image's light table
   * beside the composer, Enhance's loupe with the composer on the right,
   * Voice's booth over its takes. Absent: every tool, composer then canvas.
   */
  desk?: MediaDesk | null;
  orgId: string;
  models: StudioModel[];
  /** From the Library's "Use in Studio" link; fills the form only. */
  initial?: StudioPrefill | null;
  /** The open channel's default style kit (0047), if it has one. */
  defaultStyleKitId?: string | null;
  /** The open channel's DNA (0056), for a form that starts fresh. */
  dna?: (StudioDna & { href: string }) | null;
  /** The phone's bottom tab bar is shown (not for the platform operator): Generate docks above it. */
  bottomBar?: boolean;
  /** What the plan dialog may offer when a generation is refused (lib/upsell.ts); null = no dialog. */
  plans?: UpsellCatalog | null;
  /** An editor project the person came from ("Improve with AI"): results can be added back to it, and there is a way back. */
  project?: string | null;
  /** The model ids the owner switched off for now (0124): the composer says so over a model the form came with, and picks nothing instead. */
  unavailable?: readonly string[];
  /** `?idea=1`: the start box's "AI edit" kept the words in this browser (lib/site/idea-handoff.ts); the composer takes them once. */
  idea?: boolean;
}) {
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill } | null>(
    initial ? { nonce: 0, value: initial } : null,
  );
  const [sourceRequest, setSourceRequest] = useState<{ nonce: number; id: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const { t, locale, fmt } = useI18n();
  const top = useRef<HTMLDivElement>(null);
  const path = useChannelPath();
  const { tools: availability } = useShell();

  const toComposer = () => top.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });

  const fill = (value: StudioPrefill) => {
    // A fresh composer: a picture handed in earlier must not come back with it.
    setSourceRequest(null);
    setPrefill((p) => ({ nonce: (p?.nonce ?? 0) + 1, value }));
    toComposer();
  };

  // The kept words, taken once (read and deleted together) and put in the composer's prompt, not sent: the person still chooses
  // the clip and presses the priced key (rule 3). The address loses `idea=`; nothing kept is an empty box, never an error.
  // A tool that takes no words is asked about BEFORE the words are taken: a crafted address (`tool=video_upscale&idea=1`) must not
  // quietly delete what someone kept for another page. Words longer than the tool takes are cut to its limit and said so.
  const ideaTaken = useRef(false);
  const [ideaCut, setIdeaCut] = useState<number | null>(null);
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
    const tool = initial?.capability ?? (desk ? DESK_TOOLS[desk][0] : null);
    if (!tool || promptRule(tool) === "none") return;
    const words = takeIdea();
    if (!words) return;
    const prompt = attachWords(tool, words);
    if (!prompt) return;
    if (Array.from(words.trim()).length > wordsMax(tool)) setIdeaCut(wordsMax(tool));
    fill({ ...(initial ?? { capability: tool, model: "", prompt: "", aspect: "16:9", duration: 5 }), prompt });
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickAsSource = (id: string) => {
    setSourceRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, id }));
    toComposer();
  };

  const describe = (id: string) => {
    const value = describePrefill(id, defaultDescribeLanguage(locale));
    if (value) fill(value);
  };

  const dock = { "--studio-dock-offset": bottomBar ? "60px" : "0px" } as CSSProperties;

  const panel = (
    <GeneratePanel
      key={prefill?.nonce ?? 0}
      orgId={orgId}
      models={models}
      initial={prefill?.value ?? null}
      defaultStyleKitId={defaultStyleKitId}
      // A retried job or a template brings its own settings: DNA starts only the page's own form.
      dna={prefill && prefill.nonce > 0 ? null : dna}
      sourceRequest={sourceRequest}
      plans={plans}
      desk={desk}
      unavailable={unavailable}
      onCreated={() => setRefreshKey((k) => k + 1)}
    />
  );

  const cutNote =
    ideaCut !== null ? (
      <p className="m-0 text-sm text-[var(--color-muted)]" role="status" data-testid="idea-cut">
        {fmt(t.startBox.received.cut, { max: ideaCut })}
      </p>
    ) : null;

  const fromProject = project ? (
    <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-[var(--color-muted)]" data-testid="from-project">
      <span>{t.improveAi.fromProject}</span>
      {/* A full load into the editor's project page: it must get its own Permissions-Policy (lib/editor-nav.ts). */}
      <a href={path(`/editor/${project}`)} className="tap-link text-[var(--color-primary)] underline">
        {t.improveAi.backToProject}
      </a>
    </p>
  ) : null;

  if (desk) {
    const tools = DESK_TOOLS[desk];
    const deskHas = (c: (typeof tools)[number]) => tools.includes(c);
    return (
      <div className="flex flex-col gap-4">
      {fromProject}
      {cutNote}
      {/* Which of this desk's tools have nothing on sale, said before a tab is pressed (lib/tool-availability.ts). */}
      <DeskAvailabilityNote desk={desk} />
      <div className="desk-layout" data-desk={desk} style={dock}>
        {/* id="prompt": the target of "Skip to the prompt" (components/shell/SkipLink). */}
        <div ref={top} id="prompt" className="desk-layout-composer scroll-mt-7" data-testid="gen-composer">
          {panel}
        </div>
        <div className="desk-layout-canvas flex min-w-0 flex-col gap-6" data-testid="gen-canvas">
          <JobFeed
            orgId={orgId}
            models={models}
            refreshKey={refreshKey}
            capabilities={tools}
            variant={DESK_FEED[desk]}
            title={t.desk.feedTitle[desk]}
            emptyTitle={t.desk.emptyTitle[desk]}
            emptyBody={t.desk.empty[desk]}
            onRetry={fill}
            // A picture result goes back into this desk's picture tools; Describe and
            // "Make similar" only where the desk has those tools (the Image desk).
            onUseAsSource={tools.some((c) => c === "edit" || c === "i2v" || c === "upscale" || c === "remove_bg") ? pickAsSource : undefined}
            onDescribe={deskHas("describe") ? describe : undefined}
            onMakeSimilar={deskHas("t2i") ? fill : undefined}
            project={project}
          />
          {/* Starting points come after the results: the monitor or the table is what the desk is for. */}
          {/* A starter for a tool with nothing on sale would only fill a form that cannot be sent: not offered. */}
          <TemplateGallery onPick={fill} only={tools.filter((c) => toolOpen(availability, c))} />
        </div>
      </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
    {fromProject}
    {cutNote}
    <NothingOnSaleNote />
    <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[minmax(340px,384px)_minmax(0,1fr)]" style={dock}>
      <div
        ref={top}
        id="prompt"
        className="scroll-mt-7 lg:sticky lg:top-[96px] lg:max-h-[calc(100dvh-112px)] lg:overflow-y-auto lg:rounded-[var(--ns-r-sheet)]"
        data-testid="gen-composer"
      >
        {panel}
      </div>
      <div className="flex min-w-0 flex-col gap-6" data-testid="gen-canvas">
        <TemplateGallery onPick={fill} />
        <JobFeed
          orgId={orgId}
          models={models}
          refreshKey={refreshKey}
          onRetry={fill}
          onUseAsSource={pickAsSource}
          onDescribe={describe}
          onMakeSimilar={fill}
          project={project}
        />
      </div>
    </div>
    </div>
  );
}
