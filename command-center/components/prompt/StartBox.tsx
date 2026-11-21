"use client";

import Link from "next/link";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { Clapperboard, Image as ImageIcon, Sparkles, Wand2 } from "lucide-react";
import { PromptBox } from "@/components/prompt/PromptBox";
import { useI18n } from "@/lib/i18n/context";
import { useChannelPath } from "@/lib/channels-client";
import { useTemplates } from "@/components/trends/useTemplates";
import { IDEA_MAX, ideaWords, stashIdea } from "@/lib/site/idea-handoff";
import { TOPIC_MAX, defaultLanguage } from "@/lib/home";
import { START_FORMATS, START_TABS, groupTemplates, startRoute, topicCut, type StartFormat, type StartTab } from "@/lib/start-box";
import type { TemplateDto, TemplateKind } from "@/lib/templates/trends";
import "@/components/prompt/start-box.css";

/** A verified channel a channel video can be made for (rule 7: a typed name never runs). */
export type StartChannel = { slug: string; name: string };

/** Arrow keys, Home and End across a row of keys: the index to move to, or -1 for any other key. */
function rovingIndex(key: string, at: number, n: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") return (at + 1) % n;
  if (key === "ArrowLeft" || key === "ArrowUp") return (at + n - 1) % n;
  if (key === "Home") return 0;
  if (key === "End") return n - 1;
  return -1;
}

function smooth(): ScrollBehavior {
  try {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  } catch {
    return "auto";
  }
}

/**
 * "The big prompt box": Home's and the Studio start's one place to begin. Two tabs (make a video, or change one with AI), an Agent
 * chip for Nightshift AI and a format chip, and the Trends templates under it grouped by what they are for.
 *
 * The send key is a link and nothing more (CLAUDE.md rule 3): it opens Create, the edit desk, the channel's run form or Nightshift
 * AI with the words filled in (lib/start-box.ts startRoute), and the place it opens shows the price; nothing here posts, quotes or
 * starts anything. The words ride in this browser (lib/site/idea-handoff.ts), not the address.
 *
 * The Agent chip is on only when the SERVER's flag opens Nightshift AI for this workspace (`agentOpen`, lib/nightshift-ai-flag.ts);
 * closed, it is drawn disabled with the reason in words, never a toggle that pretends. The plan plays no part: a free workspace
 * gets its trial messages and the upgrade offer inside the panel itself.
 *
 * A full page load, not a client push: the places it opens take the kept words once, on mount, and a push to the page already
 * open (the Studio start sending to its own clip box) would not mount it again. Where the box sits on that very page, `fillHere`
 * puts the words straight into its composer instead.
 */
