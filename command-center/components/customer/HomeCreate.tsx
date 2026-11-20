"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, AudioLines, Clapperboard, Flame, Image as ImageIcon, Lightbulb, Loader2, Upload } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { coerceJobs, isActiveStatus } from "@/lib/creative/studio";
import { CREATE_KINDS, createHref, parseTemplateList, type CreateKind, type TrendTemplate } from "@/lib/customer/create";
import { PROJECTS, TRENDS } from "@/lib/navigation";
import "@/components/customer/customer.css";

const KIND_ICON = { video: Clapperboard, image: ImageIcon, audio: AudioLines } as const;
const HOME_TEMPLATES = 6;

export type HomeProject = { id: string; title: string; updatedAt: string | null };
export type HomeProjectsReading = { state: "ok"; projects: HomeProject[] } | { state: "not_available" } | { state: "failed" };

type TemplatesReading =
  | { state: "loading" }
  | { state: "ok"; templates: TrendTemplate[] }
  | { state: "not_yet" }
  | { state: "failed" };

/**
 * Trend templates from stream S3's API. Shared by Home (the top six) and Trends (all). A 404 that is not the API's own
 * JSON means the route is not deployed yet: that is "coming soon", never "no templates" and never an error.
 */
export function useTrendTemplates(): { reading: TemplatesReading; retry: () => void } {
  const [reading, setReading] = useState<TemplatesReading>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setReading({ state: "loading" });
    (async () => {
      try {
        const res = await fetch("/api/templates", { signal: ctl.signal, cache: "no-store" });
        const json = (res.headers.get("content-type") ?? "").includes("application/json");
        if (res.status === 404 && !json) return setReading({ state: "not_yet" });
        if (!res.ok || !json) return setReading({ state: "failed" });
        const list = parseTemplateList(await res.json());
        setReading(list ? { state: "ok", templates: list } : { state: "failed" });
      } catch {
        if (!ctl.signal.aborted) setReading({ state: "failed" });
      }
    })();
    return () => ctl.abort();
  }, [attempt]);
  return { reading, retry: useCallback(() => setAttempt((a) => a + 1), []) };
}

/**
 * Home: "What shall we create?" — the prompt box with its kind tabs, the top trend templates, what to continue and,
 * for a new account, three ways to start. Nothing here prices or spends: Continue opens Create with the words, where
 * the server prices them and only the Create press starts a paid job.
 */
