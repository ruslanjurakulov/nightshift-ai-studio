"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { SegmentedSwitch } from "@/components/ui/SegmentedSwitch";
import { StateBlock } from "@/components/states/StateBlock";
import { DEFAULT_RANGE, MAX_VIDEOS, RANGE_DAYS, type RangeDays } from "@/lib/resultsDashboard/aggregate";
import type { ResultsPayload } from "@/lib/resultsDashboard/payload";
import { Freshness, HistoryList, KpiRow, PlatformCards, TopVideos, VideoTable, type VideoSort } from "@/components/results/ResultsParts";

type Load =
  | { status: "loading"; payload: ResultsPayload | null }
  | { status: "ready"; payload: ResultsPayload }
  | { status: "error"; payload: null };

/** The answer is trusted only when it has the shape this page draws; anything else is an error, not an empty dashboard. */
export function isPayload(v: unknown): v is ResultsPayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return (
    Array.isArray(p.channels) &&
    Array.isArray(p.videos) &&
    Array.isArray(p.history) &&
    Array.isArray(p.platforms) &&
    typeof p.kpis === "object" &&
    p.kpis !== null &&
    typeof p.freshness === "object" &&
    p.freshness !== null &&
    typeof p.sources === "object" &&
    p.sources !== null
  );
}

/**
 * The per-user results dashboard (NIGHTSHIFT_RESULTS_DASHBOARD, default off).
 *
 * One read, /api/results, repeated when the channel or the period changes. The page only draws what the server already
 * stored: it never calls a platform and has no control that publishes, spends or writes. While a new answer loads the old
 * one stays on screen, marked busy, so a switch never flashes an empty page; a failed read replaces the content with a
 * retry (an error is never drawn next to numbers that look current).
 */
export function ResultsDashboard({ initialChannel, videosHref, channelsHref }: { initialChannel: string; videosHref: string; channelsHref: string }) {
  const { t, fmt } = useI18n();
  const r = t.resultsDashboard;
  const ids = useId();
  const [channel, setChannel] = useState(initialChannel);
  const [days, setDays] = useState<RangeDays>(DEFAULT_RANGE);
  const [sort, setSort] = useState<VideoSort>("views");
  const [load, setLoad] = useState<Load>({ status: "loading", payload: null });
  const [attempt, setAttempt] = useState(0);
  const lastGood = useRef<ResultsPayload | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoad({ status: "loading", payload: lastGood.current });
    (async () => {
      try {
        const res = await fetch(`/api/results?channel=${encodeURIComponent(channel)}&range=${days}`, { signal: ctrl.signal, headers: { accept: "application/json" } });
        if (res.status === 404 && channel !== "all") {
          // The channel is not (or no longer) this workspace's: fall back to the whole workspace instead of an error.
          setChannel("all");
          return;
        }
        const body: unknown = await res.json().catch(() => null);
        if (!res.ok || !isPayload(body)) throw new Error("bad_answer");
        lastGood.current = body;
        setLoad({ status: "ready", payload: body });
      } catch (e) {
        if ((e as { name?: string }).name === "AbortError") return;
        setLoad({ status: "error", payload: null });
      }
    })();
    return () => ctrl.abort();
  }, [channel, days, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const payload = load.payload;
  const busy = load.status === "loading";
  const selected = payload?.channels.find((c) => c.id === payload.selected) ?? null;
  const rangeOptions = RANGE_DAYS.map((d) => ({ value: String(d), label: r.range[`d${d}` as "d7" | "d28" | "d90"] }));

  return (
    <div className="rd" aria-busy={busy}>
      <p className="rd-small">{r.firstVersion}</p>

      <div className="rd-controls">
        <label className="rd-field" htmlFor={`${ids}-channel`}>
          <span className="rd-label">{r.channelLabel}</span>
          <select id={`${ids}-channel`} className="ns-field" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={!payload && busy}>
            <option value="all">{r.allChannels}</option>
            {(payload?.channels ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.connected ? c.name : fmt(r.channelDisconnected, { name: c.name })}
              </option>
            ))}
            {/* The selected channel must stay a valid option before the first answer arrives. */}
            {!payload && channel !== "all" && <option value={channel}>{channel}</option>}
          </select>
        </label>
        <div className="rd-field">
          <span className="rd-label">{r.rangeLabel}</span>
          <SegmentedSwitch label={r.rangeLabel} options={rangeOptions} value={String(days)} onChange={(v) => setDays(Number(v) as RangeDays)} />
        </div>
        <p className="rd-small rd-hint" role="status">
          {busy && payload ? r.updating : fmt(r.rangeHint, { days })}
        </p>
      </div>

      {load.status === "error" && (
        <StateBlock
          tone="fail"
          role="alert"
          title={r.errorTitle}
          actions={
            <button type="button" className="btn-quiet" onClick={retry}>
              {r.retry}
            </button>
          }
        >
          {r.errorBody}
        </StateBlock>
      )}

      {load.status === "loading" && !payload && (
        <div className="rd-skeleton" role="status" aria-label={r.loading}>
          <span className="rd-sr">{r.loading}</span>
          <div className="rd-skel" />
          <div className="rd-skel" />
          <div className="rd-skel rd-skel-tall" />
        </div>
      )}

      {payload && (
        <div className="rd-content">
          <Content
            payload={payload}
            disconnected={selected !== null && !selected.connected}
            sort={sort}
            onSort={setSort}
            videosHref={videosHref}
            channelsHref={channelsHref}
          />
        </div>
      )}
    </div>
  );
}

function Content({
  payload,
  disconnected,
  sort,
  onSort,
  videosHref,
  channelsHref,
}: {
  payload: ResultsPayload;
  disconnected: boolean;
  sort: VideoSort;
  onSort: (s: VideoSort) => void;
  videosHref: string;
  channelsHref: string;
}) {
  const { t, fmt } = useI18n();
  const r = t.resultsDashboard;
  if (payload.channels.length === 0) {
    return (
      <StateBlock
        tone="idle"
        title={r.noChannelsTitle}
        actions={
          <Link href={channelsHref} className="btn-quiet">
            {r.openChannels}
          </Link>
        }
      >
        {r.noChannelsBody}
      </StateBlock>
    );
  }
  const none = payload.kpis.videos === 0;
  const unmeasured = payload.kpis.videos > 0 && payload.kpis.measured === 0;
  const scope = payload.selected === "all" ? r.scopeAll : (payload.channels.find((c) => c.id === payload.selected)?.name ?? payload.selected);
  return (
    <>
      {disconnected && <p className="rd-small" role="status">{r.disconnectedNote}</p>}
      <Freshness payload={payload} />
      {none ? (
        <StateBlock tone="idle" title={r.emptyTitle}>
          {fmt(r.emptyBody, { scope, days: payload.rangeDays })}
        </StateBlock>
      ) : (
        <>
          {unmeasured && (
            <StateBlock tone="idle" role="status" compact title={r.noReadingsTitle}>
              {r.noReadingsBody}
            </StateBlock>
          )}
          <KpiRow kpis={payload.kpis} />
          <TopVideos videos={payload.videos} />
          <VideoTable videos={payload.videos} sort={sort} onSort={onSort} videosHref={videosHref} />
          {payload.truncated.videos && <p className="rd-small">{fmt(r.videosTruncated, { max: MAX_VIDEOS })}</p>}
        </>
      )}
      <HistoryList entries={payload.history} truncated={payload.truncated.history} requests={payload.sources.requests} />
      <PlatformCards cards={payload.platforms} manageHref={channelsHref} />
    </>
  );
}
