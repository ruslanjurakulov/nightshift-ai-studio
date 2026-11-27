"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Clapperboard, Image as ImageIcon, Loader2, AudioLines, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { creditUnit, formatCredits } from "@/lib/credits";
import { GeneratePanel, type PanelQuote } from "@/components/studio/GeneratePanel";
import { JobFeed } from "@/components/studio/JobFeed";
import { useToast } from "@/components/feedback/ToastProvider";
import { DeskAvailabilityNote } from "@/components/studio/Availability";
import { isActiveStatus, isUnsuccessful, kindLabel, type StudioJob, type StudioModel, type StudioPrefill } from "@/lib/creative/studio";
import type { UpsellCatalog } from "@/lib/upsell";
import type { StudioDna } from "@/lib/channel-dna";
import { DESK_TOOLS } from "@/lib/creative/desks";
import {
  CREATE_KINDS,
  KIND_DESK,
  KIND_TOOL,
  alternativeModels,
  parseTemplateOne,
  templateModel,
  templatePrefill,
  type CreateKind,
  type TrendTemplate,
} from "@/lib/customer/create";
import { Director } from "@/components/customer/Director";
import { IDEA_PARAM, takeIdea } from "@/lib/site/idea-handoff";
import { attachWords } from "@/lib/creative/attach";
import { StudioExplore } from "@/components/studio/StudioExplore";
import type { ExploreSample, OnSale } from "@/lib/creative/explore";
import "@/components/studio/desk.css";
import "@/components/customer/customer.css";

/** To the composer, without the smooth scroll under reduced motion. */
function toComposer(el: HTMLElement | null) {
  const still = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el?.scrollIntoView?.({ behavior: still ? "auto" : "smooth", block: "start" });
}

const KIND_ICON = { video: Clapperboard, image: ImageIcon, audio: AudioLines } as const;

type TemplateState =
  | { state: "none" }
  | { state: "loading" }
  | { state: "ready"; tpl: TrendTemplate }
  // It arrived after the person had started typing: their words are not replaced; the banner offers to fill from it.
  | { state: "waiting"; tpl: TrendTemplate; model: string }
  | { state: "model_unavailable"; tpl: TrendTemplate; reason: "not_offered" | "locked" | "switched_off" }
  | { state: "missing" }
  | { state: "not_yet" }
  | { state: "failed" };

/**
 * The customer's Create screen (Krea/Higgsfield-style): the kind tabs, the prompt with its chips (model cards, format,
 * length, quality, the reference "+"), a live price pill, the Director, and the results grid.
 *
 * Everything that prices or spends is the existing composer (components/studio/GeneratePanel): it asks the server's
 * quote (debounced, an obsolete answer aborted), its key reads "Create · N credits" only at a price the server
 * returned, and one press is one paid job with its own idempotency key and `max_credits` at that price. This screen
 * adds nothing that spends: the pill only repeats the composer's quote, the Director only adds words, and a template
 * link only fills the form (it never presses Create). The results are re-read from the jobs (JobFeed), so a refresh
 * mid-job shows the same progress.
 */
