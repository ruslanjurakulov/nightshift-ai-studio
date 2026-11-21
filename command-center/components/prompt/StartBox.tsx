"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { AudioLines, Clapperboard, Image as ImageIcon, Sparkles, Tv, Wand2 } from "lucide-react";
import { PromptBox } from "@/components/prompt/PromptBox";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useTemplates } from "@/components/trends/useTemplates";
import { ideaWords, stashIdea } from "@/lib/site/idea-handoff";
import { TOPIC_MAX, defaultLanguage } from "@/lib/home";
import { CREATE_KINDS, type CreateKind } from "@/lib/customer/create";
import {
  AI_READER_READY,
  START_FORMATS,
  START_TABS,
  agentUsable,
  groupTemplates,
  overLimit,
  startRoute,
  topicCut,
  wordsLimit,
  type StartAvailable,
  type StartFormat,
  type StartTab,
} from "@/lib/start-box";
import { templateCreateHref, type TemplateDto } from "@/lib/templates/trends";
import "@/components/prompt/start-box.css";

/** A verified channel a channel video can be made for (rule 7: a typed name never runs). */
export type StartChannel = { slug: string; name: string };

/**
 * Arrow keys, Home and End across a row of keys: the index to move to, or -1 for any other key (or when no other key is usable).
 * `closed(i)` keys are stepped over: a key marked "Not available yet" is not a stop on the way.
 */
export function rovingIndex(key: string, at: number, n: number, closed: (i: number) => boolean = () => false): number {
  const step = key === "ArrowRight" || key === "ArrowDown" ? 1 : key === "ArrowLeft" || key === "ArrowUp" ? -1 : 0;
  const from = key === "Home" ? -1 : key === "End" ? n : step ? at : null;
  const dir = key === "Home" ? 1 : key === "End" ? -1 : step;
  if (from === null || !dir) return -1;
  for (let k = 1; k <= n; k++) {
    const i = (((from + dir * k) % n) + n) % n;
    if (!closed(i)) return i === at && step ? -1 : i;
  }
  return -1;
}

/** With Agent off, what the words become: one of Create's kinds, or a channel video. */
type MakeChoice = CreateKind | "channel";
const MAKE_CHOICES: readonly MakeChoice[] = [...CREATE_KINDS, "channel"];
const MAKE_ICON = { video: Clapperboard, image: ImageIcon, audio: AudioLines, channel: Tv } as const;

/**
 * "The big prompt box": Home's and the Studio start's one place to begin. Two tabs (make something, or change a video with AI), an
 * Agent chip for Nightshift AI, one row of choices, and the Trends templates under it grouped by what they are for.
 *
 * The row shows only choices that change where the words go. Agent off: Video | Image | Audio (Create's own kinds, Home's old
 * choice) | Channel video. Agent on: AI film | Ad | Channel video, the format Nightshift AI's questions are shaped by. AI film and
 * Ad mean nothing to Create, so they are not drawn where they would change nothing.
 *
 * The send key is a link and nothing more (CLAUDE.md rule 3): it opens Create, the edit desk, the channel's run form or Nightshift
 * AI with the words filled in (lib/start-box.ts startRoute), and the place it opens shows the price; nothing here posts, quotes or
 * starts anything. The words ride in this browser (lib/site/idea-handoff.ts), not the address.
 *
 * The Agent chip can be switched on only when the SERVER's flag opens Nightshift AI for this workspace (`agentOpen`,
 * lib/nightshift-ai-flag.ts) AND the page it opens reads the words (lib/start-box.ts AI_READER_READY, false until PR #843 merges);
 * closed, it is drawn disabled with the reason in words, never a toggle that pretends. Open, it still starts OFF: a person turns it
 * on on purpose. The plan plays no part: a free workspace gets its trial messages and the upgrade offer inside the panel itself.
 *
 * A kind or the edit tab with nothing on sale (`available`, the read the Studio start's own chips use) says "Not available yet" and
 * does nothing; an unknown read marks nothing (rule 5).
 *
 * A full page load, not a client push: the places it opens take the kept words once, on mount, and a push to the page already
 * open (the Studio start sending to its own clip box) would not mount it again. Where the box sits on that very page, `fillHere`
 * puts the words straight into its composer instead.
 */
