"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import { useConfirm } from "@/components/feedback/ConfirmDialog";
import { useDayTime } from "@/components/usage/useDay";
import {
  approvalState,
  canPressApprove,
  knownApproveReason,
  shortHash,
  studioUrl,
  type ApproveAccess,
} from "@/lib/videoApproval";
import {
  knownRetryError,
  knownVisibilityReason,
  visibilityView,
  type VisibilityRequestRow,
} from "@/lib/visibilityRequest";
import { heldBeforeRender, heldFlagged, type EvidenceInfo } from "@/lib/heldVideos";
import type { ReviewIntentRow, VideoRow } from "@/lib/types";

/**
 * Watch the video, read what it is going out as, then decide.
 *
 * Three things this deliberately does NOT do:
 *
 * 1. **It never publishes.** Approving calls the database function `approve_video_publish` (migration 0112), which
 *    RECORDS who approved which exact cut (its checksum), until when (24 hours) and with what acknowledgement. Every
 *    video is uploaded as private and stays private until a person makes it public on YouTube (unless the channel's auto-publish
 *    switch is on); nothing in a browser can take a video public, re-render one, or spend a token. On a channel whose
 *    administrators ALSO switched "publish when approved" on (migration 0116, default off), approving queues one request that a
 *    worker carries out, and the panel then says what the database recorded: queued, refused with the reason in words, expired,
 *    or published, and "published" only for a request whose read-back said public (lib/visibilityRequest.ts). The button then
 *    reads "Approve and publish"; on every other channel it reads "Approve" and says it does not make the video public.
 * 2. **It never claims a verdict it was not given.** The gate line below the player is the verdict the pipeline stored
 *    with the cut (`videos.gate_verdict`), else the recorded gate event, else the held run's own. When none exists the
 *    panel says so rather than implying the video passed, and the video cannot be approved.
 * 3. **It does not file the two re-render requests.** "Render it again" and "New script, new video" spend credits and no
 *    run reads them yet, so they are shown as unavailable and write nothing.
 *
 * The preview plays from a private bucket through a signed URL minted here and good for an hour. The path is never
 * rendered as a link, and the bucket is not public, so the video is reachable only by someone already signed in.
 */