export function CreateScreen({
  orgId,
  models,
  unavailable = [],
  plans = null,
  dna = null,
  defaultStyleKitId = null,
  initialKind = "video",
  initialPrompt = "",
  templateSlug = null,
  bottomBar = true,
  idea = false,
  explore = null,
}: {
  orgId: string;
  models: StudioModel[];
  unavailable?: readonly string[];
  plans?: UpsellCatalog | null;
  dna?: (StudioDna & { href: string }) | null;
  defaultStyleKitId?: string | null;
  initialKind?: CreateKind;
  initialPrompt?: string;
  /** `?template=<slug>`, shape-checked by the page. */
  templateSlug?: string | null;
  bottomBar?: boolean;
  /** `?idea=1`: the landing's idea box or the app's start box kept the words in this browser (lib/site/idea-handoff.ts). */
  idea?: boolean;
  /** Below the fold: the samples on sale here (built on the server, no model names) and the catalogue the formats are kept to; null = none. */
  explore?: { samples: ExploreSample[]; onSale: OnSale } | null;
}) {
  const { t, fmt } = useI18n();
  const c = t.customerApp.create;
  const toast = useToast();
  const path = useChannelPath();
  const [kind, setKind] = useState<CreateKind>(initialKind);
  const [prefill, setPrefill] = useState<{ nonce: number; value: StudioPrefill | null }>(() => ({
    nonce: 0,
    // A typed idea brings only its words: the shape starts where the channel DNA says, as a fresh form does.
    value: initialPrompt
      ? { capability: KIND_TOOL[initialKind], model: "", prompt: initialPrompt, aspect: dna?.aspect ?? "16:9", duration: 5 }
      : null,
  }));
  const [sourceRequest, setSourceRequest] = useState<{ nonce: number; id: string } | null>(null);
  const [appendRequest, setAppendRequest] = useState<{ nonce: number; text: string } | null>(null);
  const [quote, setQuote] = useState<PanelQuote | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [tpl, setTpl] = useState<TemplateState>(templateSlug ? { state: "loading" } : { state: "none" });
  const [directorNote, setDirectorNote] = useState<string | null>(null);
  const [tplAttempt, setTplAttempt] = useState(0);
  // The words as typed, so a kind switch carries them to the new kind's form instead of throwing them away.
  const draft = useRef(initialPrompt);
  const edited = useRef(false);
  const top = useRef<HTMLDivElement>(null);
  const shape = dna?.aspect ?? "16:9";

  const fill = useCallback((value: StudioPrefill, nextKind?: CreateKind) => {
    if (nextKind) setKind(nextKind);
    draft.current = value.prompt;
    setDirectorNote(null);
    setSourceRequest(null);
    setQuote(null);
    setPrefill((p) => ({ nonce: p.nonce + 1, value }));
    toComposer(top.current);
  }, []);

  // The template deep link: read once, fill the form, never press Create. A model that is not on sale here is NOT
  // swapped for another: the banner names why and lists the models the person may choose instead.
  const modelsRef = useRef(models);
  modelsRef.current = models;
  useEffect(() => {
    if (!templateSlug) return;
    const ctl = new AbortController();
    setTpl({ state: "loading" });
    (async () => {
      try {
        const res = await fetch(`/api/templates/${encodeURIComponent(templateSlug)}`, { signal: ctl.signal, cache: "no-store" });
        const json = (res.headers.get("content-type") ?? "").includes("application/json");
        // A 404 that is not the API's own JSON is the route not being there yet (stream S3), not a missing template.
        if (res.status === 404) return setTpl(json ? { state: "missing" } : { state: "not_yet" });
        if (!res.ok || !json) return setTpl({ state: "failed" });
        const one = parseTemplateOne(await res.json());
        if (!one) return setTpl({ state: "failed" });
        const pick = templateModel(one, modelsRef.current, unavailable);
        if (pick.state === "ready" && edited.current) {
          setTpl({ state: "waiting", tpl: one, model: pick.model.id });
        } else if (pick.state === "ready") {
          setTpl({ state: "ready", tpl: one });
          fill(templatePrefill(one, pick.model.id), one.kind);
        } else {
          setKind(one.kind);
          setTpl({ state: "model_unavailable", tpl: one, reason: pick.reason });
        }
      } catch {
        if (!ctl.signal.aborted) setTpl({ state: "failed" });
      }
    })();
    return () => ctl.abort();
    // `unavailable` is the server's list for this request; reading it once with the template is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateSlug, fill, tplAttempt]);

  // The kept words, taken once (read and deleted together: a reload or another tab never fills a box with them again) and put in
  // this kind's box, not sent: nothing is quoted or created until the person presses Create and sees the price (rule 3). The
  // address loses `idea=` either way. Nothing kept (expired, another browser, storage off) is an empty box, never an error.
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
    const tool = KIND_TOOL[initialKind];
    const words = takeIdea();
    const prompt = words ? attachWords(tool, words) : "";
    if (prompt) fill({ capability: tool, model: "", prompt, aspect: shape, duration: 5 }, initialKind);
    // Once, on load.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const switchKind = (k: CreateKind) => {
    if (k === kind) return;
    setKind(k);
    setQuote(null);
    setSourceRequest(null);
    setDirectorNote(null);
    // A template filled the old kind's form; after a switch its banner would describe a form that is no longer there.
    if (tpl.state === "ready") setTpl({ state: "none" });
    const words = draft.current.trim();
    setPrefill((p) => ({
      nonce: p.nonce + 1,
      value: words ? { capability: KIND_TOOL[k], model: "", prompt: words, aspect: shape, duration: 5 } : null,
    }));
  };

  const i2vOnSale = useMemo(() => models.some((m) => m.capabilities.includes("i2v") && !m.lock && !unavailable.includes(m.id)), [models, unavailable]);

  // "Turn into video": a fresh Video form on its i2v tool with the picture as its source, carried in the form's own start
  // (a source request would be skipped by the remounted form). The press there is priced as any other.
  const animate = (assetId: string) =>
    fill({ capability: "i2v", model: "", prompt: "", aspect: shape, duration: 5, sourceId: assetId }, "video");
  const useAsSource = (assetId: string) => {
    setSourceRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, id: assetId }));
    toComposer(top.current);
  };

  // Toasts when a job this tab saw working ends. The first read only learns what is working (a page opened on finished
  // jobs announces nothing), and each job is announced once.
  const working = useRef<Set<string> | null>(null);
  const onLoaded = useCallback(
    (jobs: StudioJob[]) => {
      const now = new Set(jobs.filter((j) => isActiveStatus(j.status)).map((j) => j.id));
      const before = working.current;
      working.current = now;
      if (!before) return;
      for (const j of jobs) {
        if (!before.has(j.id) || now.has(j.id)) continue;
        // creative_jobs end as completed | failed | cancelled | expired (0036); only an unsuccessful end returned its hold.
        if (j.status === "completed") toast.success(fmt(c.done, { what: kindLabel(t, j.capability) }));
        else if (isUnsuccessful(j.status)) toast.error(c.failed);
      }
    },
    [toast, fmt, c.done, c.failed, t],
  );

  const desk = KIND_DESK[kind];
  const tools = DESK_TOOLS[desk];
  const dock = { "--studio-dock-offset": bottomBar ? "60px" : "0px" } as CSSProperties;

  return (
    <div className="cs-screen" data-testid="create-screen">
      <header className="cs-head">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="cs-title">{c.title}</h1>
          <p className="m-0 text-sm text-[var(--color-muted)]">{c.lead}</p>
          {/* The channel's autopilot run (topic → script → voice → render, held private for review) keeps its own desk. */}
          <Link href={path("/create?desk=youtube")} className="tap-link self-start text-sm text-[var(--color-primary)]">
            {c.youtube} →
          </Link>
        </div>
        <PricePill quote={quote} />
      </header>

      <div role="tablist" aria-label={t.customerApp.kinds.label} className="cs-tabs">
        {CREATE_KINDS.map((k) => {
          const Icon = KIND_ICON[k];
          return (
            <button
              key={k}
              type="button"
              role="tab"
              id={`cs-tab-${k}`}
              aria-selected={k === kind}
              aria-controls="cs-panel"
              tabIndex={k === kind ? 0 : -1}
              onClick={() => switchKind(k)}
              onKeyDown={(e) => {
                const i = CREATE_KINDS.indexOf(kind);
                const last = CREATE_KINDS.length - 1;
                const at = e.key === "ArrowRight" ? (i + 1) % CREATE_KINDS.length : e.key === "ArrowLeft" ? (i + last) % CREATE_KINDS.length : e.key === "Home" ? 0 : e.key === "End" ? last : -1;
                if (at < 0) return;
                e.preventDefault();
                const next = CREATE_KINDS[at];
                switchKind(next);
                document.getElementById(`cs-tab-${next}`)?.focus();
              }}
              className="cs-tab"
              data-kind={k}
            >
              <Icon aria-hidden className="size-4" strokeWidth={2} />
              {t.customerApp.kinds[k]}
            </button>
          );
        })}
      </div>

      <TemplateBanner
        state={tpl}
        models={models}
        unavailable={unavailable}
        onPick={(m) => {
          if (tpl.state !== "model_unavailable") return;
          setTpl({ state: "ready", tpl: tpl.tpl });
          fill(templatePrefill(tpl.tpl, m.id), tpl.tpl.kind);
        }}
        onDismiss={() => setTpl({ state: "none" })}
        onRetry={() => setTplAttempt((a) => a + 1)}
        onApply={() => {
          if (tpl.state !== "waiting") return;
          setTpl({ state: "ready", tpl: tpl.tpl });
          fill(templatePrefill(tpl.tpl, tpl.model), tpl.tpl.kind);
        }}
      />

      <div id="cs-panel" role="tabpanel" aria-labelledby={`cs-tab-${kind}`} className="flex flex-col gap-4">
        <DeskAvailabilityNote desk={desk} />
        <div className="cs-layout" style={dock}>
          <div ref={top} id="prompt" className="cs-composer scroll-mt-7" data-testid="gen-composer">
            <GeneratePanel
              key={`${kind}:${prefill.nonce}`}
              orgId={orgId}
              models={models}
              initial={prefill.value}
              defaultStyleKitId={defaultStyleKitId}
              // A retried job or a template brings its own settings: the DNA starts only the page's first form.
              dna={prefill.nonce > 0 ? null : dna}
              sourceRequest={sourceRequest}
              appendRequest={appendRequest}
              plans={plans}
              desk={desk}
              unavailable={unavailable}
              onQuote={setQuote}
              onDraftChange={(w) => (draft.current = w)}
              onEdit={() => (edited.current = true)}
              onAppended={(ok) => setDirectorNote(ok ? c.director.added : c.director.tooLong)}
              onePerQuote
              verb={{ word: c.createWord, priced: c.createPriced }}
              onCreated={() => setRefreshKey((k) => k + 1)}
            />
            <Director
              kind={kind}
              note={directorNote}
              onApply={(text) => {
                setDirectorNote(null);
                setAppendRequest((r) => ({ nonce: (r?.nonce ?? 0) + 1, text }));
              }}
            />
          </div>
          <div className="cs-results flex min-w-0 flex-col gap-6" data-testid="gen-canvas">
            <JobFeed
              orgId={orgId}
              models={models}
              refreshKey={refreshKey}
              capabilities={tools}
              variant="sheet"
              title={c.results}
              emptyTitle={c.resultsEmptyTitle}
              emptyBody={c.resultsEmptyBody}
              onRetry={(p) => fill(p)}
              onUseAsSource={tools.some((x) => x === "edit" || x === "i2v") ? useAsSource : undefined}
              onAnimate={i2vOnSale ? animate : undefined}
              onLoaded={onLoaded}
              download
            />
          </div>
        </div>
      </div>

      {/* Below the fold, after the composer and the results: samples and ready-made formats, media first; a card only opens this
          channel's Studio form (components/studio/StudioExplore.tsx). */}
      {explore && <StudioExplore samples={explore.samples} onSale={explore.onSale} />}
    </div>
  );
}