export function StartBox({
  agentOpen,
  channel,
  fillHere,
}: {
  /** The server's flag (lib/nightshift-ai-flag.ts aiChatOpenFor) let this workspace into Nightshift AI. */
  agentOpen: boolean;
  /** The channel a channel video is for; null = none connected and verified (the key then leads to connecting one). */
  channel: StartChannel | null;
  /** On the Studio start: fill this page's own clip or picture box rather than loading the page again. */
  fillHere?: (words: string, kind: TemplateKind) => void;
}) {
  const { t, locale, fmt } = useI18n();
  const s = t.startBox;
  const path = useChannelPath();
  const uid = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const formatRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [tab, setTab] = useState<StartTab>("create");
  // On by default where it is open: that is the point of the chip. Closed, it can never be on.
  const [agentOn, setAgentOn] = useState(agentOpen);
  const [format, setFormat] = useState<StartFormat>("film");
  const [kind, setKind] = useState<TemplateKind>("video");
  const [words, setWords] = useState("");
  const [leaving, setLeaving] = useState(false);
  const [refused, setRefused] = useState(false);
  const [filled, setFilled] = useState("");

  const choice = { tab, agent: agentOn, agentOpen, format, kind };
  const route = startRoute(choice, words, { path, channel: channel?.slug ?? null, language: defaultLanguage(locale) });
  const viaAgent = tab === "create" && agentOn && agentOpen;
  const mode: "edit" | "agent" | "channel" | "connect" | "create" =
    tab === "edit" ? "edit" : viaAgent ? "agent" : route.via === "connect" ? "connect" : route.via === "topic" ? "channel" : "create";
  const cut = mode === "channel" && topicCut(words);

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

  function pick(tpl: TemplateDto) {
    setWords(tpl.prompt.slice(0, IDEA_MAX));
    setKind(tpl.kind);
    setTab("create");
    // A template is a prompt for Create's clip or picture box, not a channel topic: "Channel video" would send it to the run form.
    if (format === "channel") setFormat("film");
    setRefused(false);
    setFilled(fmt(s.library.filled, { title: tpl.title }));
    const el = field.current;
    el?.scrollIntoView?.({ behavior: smooth(), block: "center" });
    el?.focus({ preventScroll: true });
  }

  const tabs = (
    <div role="tablist" aria-label={s.tabsLabel} className="sb-tabs" data-testid="start-tabs">
      {START_TABS.map((k, i) => {
        const Icon = k === "create" ? Clapperboard : Wand2;
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
            tabIndex={tab === k ? 0 : -1}
            className="sb-tab"
            data-testid={`start-tab-${k}`}
            onClick={() => setTab(k)}
            onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
              const to = rovingIndex(e.key, i, START_TABS.length);
              if (to < 0) return;
              e.preventDefault();
              setTab(START_TABS[to]);
              tabRefs.current[to]?.focus();
            }}
          >
            <Icon aria-hidden className="size-4 shrink-0" strokeWidth={1.9} />
            {s.tabs[k]}
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
          aria-pressed={agentOpen ? agentOn : false}
          aria-disabled={agentOpen ? undefined : true}
          // Closed, the reason is part of the chip's own name already; said twice it is noise to a screen reader.
          aria-describedby={agentOpen ? reasonId : undefined}
          title={agentOpen ? s.agent.hint : s.agent.closed}
          data-testid="start-agent"
          data-closed={agentOpen ? undefined : "true"}
          onClick={() => {
            if (agentOpen) setAgentOn((v) => !v);
          }}
        >
          <Sparkles aria-hidden className="size-4 shrink-0" strokeWidth={1.9} />
          <span className="sb-chip-name">{s.agent.label}</span>
          {!agentOpen && (
            <span className="sb-chip-sub" data-testid="start-agent-reason">
              · {s.agent.closed}
            </span>
          )}
        </button>
        {agentOpen && (
          <span id={reasonId} className="sr-only">
            {s.agent.hint}
          </span>
        )}
        <div role="radiogroup" aria-label={s.formatLabel} className="sb-formats" data-testid="start-formats">
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
      </div>
    ) : (
      // The edit tab takes no format and no agent: its words go to the edit desk. An empty row keeps the key on the right.
      <div className="sb-chips" />
    );

  const placeholder =
    mode === "edit" ? s.placeholder.edit : mode === "agent" ? s.placeholder.agent : format === "channel" ? s.placeholder.channel : s.placeholder[format];
  const submit =
    mode === "edit" ? s.submit.edit : mode === "agent" ? s.submit.agent : mode === "connect" ? s.submit.connect : mode === "channel" ? s.submit.channel : s.submit.create;
  const note =
    mode === "channel" && channel
      ? fmt(s.note.channel, { channel: channel.name })
      : mode === "connect"
        ? s.note.connect
        : s.note[mode === "channel" ? "create" : mode];

  const after = (
    <>
      {cut && (
        <p className="sb-line" role="status" data-testid="start-topic-cut">
          {fmt(s.topicCut, { max: TOPIC_MAX })}
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
    <div className="sb-wrap" data-testid="start-box">
      <PromptBox
        value={words}
        onChange={(v) => {
          setWords(v);
          if (!v.trim()) setKind("video");
          if (refused) setRefused(false);
        }}
        onSubmit={go}
        copy={{ label: s.label[tab], placeholder, submit, note, empty: s.empty, count: s.count }}
        max={IDEA_MAX}
        busy={leaving}
        onBack={() => setLeaving(false)}
        allowEmpty={mode === "connect"}
        rows={3}
        cls="sb"
        testId="start"
        header={tabs}
        chips={chips}
        after={after}
        fieldRef={field}
        fieldProps={{ id: `${uid}-field` }}
        rowProps={{ id: `${uid}-panel`, role: "tabpanel", "aria-labelledby": `${uid}-tab-${tab}` }}
      />
      <p className="sr-only" aria-live="polite" data-testid="start-filled">
        {filled}
      </p>
      <TemplateLibrary onPick={pick} />
    </div>
  );
}

/**
 * The Trends templates (GET /api/templates, migration 0183) under the box, grouped by purpose (lib/start-box.ts). A read only:
 * picking one fills the box and nothing else. Loading, failed, not switched on and empty each say so; none of them reads as "0".
 */
function TemplateLibrary({ onPick }: { onPick: (t: TemplateDto) => void }) {
  const { t, locale, fmt } = useI18n();
  const s = t.startBox.library;
  const path = useChannelPath();
  const { state, retry } = useTemplates(locale);
  const titleId = useId();

  let body: React.ReactNode;
  if (state.phase === "loading") {
    body = (
      <div aria-busy="true" data-testid="start-templates-loading">
        <p className="sr-only" role="status">
          {s.loading}
        </p>
        <ul className="sb-cards" aria-hidden>
          {[0, 1, 2].map((i) => (
            <li key={i} className="sb-card sb-card-skel" />
          ))}
        </ul>
      </div>
    );
  } else if (state.phase === "error") {
    body = (
      <div className="sb-state" role="alert" data-testid="start-templates-error">
        <p>{s.error}</p>
        <button type="button" className="sb-chip" onClick={retry} data-testid="start-templates-retry">
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
                  <button
                    type="button"
                    className="sb-card"
                    onClick={() => onPick(tpl)}
                    aria-label={fmt(s.use, { title: tpl.title })}
                    data-template={tpl.slug}
                  >
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
                      <span className="sb-card-meta">
                        {s.kind[tpl.kind]} · {tpl.aspect}
                      </span>
                    </span>
                  </button>
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
          <h2 id={titleId} className="sb-h2">
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