export function ReviewPanel({
  video,
  autoPublish,
  gate,
  staleRequest,
  access,
  channelName,
  publishOnApprove = false,
  request = null,
  evidence = null,
}: {
  video: VideoRow;
  autoPublish: boolean;
  /** The recorded gate decision, or null when none was recorded. */
  gate: { allowed: boolean; reasons: string[]; flagged: number | null } | null;
  /** The newest request of the old buttons that nothing ever carried out (shown as superseded), or null. */
  staleRequest: ReviewIntentRow | null;
  /** Whether this person may approve here (lib/videoApproval.approveAccess); the database decides again. */
  access: ApproveAccess;
  channelName?: string;
  /** The channel's "publish when approved" switch (migration 0116). False when it is off, and when 0116 is not applied. */
  publishOnApprove?: boolean;
  /** This video's newest publish-when-approved request (migration 0116), or null. */
  request?: VisibilityRequestRow | null;
  /** What the online source check did (hold_detail.grounding or the gate event), or null when nothing was recorded. */
  evidence?: EvidenceInfo | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const dayTime = useDayTime();
  const [src, setSrc] = useState<string | null>(null);
  const [srcError, setSrcError] = useState(false);
  const [showScript, setShowScript] = useState(false);
  const { confirm, dialog } = useConfirm();
  // Locked synchronously while a sheet is open: a second tap must not open a second sheet.
  const asking = useRef(false);

  // A signed URL, minted on the client with the anon key against the storage
  // read policy. It expires in an hour; nothing durable is handed out.
  useEffect(() => {
    if (!video.preview_path) return;
    let alive = true;
    const supabase = createClient();
    if (!supabase) return;
    supabase.storage
      .from("previews")
      .createSignedUrl(video.preview_path, 3600)
      .then(({ data, error: e }) => {
        if (!alive) return;
        if (e || !data?.signedUrl) setSrcError(true);
        else setSrc(data.signedUrl);
      });
    return () => {
      alive = false;
    };
  }, [video.preview_path]);

  // The clock ticks, so a panel left open flips from approved to expired by itself (the approval ends while someone reads).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);
  const state = approvalState(video, { autoPublish, access, nowMs });
  const pressable = canPressApprove(state);
  const studio = studioUrl(video.video_id);
  // The label says "publish" ONLY on a channel whose switch is on; everywhere else it records a decision and says so.
  const publishing = publishOnApprove && !autoPublish;
  // A request that exists is shown whatever the switch says now (turned off since: it reads "not published, switched off").
  const vis = visibilityView(request, video, nowMs);
  const publishCopy = publishing || vis.kind !== "none";
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  // While a request waits for the worker the page asks again, so "queued" does not outlive the answer.
  const waiting = vis.kind === "queued";
  useEffect(() => {
    if (!waiting) return;
    const id = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(id);
  }, [waiting, router]);

  /** "Try again" on a failed request: the database re-queues it only for the same approval, while it holds. */
  async function retry() {
    if (retrying || !request) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const supabase = createClient();
      if (!supabase) {
        setRetryError(t.review.visibility.retryErrors.failed);
        return;
      }
      const { data, error: e } = await supabase.rpc("retry_video_visibility", { p_request_id: request.id });
      if (e) {
        setRetryError(
          e.code === "42501"
            ? t.review.visibility.retryErrors.forbidden
            : e.code === "P0002"
              ? t.review.visibility.retryErrors.not_found
              : t.review.visibility.retryErrors.failed,
        );
        return;
      }
      const out = (data ?? null) as { ok?: unknown; error?: unknown } | null;
      if (!out || out.ok !== true) {
        const word = knownRetryError(out?.error);
        setRetryError(word ? t.review.visibility.retryErrors[word] : t.review.visibility.retryErrors.failed);
        return;
      }
      router.refresh();
    } finally {
      setRetrying(false);
    }
  }

  /** What the sheet was about, as a comparable string: a different gate verdict or cut is a different question. */
  const gateKey = gate ? `${gate.allowed}:${gate.flagged}:${gate.reasons.join("|")}` : "none";
  const questionKey = `${video.cut_sha256 ?? ""}|${gateKey}`;
  // The newest props, read after the person has answered: the sheet may have been open while the page refreshed.
  const latest = useRef({ pressable, questionKey });
  latest.current = { pressable, questionKey };

  /** The words for a refusal: a closed set from the database, anything else is a generic failure. */
  function reasonText(raw: unknown): string {
    const word = knownApproveReason(raw);
    return word ? t.review.reasons[word] : t.review.reasons.failed;
  }

  /**
   * Approve asks first, in words: what is recorded, that it does not publish, the exact version, the gate verdict, and a
   * tick that rights and AI-content labels were checked. The function is called from the sheet itself, so a refusal is
   * shown in the sheet. If what the sheet showed (still approvable, the same version and gate verdict) is no longer true
   * when it is answered, nothing is sent: the database would decide anyway, but the person agreed to a different question.
   */
  async function ask() {
    if (asking.current || !pressable || !video.cut_sha256) return;
    asking.current = true;
    try {
      const cs = t.confirmSheets;
      const name = video.title ?? video.video_id;
      const privacy = video.privacy
        ? (t.review.privacyValue as Record<string, string>)[video.privacy] ?? video.privacy
        : t.common.dash;
      // "No gate decision was recorded" is said as unknown, never as a pass.
      const gateLine = gate ? (gate.allowed ? t.review.gatePassed : t.review.gateBlocked) : t.review.gateUnknown;
      const shownQuestion = questionKey;
      const cut = video.cut_sha256;
      const ok = await confirm({
        title: fmt(cs.rvApproveTitle, { title: name }),
        message: publishing ? cs.rvApprovePublishBody : cs.rvApproveBody,
        confirmLabel: publishing ? t.review.approvePublish : t.review.approve,
        tone: "primary",
        acknowledge: cs.rvApproveAck,
        details: [
          { label: cs.dVideo, value: name },
          { label: cs.dChannel, value: channelName || video.channel_id },
          { label: cs.dVersion, value: shortHash(cut) },
          { label: t.review.privacy, value: privacy },
          { label: t.review.gate, value: gateLine, multiline: true },
          ...(publishing ? [{ label: cs.dEffect, value: cs.rvApprovePublishEffect }] : []),
        ],
        run: async () => {
          if (!latest.current.pressable || latest.current.questionKey !== shownQuestion) return cs.staleSheet;
          const supabase = createClient();
          if (!supabase) return t.review.reasons.failed;
          const { data, error: e } = await supabase.rpc("approve_video_publish", {
            p_video_id: video.video_id,
            p_cut_sha256: cut,
            p_ack: { rights_and_labels: true },
          });
          if (e) {
            // 42501 = not allowed (role, or a platform admin on a customer's channel), P0002 = not visible to this person.
            if (e.code === "42501") return t.review.reasons.forbidden;
            if (e.code === "P0002") return t.review.reasons.not_found;
            return t.review.reasons.failed;
          }
          const out = (data ?? null) as { ok?: unknown; error?: unknown } | null;
          if (!out || out.ok !== true) return reasonText(out?.error);
          return true;
        },
      });
      if (ok) router.refresh();
    } finally {
      asking.current = false;
    }
  }

  const flaggedTexts = heldFlagged(video);
  const decided = state.view.kind === "approved" || state.view.kind === "expired" ? state.view : null;
  const who = decided?.by ?? null;
  const at = decided ? dayTime(decided.at) : "";
  const until = state.view.kind === "approved" ? dayTime(state.view.expiresAt) : "";

  return (
    <section className="section-card flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="stack min-w-0">
          <div className="t-label">{t.review.title}</div>
          <h2 className="mt-3 max-w-[26ch] text-[22px] font-semibold leading-tight">
            {video.title ?? video.video_id}
          </h2>
        </div>
        <span
          className="pill shrink-0 border px-4 py-2 text-xs"
          style={{
            borderColor: autoPublish ? "var(--color-warn)" : "var(--color-border)",
            color: autoPublish ? "var(--color-warn)" : "var(--color-muted)",
          }}
        >
          {autoPublish ? t.review.autoOn : t.review.autoOff}
        </span>
      </div>

      {/* ── the video ──────────────────────────────────────────────────── */}
      {video.preview_path && src ? (
        <video
          src={src}
          controls
          playsInline
          preload="metadata"
          className="w-full rounded-[18px] border border-[var(--color-border)] bg-black"
        />
      ) : (
        <div className="rounded-[18px] border border-dashed border-[var(--color-border)] p-8 text-center">
          <p className="text-sm text-[var(--color-muted)]">
            {srcError
              ? t.review.previewUnreadable
              : video.preview_path
                ? t.review.previewLoading
                : heldBeforeRender(video)
                  ? t.review.previewBeforeRender
                  : t.review.previewMissing}
          </p>
        </div>
      )}

      {/* ── what it is going out as ────────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="stack gap-2">
          <div className="t-label">{t.review.uploadTitle}</div>
          <p className="m-0 text-[15px] leading-snug">{video.title ?? t.common.dash}</p>
        </div>
        <div className="stack gap-2">
          <div className="t-label">{t.review.privacy}</div>
          <p className="tnum m-0 text-[15px]">
            {/* YouTube's own value, in the reader's language when it is one of the three. */}
            {video.privacy
              ? (t.review.privacyValue as Record<string, string>)[video.privacy] ?? video.privacy
              : t.common.dash}
          </p>
        </div>
      </div>

      {/* ── the gate, in its own words ─────────────────────────────────── */}
      <div
        className="rounded-[16px] border p-4"
        style={{
          borderColor: gate
            ? gate.allowed
              ? "color-mix(in srgb, var(--color-ok) 35%, transparent)"
              : "color-mix(in srgb, var(--color-fail) 40%, transparent)"
            : "var(--color-border)",
        }}
      >
        <div className="t-label">{t.review.gate}</div>
        {gate ? (
          <>
            <p
              className="mt-2 text-sm font-medium"
              style={{ color: gate.allowed ? "var(--color-ok)" : "var(--color-fail)" }}
            >
              {gate.allowed ? t.review.gatePassed : t.review.gateBlocked}
            </p>
            {gate.flagged !== null && (
              <p className="mt-1 text-sm text-[var(--color-muted)]">
                {fmt(t.review.gateFlagged, { n: gate.flagged })}
              </p>
            )}
            {gate.reasons.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {gate.reasons.map((r) => (
                  <li key={r} className="text-sm text-[var(--color-muted)]">
                    — {r}
                  </li>
                ))}
              </ul>
            )}
            {flaggedTexts.length > 0 && (
              <div data-testid="flagged-texts" className="mt-3">
                <div className="t-label">{t.review.flaggedHeading}</div>
                <ul className="mt-2 flex flex-col gap-2">
                  {flaggedTexts.map((f, i) => (
                    <li key={i} className="text-sm">
                      <span className="text-[var(--color-muted)]">
                        {t.review.flaggedSources[f.source]} · {t.review.flaggedVerdicts[f.verdict]}
                      </span>
                      <p className="m-0 mt-1">{f.text}</p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <p className="mt-2 text-sm text-[var(--color-muted)]">{t.review.gateUnknown}</p>
        )}
      </div>

      {/* ── the sources the accuracy check found online ───────────────── */}
      {evidence && (
        <div data-testid="evidence-sources" className="rounded-[16px] border border-[var(--color-border)] p-4">
          <div className="t-label">{t.review.sourcesHeading}</div>
          {evidence.enabled === false ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">{t.review.sourcesOff}</p>
          ) : evidence.unavailable ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              {fmt(t.review.sourcesUnavailable, { reason: evidence.unavailable })}
            </p>
          ) : evidence.sources.length === 0 ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">{t.review.sourcesNone}</p>
          ) : (
            <>
              <ul className="mt-2 flex flex-col gap-1">
                {evidence.sources.map((s) => (
                  <li key={s.url} className="text-sm">
                    {/* The link is checked to be an en.wikipedia.org page in parseEvidence; the title is text. */}
                    <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                      {s.title}
                    </a>
                    <span className="text-[var(--color-muted)]"> · {fmt(t.review.sourcesClaims, { n: s.claims })}</span>
                  </li>
                ))}
              </ul>
              {evidence.cleared.length > 0 && (
                <ul data-testid="evidence-cleared" className="mt-3 flex flex-col gap-2">
                  {evidence.cleared.map((c) => (
                    <li key={`${c.claimId}|${c.url}`} className="text-sm">
                      <span className="text-[var(--color-muted)]">
                        {t.review.sourcesCleared} {c.claimId} ·{" "}
                      </span>
                      <a href={c.url} target="_blank" rel="noopener noreferrer nofollow" className="underline">
                        {c.title}
                      </a>
                      <p className="m-0 mt-1 text-[var(--color-muted)]">{`\u201C${c.quote}\u201D`}</p>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-[var(--color-muted)]">{t.review.sourcesNote}</p>
            </>
          )}
        </div>
      )}

      {/* ── the script it was built from ───────────────────────────────── */}
      <div className="stack gap-3">
        <button
          type="button"
          onClick={() => setShowScript((v) => !v)}
          className="btn-sky is-quiet pill self-start px-5 py-2.5 text-sm"
          aria-expanded={showScript}
        >
          {showScript ? t.review.hideScript : t.review.showScript}
        </button>
        {showScript && (
          <div className="max-h-[420px] overflow-y-auto rounded-[16px] border border-[var(--color-border)] bg-[var(--color-panel-2)] p-5">
            {video.script_text ? (
              <p className="m-0 whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-fg)]">
                {video.script_text}
              </p>
            ) : (
              <p className="m-0 text-sm text-[var(--color-muted)]">{t.review.scriptMissing}</p>
            )}
          </div>
        )}
      </div>

      {/* An old request of the dead buttons: shown as what it is, and it blocks nothing. */}
      {staleRequest && (
        <p data-testid="stale-request" className="m-0 text-sm text-[var(--color-muted)]">
          {staleRequest.action === "approve" ? t.review.staleApprove : t.review.staleRender}
        </p>
      )}

      {/* ── what was decided ───────────────────────────────────────────── */}
      {state.view.kind === "approved" && (
        <div
          data-testid="approved"
          className="stack gap-2 rounded-[16px] border p-4"
          style={{ borderColor: "color-mix(in srgb, var(--color-ok) 35%, transparent)" }}
        >
          <p className="m-0 text-sm font-medium text-[var(--color-ok)]">
            {publishCopy
              ? who
                ? fmt(t.review.approvedByPublish, { who, when: at })
                : fmt(t.review.approvedAnonPublish, { when: at })
              : who
                ? fmt(t.review.approvedBy, { who, when: at })
                : fmt(t.review.approvedAnon, { when: at })}
          </p>
          <p className="m-0 text-sm text-[var(--color-muted)]">{fmt(t.review.approvedHolds, { until })}</p>
          {publishCopy ? (
            vis.kind !== "published" &&
            vis.kind !== "queued" && <p className="m-0 text-sm text-[var(--color-fg)]">{t.review.makePublicFallbackBody}</p>
          ) : (
            <>
              <div className="t-label mt-2">{t.review.makePublicTitle}</div>
              <p className="m-0 text-sm text-[var(--color-fg)]">{t.review.makePublicBody}</p>
            </>
          )}
          {studio && (
            <a
              href={studio}
              target="_blank"
              rel="noopener noreferrer"
              className="tap-link text-sm text-[var(--color-primary)] hover:underline"
            >
              {t.review.studioLink}
            </a>
          )}
        </div>
      )}
      {state.view.kind === "expired" && (
        <p data-testid="expired" className="m-0 text-sm text-[var(--color-warn)]">
          {publishCopy
            ? who
              ? fmt(t.review.expiredByPublish, { who, when: at })
              : fmt(t.review.expiredAnonPublish, { when: at })
            : who
              ? fmt(t.review.expiredBy, { who, when: at })
              : fmt(t.review.expiredAnon, { when: at })}
        </p>
      )}

      {/* ── what happened to the request (only on a channel whose switch is on) ───────────────────────── */}
      {vis.kind !== "none" && (
        <div
          data-testid="visibility"
          data-state={vis.kind}
          className="stack gap-2 rounded-[16px] border p-4"
          style={{
            borderColor:
              vis.kind === "published"
                ? "color-mix(in srgb, var(--color-ok) 35%, transparent)"
                : vis.kind === "queued"
                  ? "var(--color-border)"
                  : "color-mix(in srgb, var(--color-warn) 40%, transparent)",
          }}
        >
          <div className="t-label">{t.review.visibility.title}</div>
          {vis.kind === "queued" && (
            <>
              <p className="m-0 text-sm text-[var(--color-fg)]">{fmt(t.review.visibility.queued, { when: dayTime(vis.since) })}</p>
              {vis.lastReason && (
                <p className="m-0 text-sm text-[var(--color-muted)]">
                  {fmt(t.review.visibility.queuedLast, { reason: t.review.visibility.reasons[vis.lastReason] })}
                </p>
              )}
              <p className="m-0 text-sm text-[var(--color-muted)]">{t.review.visibility.queuedHint}</p>
            </>
          )}
          {vis.kind === "published" && (
            <p className="m-0 text-sm font-medium text-[var(--color-ok)]">
              {vis.at ? fmt(t.review.visibility.published, { when: dayTime(vis.at) }) : t.review.visibility.publishedNoTime}
            </p>
          )}
          {vis.kind === "refused" && (
            <p className="m-0 text-sm text-[var(--color-fg)]">
              {fmt(t.review.visibility.refused, {
                reason: t.review.visibility.reasons[knownVisibilityReason(vis.reason) ?? "worker_error"],
              })}
            </p>
          )}
          {vis.kind === "failed" && (
            <>
              <p className="m-0 text-sm text-[var(--color-fg)]">
                {fmt(t.review.visibility.failed, {
                  reason: t.review.visibility.reasons[knownVisibilityReason(vis.reason) ?? "worker_error"],
                })}
              </p>
              {access === "ok" && vis.retryable && request && (
                <div className="stack gap-2">
                  <p className="m-0 text-xs text-[var(--color-muted)]">{t.review.visibility.failedHint}</p>
                  <button
                    type="button"
                    disabled={retrying}
                    onClick={() => void retry()}
                    className="btn-sky is-quiet pill self-start px-5 py-2.5 text-sm disabled:opacity-40"
                  >
                    {retrying ? t.review.visibility.retrying : t.review.visibility.tryAgain}
                  </button>
                  {retryError && (
                    <p role="alert" data-testid="retry-error" className="m-0 text-xs text-[var(--color-fail)]">
                      {retryError}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
          {vis.kind === "expired" && <p className="m-0 text-sm text-[var(--color-warn)]">{t.review.visibility.expired}</p>}
        </div>
      )}

      {/* ── the decision ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start gap-3 border-t border-[var(--color-border)] pt-5">
        {state.view.kind !== "approved" && (
          <div className="stack max-w-[46ch] gap-2">
            <button
              type="button"
              disabled={!pressable}
              onClick={() => void ask()}
              aria-describedby="review-approve-note"
              className="btn-sky is-solid pill px-[30px] py-3.5 text-sm disabled:opacity-40"
            >
              {publishing ? t.review.approvePublish : t.review.approve}
            </button>
            <span id="review-approve-note" data-testid="approve-note" className="text-xs leading-relaxed text-[var(--color-muted)]">
              {state.view.kind === "auto"
                ? t.review.autoHint
                : state.blocker
                  ? t.review.blocker[state.blocker]
                  : publishing
                    ? t.review.queueHintPublish
                    : t.review.queueHint}
            </span>
          </div>
        )}
        {/* The two re-render requests spend credits and nothing reads them yet: shown, never filed. */}
        <div className="stack max-w-[30ch] gap-2">
          <button
            type="button"
            disabled
            aria-describedby="review-regenerate-note"
            className="btn-sky pill px-[30px] py-3.5 text-sm disabled:opacity-40"
          >
            {t.review.regenerate}
          </button>
          <span id="review-regenerate-note" className="text-xs leading-relaxed text-[var(--color-muted)]">
            {t.review.notAvailableYet}
          </span>
        </div>
        <div className="stack max-w-[30ch] gap-2">
          <button
            type="button"
            disabled
            aria-describedby="review-script-note"
            className="btn-sky pill px-[30px] py-3.5 text-sm disabled:opacity-40"
          >
            {t.review.regenerateScript}
          </button>
          <span id="review-script-note" className="text-xs leading-relaxed text-[var(--color-muted)]">
            {t.review.notAvailableYet}
          </span>
        </div>
      </div>
      {dialog}
    </section>
  );
}