export function StartBox({
  agentOpen,
  aiReader = AI_READER_READY,
  available,
  channel,
  fillHere,
}: {
  /** The server's flag (lib/nightshift-ai-flag.ts aiChatOpenFor) let this workspace into Nightshift AI. */
  agentOpen: boolean;
  /** A test seam for lib/start-box.ts AI_READER_READY (the page `ai=new` opens reads the words). Pages never pass it. */
  aiReader?: boolean;
  /** Which kinds and the edit tab have something on sale (lib/start-box.ts startAvailability); null = not known. */
  available: StartAvailable;
  /** The channel a channel video is for; null = none connected and verified (the key then leads to connecting one). */
  channel: StartChannel | null;
  /** On the Studio start: fill this page's own box for the kind rather than loading the page again. */
  fillHere?: (words: string, kind: CreateKind) => void;
}) {
  const { t, locale, fmt } = useI18n();
  const s = t.startBox;
  const kinds = t.customerApp.kinds;
  const path = useChannelPath();
  const uid = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const formatRefs = useRef<(HTMLButtonElement | null)[]>([]);
  // Open only when the server's flag lets this workspace in AND the page it opens can read the words (lib/start-box AI_READER_READY).
  const agentOk = agentUsable(agentOpen, aiReader);
  // Only a known "no" closes a choice; unknown (null) is drawn usable and claims nothing (rule 5).
  const kindClosed = (k: CreateKind) => available[k] === false;
  const tabClosed = (k: StartTab) => k === "edit" && available.edit === false;
  const [tab, setTab] = useState<StartTab>("create");
  // Off until a person turns it on, even where it is open (see above). Closed, it can never be on.
  const [agentOn, setAgentOn] = useState(false);
  const [format, setFormat] = useState<StartFormat>("film");
  // The first kind with something on sale, so the box never opens on a choice the app calls "Not available yet".
  const [kind, setKind] = useState<CreateKind>(() => CREATE_KINDS.find((k) => !kindClosed(k)) ?? "video");
  const [words, setWords] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [refused, setRefused] = useState(false);

  const choice = { tab, agent: agentOn, agentOpen, aiReader, format, kind };
  const route = startRoute(choice, words, { path, channel: channel?.slug ?? null, language: defaultLanguage(locale) });
  const viaAgent = tab === "create" && agentOn && agentOk;
  const mode: "edit" | "agent" | "channel" | "connect" | "create" =
    tab === "edit" ? "edit" : viaAgent ? "agent" : route.via === "connect" ? "connect" : route.via === "topic" ? "channel" : "create";
  const cut = mode === "channel" && topicCut(words);
  const max = wordsLimit(tab);
  // Typed on the create tab, then switched to edit: the field cannot take them back, so the cut is said before the press.
  const editCut = tab === "edit" && overLimit(tab, words);
  const make: MakeChoice = format === "channel" ? "channel" : kind;

  function go() {
    if (leaving) return;
    setRefused(false);
    if (route.via !== "idea") {
      setLeaving(true);
      window.location.assign(route.href);
      return;
    }
    const kept = ideaWords(words);
    if (fillHere && mode === "create") {
      fillHere(kept, kind);
      // The words are in the composer below now; left here too, they read as a second box waiting to be sent.
      setWords("");
      return;
    }
    if (stashIdea(kept)) {
      setLeaving(true);
      window.location.assign(route.href);
    } else if (route.fallback) {
      setLeaving(true);
      window.location.assign(route.fallback);
    } else {
      // Nowhere to carry the words: said here, rather than opening a place with an empty box.
      setRefused(true);
    }
  }

  function pickMake(m: MakeChoice) {
    if (m !== "channel" && kindClosed(m)) return;
    if (m === "channel") {
      setFormat("channel");
      return;
    }
    setKind(m);
    // Leaving "Channel video" for a kind: the Agent's format starts again at its first.
    if (format === "channel") setFormat("film");
  }

  const tabs = (
    <div role="tablist" aria-label={s.tabsLabel} className="sb-tabs" data-testid="start-tabs">
      {START_TABS.map((k, i) => {
        const Icon = k === "create" ? Clapperboard : Wand2;
        const closed = tabClosed(k);
        return (
          <button
            key={k}
            ref={(el) => {
              tabRefs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${uid}-tab-${k}`}
            aria-selected={tab === k}
            aria-controls={`${uid}-panel`}
            aria-disabled={closed || undefined}
            tabIndex={tab === k ? 0 : -1}
            className="sb-tab"
            data-testid={`start-tab-${k}`}
            data-unavailable={closed ? "true" : undefined}
            onClick={() => {
              if (!closed) setTab(k);
            }}
            onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
              const to = rovingIndex(e.key, i, START_TABS.length, (j) => tabClosed(START_TABS[j]));
              if (to < 0) return;
              e.preventDefault();
              setTab(START_TABS[to]);
              tabRefs.current[to]?.focus();
            }}
          >
            <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.9} />
            {s.tabs[k]}
            {closed && <span className="sb-chip-sub">{` · ${s.notYet}`}</span>}
          </button>
        );
      })}
    </div>
  );

  const reasonId = `${uid}-agent-reason`;
  const chips =
    tab === "create" ? (
      <div className="sb-chips">
        <button
          type="button"
          className="sb-chip sb-agent"
          aria-pressed={agentOk ? agentOn : false}
          aria-disabled={agentOk ? undefined : true}
          // The chip's name is "Agent" alone; open, its hint describes it, closed, the reason line under the box does.
          aria-describedby={reasonId}
          title={agentOk ? s.agent.hint : s.agent.closed}
          data-testid="start-agent"
          data-closed={agentOk ? undefined : "true"}
          onClick={() => {
            if (agentOk) setAgentOn((v) => !v);
          }}
        >
          <Sparkles aria-hidden className="size-4 shrink-0" strokeWidth={1.9} />
          <span className="sb-chip-name">{s.agent.label}</span>
        </button>
        {agentOk && (
          <span id={reasonId} className="sr-only">
            {s.agent.hint}
          </span>
        )}
        {viaAgent ? (
          <div role="radiogroup" aria-label={s.formatLabel} className="sb-formats" data-testid="start-formats" data-group="agent">
            {START_FORMATS.map((f, i) => (
              <button
                key={f}
                ref={(el) => {
                  formatRefs.current[i] = el;
                }}
                type="button"
                role="radio"
                aria-checked={format === f}
                tabIndex={format === f ? 0 : -1}
                className="sb-chip"
                data-testid={`start-format-${f}`}
                onClick={() => setFormat(f)}
                onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                  const to = rovingIndex(e.key, i, START_FORMATS.length);
                  if (to < 0) return;
                  e.preventDefault();
                  setFormat(START_FORMATS[to]);
                  formatRefs.current[to]?.focus();
                }}
              >
                {s.formats[f]}
              </button>
            ))}
          </div>
        ) : (
          <div role="radiogroup" aria-label={kinds.label} className="sb-formats" data-testid="start-formats" data-group="make">
            {MAKE_CHOICES.map((m, i) => {
              const Icon = MAKE_ICON[m];
              const closed = m !== "channel" && kindClosed(m);
              return (
                <button
                  key={m}
                  ref={(el) => {
                    formatRefs.current[i] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={make === m}
                  aria-disabled={closed || undefined}
                  tabIndex={make === m ? 0 : -1}
                  className="sb-chip"
                  data-testid={m === "channel" ? "start-format-channel" : `start-kind-${m}`}
                  data-unavailable={closed ? "true" : undefined}
                  onClick={() => pickMake(m)}
                  onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                    const to = rovingIndex(e.key, i, MAKE_CHOICES.length, (j) => {
                      const c = MAKE_CHOICES[j];
                      return c !== "channel" && kindClosed(c);
                    });
                    if (to < 0) return;
                    e.preventDefault();
                    pickMake(MAKE_CHOICES[to]);
                    formatRefs.current[to]?.focus();
                  }}
                >
                  <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.9} />
                  {closed ? (
                    // Stacked, so the reason costs no row width: inline, "Audio · Not available yet" pushed the key off the chip
                    // row at 1440 in ru and uz. The dot is for the accessible name only.
                    <span className="sb-chip-stack">
                      <span>{kinds[m as CreateKind]}</span>
                      <span className="sb-chip-sub">
                        <span className="sr-only"> · </span>
                        {s.notYet}
                      </span>
                    </span>
                  ) : m === "channel" ? (
                    s.formats.channel
                  ) : (
                    kinds[m]
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    ) : (
      // The edit tab takes no format and no agent: its words go to the edit desk. An empty row keeps the key on the right.
      <div className="sb-chips" />
    );

  const placeholder =
    mode === "edit"
      ? s.placeholder.edit
      : mode === "connect"
        ? s.placeholder.connect
        : format === "channel"
          ? s.placeholder.channel
          : mode === "agent"
            ? s.placeholder[format]
            : s.placeholder[kind];
  const submit =
    mode === "edit" ? s.submit.edit : mode === "agent" ? s.submit.agent : mode === "connect" ? s.submit.connect : mode === "channel" ? s.submit.channel : s.submit.create;
  const note =
    mode === "channel" && channel
      ? fmt(s.note.channel, { channel: channel.name })
      : mode === "connect"
        ? s.note.connect
        : mode === "create" && fillHere
          ? s.note.here
          : s.note[mode === "channel" ? "create" : mode];

  const after = (
    <>
      {tab === "create" && !agentOk && (
        <p id={reasonId} className="sb-line" data-testid="start-agent-reason">
          {s.agent.label}: {s.agent.closed}
        </p>
      )}
      {cut && (
        <p className="sb-line" role="status" data-testid="start-topic-cut">
          {fmt(s.topicCut, { max: TOPIC_MAX })}
        </p>
      )}
      {editCut && (
        <p className="sb-line" role="status" data-testid="start-edit-cut">
          {fmt(s.editCut, { max })}
        </p>
      )}
      {refused && (
        <p className="sb-line sb-problem" role="alert" data-testid="start-refused">
          {s.storageRefused}
        </p>
      )}
    </>
  );

  return (
    <div className="sb-wrap" data-testid="start">
      <PromptBox
        value={words}
        onChange={(v) => {
          setWords(v);
          if (refused) setRefused(false);
        }}
        onSubmit={go}
        copy={{ label: s.label[tab], placeholder, submit, note, empty: s.empty, count: s.count }}
        max={max}
        busy={leaving}
        onBack={() => setLeaving(false)}
        allowEmpty={mode === "connect"}
        rows={3}
        liveAtLimit
        cls="sb"
        testId="start"
        header={tabs}
        chips={chips}
        after={after}
        fieldProps={{ id: `${uid}-field` }}
        rowProps={{ id: `${uid}-panel`, role: "tabpanel", "aria-labelledby": `${uid}-tab-${tab}` }}
      />
      <TemplateLibrary />
    </div>
  );
}

/**
 * The Trends templates (GET /api/templates, migration 0183) under the box, grouped by purpose (lib/start-box.ts). A read only.
 * A card is a link to the template's own Create address (templateCreateHref, as the Trends gallery's TrendCard): that page reads
 * the template and fills its form with the model, shape, length and quality and shows the {placeholders}. Pasting the prompt into
 * this box instead lost all four. A model measured as not on sale offers no link (rule 4: no other model is named in its place),
 * and an unknown availability says so and keeps the link: Create decides. Loading, failed, not switched on and empty each say so;
 * none of them reads as "0".
 */
function TemplateLibrary() {
  const { t, locale, fmt } = useI18n();
  const s = t.startBox.library;
  const tt = t.trends;
  const path = useChannelPath();
  const { state, retry } = useTemplates(locale);
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);

  let body: React.ReactNode;
  if (state.phase === "loading") {
    // The status line sits outside the busy part: a screen reader holds back what is inside an aria-busy region, the "loading" too.
    body = (
      <div data-testid="start-templates-loading">
        <p className="sr-only" role="status">
          {s.loading}
        </p>
        <div aria-busy="true">
          <ul className="sb-cards" aria-hidden>
            {[0, 1, 2].map((i) => (
              <li key={i} className="sb-card sb-card-skel" />
            ))}
          </ul>
        </div>
      </div>
    );
  } else if (state.phase === "error") {
    body = (
      <div className="sb-state" role="alert" data-testid="start-templates-error">
        <p>{s.error}</p>
        <button
          type="button"
          className="sb-chip"
          onClick={() => {
            retry();
            // The key goes away with the error it answers; focus would fall to the page's top. The section's title keeps the place.
            titleRef.current?.focus();
          }}
          data-testid="start-templates-retry"
        >
          {s.retry}
        </button>
      </div>
    );
  } else if (state.phase === "not_enabled") {
    body = <p className="sb-state" data-testid="start-templates-off">{s.notEnabled}</p>;
  } else if (state.phase === "signed_out") {
    body = <p className="sb-state" data-testid="start-templates-signed-out">{s.signedOut}</p>;
  } else {
    const groups = groupTemplates(state.templates);
    body =
      groups.length === 0 ? (
        <p className="sb-state" data-testid="start-templates-empty">{s.empty}</p>
      ) : (
        groups.map((g) => (
          <section key={g.purpose} className="sb-group" aria-labelledby={`${titleId}-${g.purpose}`} data-purpose={g.purpose}>
            <h3 id={`${titleId}-${g.purpose}`} className="sb-h3">
              {s.purposes[g.purpose]}
            </h3>
            <ul className="sb-cards">
              {g.templates.map((tpl) => (
                <li key={tpl.slug}>
                  {tpl.model_status === "unavailable" ? (
                    <div className="sb-card" data-template={tpl.slug} data-model-status="unavailable">
                      <CardFace tpl={tpl} kindLabel={s.kind[tpl.kind]} />
                      <span className="sb-card-note" data-tone="warn">
                        {tt.modelUnavailable}{" "}
                        <Link href={path("/models")} className="tap-link sb-link">
                          {tt.seeModels}
                        </Link>
                      </span>
                    </div>
                  ) : (
                    <Link
                      href={path(templateCreateHref(tpl.slug))}
                      className="sb-card"
                      aria-label={fmt(s.use, { title: tpl.title })}
                      data-template={tpl.slug}
                      data-model-status={tpl.model_status}
                    >
                      <CardFace tpl={tpl} kindLabel={s.kind[tpl.kind]} />
                      {tpl.model_status === "unknown" && <span className="sb-card-note">{tt.modelUnknown}</span>}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))
      );
  }

  return (
    <section className="sb-library" aria-labelledby={titleId} data-testid="start-templates">
      <div className="sb-library-head">
        <div className="min-w-0">
          <h2 id={titleId} ref={titleRef} tabIndex={-1} className="sb-h2">
            {s.title}
          </h2>
          <p className="sb-lead">{s.lead}</p>
        </div>
        <Link href={path("/trends")} className="tap-link sb-link">
          {s.all}
        </Link>
      </div>
      {body}
    </section>
  );
}

/** A card's poster and words, the same whether it links or not. */
function CardFace({ tpl, kindLabel }: { tpl: TemplateDto; kindLabel: string }) {
  const { t, fmt } = useI18n();
  const meta = [kindLabel, tpl.aspect, tpl.duration_s ? fmt(t.trends.seconds, { n: tpl.duration_s }) : null].filter(Boolean).join(" · ");
  return (
    <>
      <span className="sb-card-media" data-kind={tpl.kind} aria-hidden>
        {tpl.poster_url ? (
          // eslint-disable-next-line @next/next/no-img-element -- a static poster under /public/templates, already sized.
          <img src={tpl.poster_url} alt="" loading="lazy" decoding="async" />
        ) : tpl.kind === "video" ? (
          <Clapperboard className="size-5" strokeWidth={1.75} />
        ) : (
          <ImageIcon className="size-5" strokeWidth={1.75} />
        )}
      </span>
      <span className="sb-card-body">
        <span className="sb-card-title">{tpl.title}</span>
        <span className="sb-card-meta">{meta}</span>
      </span>
    </>
  );
}