/** The live price: only ever the composer's last server quote. No quote is "Price unknown", never a guessed number. */
function PricePill({ quote }: { quote: PanelQuote | null }) {
  const { t, fmt, locale } = useI18n();
  const c = t.customerApp.create;
  let text = c.priceUnknown;
  let tone: "unknown" | "ready" | "short" = "unknown";
  let hint: string | null = c.priceUnknownHint;
  if (quote?.state === "ready" || quote?.state === "short") {
    tone = quote.state;
    text = fmt(quote.state === "ready" ? c.pricePill : c.priceShort, {
      n: formatCredits(quote.credits, locale),
      unit: creditUnit(quote.credits, locale, t.shell.creditUnit),
    });
    // Short: the composer's key already opens the top-ups; the pill says what that key will do.
    hint = quote.state === "short" ? c.priceShortHint : null;
  } else if (quote?.state === "blocked") {
    hint = quote.why;
  }
  return (
    <div className="cs-price" data-tone={tone} data-testid="create-price">
      <span className="text-xs text-[var(--color-muted)]">{c.price}</span>
      <span className="cs-price-value tnum">
        {tone === "ready" && <Sparkles aria-hidden className="size-3.5" strokeWidth={2.25} />}
        {text}
      </span>
      {hint && <span className="cs-price-hint">{hint}</span>}
    </div>
  );
}