export function HomeCreate({ orgId, projects }: { orgId: string | null; projects: HomeProjectsReading }) {
  const { t } = useI18n();
  const h = t.customerApp.home;
  const router = useRouter();
  const path = useChannelPath();
  const [kind, setKind] = useState<CreateKind>("video");
  const [words, setWords] = useState("");
  const promptId = useId();
  const hintId = useId();
  const { reading, retry } = useTrendTemplates();
  const working = useWorkingCount(orgId);

  const go = () => router.push(path(createHref(kind, words)));
  const firstRun = projects.state === "ok" && projects.projects.length === 0 && working === 0;

  return (
    <div className="hc-screen" data-testid="home-create">
      <section aria-labelledby="hc-title" className="hc-hero">
        <h1 id="hc-title" className="hc-title">{h.title}</h1>
        <p className="hc-lead">{h.lead}</p>
        <form
          className="hc-box"
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <div role="tablist" aria-label={t.customerApp.kinds.label} className="cs-tabs">
            {CREATE_KINDS.map((k) => {
              const Icon = KIND_ICON[k];
              return (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  id={`hc-tab-${k}`}
                  aria-selected={k === kind}
                  aria-controls={promptId}
                  tabIndex={k === kind ? 0 : -1}
                  onClick={() => setKind(k)}
                  onKeyDown={(e) => {
                    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
                    if (!step) return;
                    e.preventDefault();
                    const next = CREATE_KINDS[(CREATE_KINDS.indexOf(kind) + step + CREATE_KINDS.length) % CREATE_KINDS.length];
                    setKind(next);
                    document.getElementById(`hc-tab-${next}`)?.focus();
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
          <label htmlFor={promptId} className="sr-only">
            {h.promptLabel}
          </label>
          <textarea
            id={promptId}
            value={words}
            maxLength={2000}
            onChange={(e) => setWords(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                go();
              }
            }}
            placeholder={h.placeholder[kind]}
            aria-describedby={hintId}
          />
          <div className="hc-box-foot">
            <span id={hintId} className="hc-hint">
              {h.submitHint}
            </span>
            <button type="submit" className="btn-sky pill inline-flex h-11 items-center gap-2 px-5 text-sm font-medium" data-testid="home-continue">
              {h.submit}
              <ArrowRight aria-hidden className="size-4" strokeWidth={2.25} />
            </button>
          </div>
        </form>
      </section>

      {firstRun && (
        <section aria-labelledby="hc-first" className="hc-section">
          <h2 id="hc-first" className="hc-h2">{h.firstTitle}</h2>
          <div className="hc-grid">
            <Tile href={path(TRENDS)} icon={<Flame aria-hidden className="size-5" />} title={h.tileTemplate} body={h.tileTemplateBody} />
            <Tile href={path(createHref(kind))} icon={<Lightbulb aria-hidden className="size-5" />} title={h.tileIdea} body={h.tileIdeaBody} />
            <Tile href={path("/library")} icon={<Upload aria-hidden className="size-5" />} title={h.tileVideo} body={h.tileVideoBody} />
          </div>
        </section>
      )}

      <section aria-labelledby="hc-trends" className="hc-section">
        <div className="hc-section-head">
          <h2 id="hc-trends" className="hc-h2">{h.trendsTitle}</h2>
          <Link href={path(TRENDS)} className="tap-link text-sm text-[var(--color-primary)]">
            {h.trendsAll}
          </Link>
        </div>
        <TemplateGrid reading={reading} retry={retry} limit={HOME_TEMPLATES} />
      </section>

      <section aria-labelledby="hc-continue" className="hc-section">
        <h2 id="hc-continue" className="hc-h2">{h.continueTitle}</h2>
        <ContinueRow projects={projects} working={working} />
      </section>
    </div>
  );
}

function Tile({ href, icon, title, body }: { href: string; icon: React.ReactNode; title: string; body: string }) {
  return (
    <Link href={href} className="hc-tile">
      <span className="hc-tile-icon">{icon}</span>
      <span className="font-medium">{title}</span>
      <span className="hc-meta">{body}</span>
    </Link>
  );
}

/** Every state of the template list: skeletons, "coming soon", an error with retry, empty, and the cards. */
export function TemplateGrid({ reading, retry, limit }: { reading: TemplatesReading; retry: () => void; limit?: number }) {
  const { t, fmt } = useI18n();
  const h = t.customerApp.home;
  const path = useChannelPath();
  if (reading.state === "loading")
    return (
      <div className="hc-grid" aria-busy="true" aria-label={h.trendsTitle}>
        {Array.from({ length: limit ?? 6 }, (_, i) => (
          <div key={i} className="hc-skeleton" />
        ))}
      </div>
    );
  if (reading.state === "not_yet")
    return (
      <div className="hc-placeholder" data-testid="templates-soon">
        <span className="font-medium text-[var(--color-fg)]">{h.trendsSoonTitle}</span>
        <span className="hc-meta">{h.trendsSoonBody}</span>
      </div>
    );
  if (reading.state === "failed")
    return (
      <div role="alert" className="hc-placeholder" data-testid="templates-failed">
        <span className="text-[var(--color-fg)]">{h.trendsFailed}</span>
        <button type="button" onClick={retry} className="btn-sky is-quiet pill h-10 self-start px-3.5 text-sm">
          {h.retry}
        </button>
      </div>
    );
  const list = limit ? reading.templates.slice(0, limit) : reading.templates;
  if (list.length === 0) return <p className="hc-meta m-0">{h.trendsEmpty}</p>;
  return (
    <ul className="hc-grid m-0 list-none p-0">
      {list.map((tpl) => (
        <li key={tpl.slug} className="flex">
          <Link href={path(createHref(tpl.kind, "", tpl.slug))} className="hc-card w-full" data-kind={tpl.kind}>
            <span aria-hidden className="hc-card-art" style={tpl.thumbnail_url ? { backgroundImage: `url("${tpl.thumbnail_url}")` } : undefined} />
            <span className="font-medium">{tpl.title}</span>
            <span className="hc-meta">
              {t.customerApp.kinds[tpl.kind]}
              {tpl.aspect ? ` · ${tpl.aspect}` : ""}
              {tpl.duration_s ? ` · ${fmt(t.customerApp.trends.durationS, { n: tpl.duration_s })}` : ""}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** How many of the workspace's generations are working now (GET /api/creative/jobs, RLS). null = unknown, never 0. */
function useWorkingCount(orgId: string | null): number | null {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    if (!orgId) return;
    const ctl = new AbortController();
    fetch(`/api/creative/jobs?org_id=${encodeURIComponent(orgId)}`, { signal: ctl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { jobs?: unknown };
        setN(coerceJobs(body.jobs).filter((j) => isActiveStatus(j.status)).length);
      })
      .catch(() => undefined);
    return () => ctl.abort();
  }, [orgId]);
  return n;
}

function ContinueRow({ projects, working }: { projects: HomeProjectsReading; working: number | null }) {
  const { t, fmt, locale } = useI18n();
  const h = t.customerApp.home;
  const path = useChannelPath();
  const when = (iso: string | null) => {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return h.updatedUnknown;
    return fmt(h.updated, { when: new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at) });
  };
  const items: React.ReactNode[] = [];
  if (working && working > 0)
    items.push(
      <Link key="working" href={path("/create")} className="hc-card" data-testid="continue-working">
        <span className="inline-flex items-center gap-2 font-medium">
          <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />
          {fmt(h.working, { n: working })}
        </span>
        <span className="hc-meta">{t.customerApp.create.title}</span>
      </Link>,
    );
  if (projects.state === "ok")
    for (const p of projects.projects.slice(0, 8))
      items.push(
        // A full load into the editor's project page: it must get its own Permissions-Policy (lib/editor-nav.ts).
        <a key={p.id} href={path(`/editor/${p.id}`)} className="hc-card">
          <span className="truncate font-medium">{p.title}</span>
          <span className="hc-meta">{when(p.updatedAt)}</span>
        </a>,
      );
  if (projects.state === "failed" && items.length === 0) return <p role="alert" className="hc-meta m-0">{h.continueFailed}</p>;
  if (items.length === 0)
    return (
      <p className="hc-meta m-0">
        {h.continueEmpty}{" "}
        <Link href={path(PROJECTS)} className="tap-link text-[var(--color-primary)]">
          {t.nav.projects}
        </Link>
      </p>
    );
  return <div className="hc-row">{items}</div>;
}
