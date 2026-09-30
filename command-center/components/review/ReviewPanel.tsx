"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useI18n } from "@/lib/i18n/context";
import { fmt } from "@/lib/i18n";
import type { ReviewIntentRow, VideoRow } from "@/lib/types";

/**
 * Watch the video, read what it is going out as, then decide.
 *
 * Two things this deliberately does NOT do:
 *
 * 1. **It never publishes.** A button writes a row to `review_intents` and
 *    stops. The next pipeline run reads that row and acts. Nothing in a
 *    browser can take a video public, re-render one, or spend a token —
 *    approving is a request, and the request is the record of who asked.
 * 2. **It never claims a verdict it was not given.** The gate line below the
 *    player is built from the recorded gate event. When no gate event exists
 *    the panel says so rather than implying the video passed.
 *
 * The preview plays from a private bucket through a signed URL minted here and
 * good for an hour. The path is never rendered as a link, and the bucket is not
 * public, so the video is reachable only by someone already signed in.
 */
export function ReviewPanel({
  video,
  autoPublish,
  gate,
  pendingIntent,
}: {
  video: VideoRow;
  autoPublish: boolean;
  /** The recorded gate decision, or null when none was recorded. */
  gate: { allowed: boolean; reasons: string[]; flagged: number | null } | null;
  pendingIntent: ReviewIntentRow | null;
}) {
  const { t } = useI18n();
  const router = useRouter();
  const [src, setSrc] = useState<string | null>(null);
  const [srcError, setSrcError] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [filed, setFiled] = useState<string | null>(pendingIntent?.action ?? null);
  const [error, setError] = useState<string | null>(null);
  const [showScript, setShowScript] = useState(false);

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

  async function file(action: ReviewIntentRow["action"]) {
    const supabase = createClient();
    if (!supabase) return;
    setBusy(action);
    setError(null);
    const { error: e } = await supabase.from("review_intents").insert({
      channel_id: video.channel_id,
      video_id: video.video_id,
      action,
    });
    setBusy(null);
    if (e) {
      setError(e.message);
      return;
    }
    setFiled(action);
    router.refresh();
  }

  const waiting = video.review_state === "pending" && !autoPublish;

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
          className="pill shrink-0 border px-4 py-2 text-[12px]"
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
          <p className="text-[13px] text-[var(--color-muted)]">
            {srcError
              ? t.review.previewUnreadable
              : video.preview_path
                ? t.review.previewLoading
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
          <p className="mono m-0 text-[15px]">{video.privacy ?? t.common.dash}</p>
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
              className="mt-2 text-[14px] font-medium"
              style={{ color: gate.allowed ? "var(--color-ok)" : "var(--color-fail)" }}
            >
              {gate.allowed ? t.review.gatePassed : t.review.gateBlocked}
            </p>
            {gate.flagged !== null && (
              <p className="mt-1 text-[13px] text-[var(--color-muted)]">
                {fmt(t.review.gateFlagged, { n: gate.flagged })}
              </p>
            )}
            {gate.reasons.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1">
                {gate.reasons.map((r) => (
                  <li key={r} className="text-[13px] text-[var(--color-muted)]">
                    — {r}
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className="mt-2 text-[13px] text-[var(--color-muted)]">{t.review.gateUnknown}</p>
        )}
      </div>

      {/* ── the script it was built from ───────────────────────────────── */}
      <div className="stack gap-3">
        <button
          type="button"
          onClick={() => setShowScript((v) => !v)}
          className="btn-sky is-quiet pill self-start px-5 py-2.5 text-[13px]"
          aria-expanded={showScript}
        >
          {showScript ? t.review.hideScript : t.review.showScript}
        </button>
        {showScript && (
          <div className="max-h-[420px] overflow-y-auto rounded-[16px] border border-[var(--color-border)] bg-[var(--color-panel-2)] p-5">
            {video.script_text ? (
              <p className="m-0 whitespace-pre-wrap text-[14px] leading-relaxed text-[var(--color-fg)]">
                {video.script_text}
              </p>
            ) : (
              <p className="m-0 text-[13px] text-[var(--color-muted)]">{t.review.scriptMissing}</p>
            )}
          </div>
        )}
      </div>

      {error && <p className="mono text-[12px] text-[var(--color-fail)]">{error}</p>}

      {/* ── the decision ───────────────────────────────────────────────── */}
      {filed ? (
        <p className="text-[13px] text-[var(--color-ok)]">
          {fmt(t.review.filed, { action: t.review[filed as "approve"] ?? filed })}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-5">
          <button
            type="button"
            disabled={!waiting || busy !== null}
            onClick={() => file("approve")}
            className="btn-sky is-solid pill px-[30px] py-3.5 text-[14px] disabled:opacity-40"
          >
            {busy === "approve" ? t.review.filing : t.review.approve}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => file("regenerate")}
            className="btn-sky pill px-[30px] py-3.5 text-[14px] disabled:opacity-40"
          >
            {busy === "regenerate" ? t.review.filing : t.review.regenerate}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => file("regenerate_script")}
            className="btn-sky pill px-[30px] py-3.5 text-[14px] disabled:opacity-40"
          >
            {busy === "regenerate_script" ? t.review.filing : t.review.regenerateScript}
          </button>
          <span className="max-w-[46ch] text-[12px] leading-relaxed text-[var(--color-muted)]">
            {autoPublish ? t.review.autoHint : t.review.queueHint}
          </span>
        </div>
      )}
    </section>
  );
}