function TemplateBanner({
  state,
  models,
  unavailable,
  onPick,
  onDismiss,
  onRetry,
  onApply,
}: {
  state: TemplateState;
  models: StudioModel[];
  unavailable: readonly string[];
  onPick: (m: StudioModel) => void;
  onDismiss: () => void;
  onRetry: () => void;
  onApply: () => void;
}) {
  const { t, fmt } = useI18n();
  const c = t.customerApp.create.template;
  if (state.state === "none") return null;
  if (state.state === "loading")
    return (
      <p role="status" className="cs-banner" data-tone="info">
        <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> {c.loading}
      </p>
    );
  const close = (
    <button type="button" onClick={onDismiss} className="cs-banner-x" aria-label={c.dismiss} title={c.dismiss}>
      <X aria-hidden className="size-4" />
    </button>
  );
  if (state.state === "ready")
    return (
      <div role="status" className="cs-banner" data-tone="ok" data-testid="template-ready">
        <span className="flex flex-1 flex-col gap-1">
          <span>{fmt(c.ready, { title: state.tpl.title })}</span>
          {state.tpl.placeholders.length > 0 && (
            <span className="text-xs text-[var(--color-muted)]">
              {fmt(c.placeholders, { names: state.tpl.placeholders.map((p) => `{${p}}`).join(", ") })}
            </span>
          )}
        </span>
        {close}
      </div>
    );
  if (state.state === "waiting")
    return (
      <div role="status" className="cs-banner" data-tone="info" data-testid="template-waiting">
        <span className="flex-1">{fmt(c.waiting, { title: state.tpl.title })}</span>
        <button type="button" onClick={onApply} className="btn-sky is-quiet pill h-10 shrink-0 px-3.5 text-sm">
          {c.apply}
        </button>
        {close}
      </div>
    );
  if (state.state === "model_unavailable") {
    const alts = alternativeModels(state.tpl.kind, models, unavailable);
    return (
      <div role="alert" className="cs-banner" data-tone="warn" data-testid="template-model-unavailable">
        <div className="flex flex-1 flex-col gap-2">
          <span>{fmt(c.modelGone, { reason: c.reasons[state.reason] })}</span>
          {alts.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-[var(--color-muted)]">{c.alternatives}</span>
              <div className="flex flex-wrap gap-2">
                {alts.slice(0, 6).map((m) => (
                  <button key={m.id} type="button" className="btn-sky is-quiet pill h-10 px-3.5 text-sm" onClick={() => onPick(m)}>
                    {fmt(c.use, { name: m.displayName })}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <span className="text-xs text-[var(--color-muted)]">{c.noAlternative}</span>
          )}
        </div>
        {close}
      </div>
    );
  }
  const text = state.state === "missing" ? c.missing : state.state === "not_yet" ? c.notYet : c.failed;
  return (
    <div role="alert" className="cs-banner" data-tone="warn" data-testid={`template-${state.state}`}>
      <span className="flex-1">{text}</span>
      {state.state === "failed" && (
        <button type="button" onClick={onRetry} className="btn-sky is-quiet pill h-10 shrink-0 px-3.5 text-sm">
          {t.customerApp.home.retry}
        </button>
      )}
      {close}
    </div>
  );
}
